import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runWorkflowGuest } from '../../../workflow/workflow-ptc/src/guest.ts'
import type { WorkflowGuestHost } from '../../../workflow/workflow-ptc/src/guest-types.ts'
import type { ChildResult, ChildStartRequest, WorkerInit } from '../../../workflow/workflow-ptc/src/types.ts'

const skill = readFileSync(join(import.meta.dirname, '../../../../fork/skills/dag-workflow/SKILL.md'), 'utf8')

/** The helper exactly as the agent reads it: the fenced block tagged `js dag-helper`. */
const helper = /```js dag-helper\n([\s\S]*?)```/.exec(skill)?.[1]

interface Started { prompt: string; finish: (result: ChildResult) => void }

/** Run a script body through the real workflow guest; child completion is the test's to decide. */
function run(body: string, childResult?: (request: ChildStartRequest, callId: number) => Promise<ChildResult>) {
  const requests: ChildStartRequest[] = []
  const init: WorkerInit = {
    meta: { name: 'dag-test', description: 'exercise the dag helper' },
    body: `${helper}\n${body}`,
    args: {},
    limits: { maxConcurrentAgents: 8, maxTotalAgents: 32, maxItemsPerCall: 32, syncTimeoutMs: 5000 },
  }
  const host: WorkflowGuestHost = {
    begin: async () => init,
    async startChild(request) {
      requests.push(request)
      return { callId: requests.length, childId: `child-${requests.length}` }
    },
    childResult: async ({ callId }) => childResult === undefined
      ? { output: [{ type: 'text', text: requests[callId - 1]!.prompt }], stopReason: 'completed' }
      : await childResult(requests[callId - 1]!, callId),
    async disposeChild() { return null },
    async progress() { return null },
  }
  return { result: runWorkflowGuest(host), requests }
}

const done = (text: string): ChildResult => ({ output: [{ type: 'text', text }], stopReason: 'completed' })

describe('dag-workflow skill', () => {
  it('ships a helper block and a description the skill catalog can show', () => {
    expect(helper).toBeDefined()
    const front = parse(/^---\n([\s\S]*?)\n---/.exec(skill)![1]!) as { name: string; description: string }
    expect(front.name).toBe('dag-workflow')
    expect(front.description).toContain('workflow')
  })

  it('passes each node the results it depends on and returns every node by id', async () => {
    const { result } = run(`return await dag({
      a: { run: () => agent('A') },
      b: { needs: ['a'], run: ({ a }) => agent(a + 'B') },
      c: { needs: ['a'], run: ({ a }) => agent(a + 'C') },
      d: { needs: ['b', 'c'], run: ({ b, c }) => agent(b + '+' + c) },
    })`)
    await expect(result).resolves.toMatchObject({
      stopReason: 'completed',
      value: { a: 'A', b: 'AB', c: 'AC', d: 'AB+AC' },
      agentsStarted: 4,
    })
  })

  it('runs ready siblings together and holds a node until its dependencies finish', async () => {
    const started: Started[] = []
    const seen: string[] = []
    let release!: () => void
    const bothRunning = new Promise<void>((resolve) => { release = resolve })
    const { result } = run(`return await dag({
      a: { run: () => agent('a') },
      b: { run: () => agent('b') },
      c: { needs: ['a', 'b'], run: () => agent('c') },
    })`, async (request) => {
      seen.push(request.prompt)
      if (request.prompt === 'c') return done('c')
      return await new Promise<ChildResult>((finish) => {
        started.push({ prompt: request.prompt, finish })
        if (started.length === 2) release()
      })
    })
    await bothRunning
    expect(seen.toSorted()).toEqual(['a', 'b'])
    for (const child of started) child.finish(done(child.prompt))
    await expect(result).resolves.toMatchObject({ value: { a: 'a', b: 'b', c: 'c' } })
    expect(seen.at(-1)).toBe('c')
  })

  it('skips a node whose hard dependency failed but keeps unrelated branches', async () => {
    const { result, requests } = run(`return await dag({
      bad: { run: () => agent('bad') },
      fine: { run: () => agent('fine') },
      child: { needs: ['bad'], run: () => agent('child') },
      grandchild: { needs: ['child'], run: () => agent('grandchild') },
      other: { needs: ['fine'], run: () => agent('other') },
    })`, async request => request.prompt === 'bad'
      ? { output: [], stopReason: 'error', error: 'boom' }
      : done(request.prompt))
    await expect(result).resolves.toMatchObject({
      stopReason: 'completed',
      value: { bad: null, fine: 'fine', child: null, grandchild: null, other: 'other' },
    })
    expect(requests.map(request => request.prompt)).not.toContain('child')
    expect(requests.map(request => request.prompt)).not.toContain('grandchild')
  })

  it('runs a node after a failed soft dependency and hands it null', async () => {
    const { result } = run(`return await dag({
      flaky: { run: () => { throw new Error('flaky') } },
      report: { after: ['flaky'], run: ({ flaky }) => agent(flaky === null ? 'without flaky' : 'with flaky') },
    })`)
    await expect(result).resolves.toMatchObject({ value: { flaky: null, report: 'without flaky' } })
  })

  it('lets a node decide at run time how much work to fan out', async () => {
    const { result } = run(`return await dag({
      list: { run: () => ['x', 'y', 'z'] },
      work: { needs: ['list'], run: ({ list }) => parallel(list.map(item => () => agent(item))) },
    })`)
    await expect(result).resolves.toMatchObject({ value: { work: ['x', 'y', 'z'] }, agentsStarted: 3 })
  })

  it.each([
    ['a cycle', '{ a: { needs: [\'b\'], run() {} }, b: { after: [\'a\'], run() {} } }', 'cycle'],
    ['a self edge', '{ a: { needs: [\'a\'], run() {} } }', 'cycle'],
    ['an unknown dependency', '{ a: { needs: [\'nope\'], run() {} } }', 'nope'],
    ['a node without run', '{ a: { needs: [] } }', 'run'],
  ])('rejects %s before any agent starts', async (_name, nodes, message) => {
    const { result, requests } = run(`return await dag(${nodes})`)
    const settled = await result
    expect(settled.stopReason).toBe('error')
    expect(JSON.stringify(settled)).toContain(message)
    expect(requests).toEqual([])
  })

  it('ends the script on a misused hook instead of dissolving it into null', async () => {
    const { result } = run(`return await dag({
      misuse: { run: () => agent('x', { nonsense: true }) },
      later: { needs: ['misuse'], run: () => agent('later') },
    })`)
    await expect(result).resolves.toMatchObject({ stopReason: 'error' })
  })
})
