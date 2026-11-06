import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runWorkflowGuest } from '../../../workflow/workflow-ptc/src/guest.ts'
import type { WorkflowGuestHost } from '../../../workflow/workflow-ptc/src/guest-types.ts'
import type { ChildResult, ChildStartRequest, WorkerInit } from '../../../workflow/workflow-ptc/src/types.ts'

const skill = readFileSync(join(import.meta.dirname, '../../../../fork/skills/dag-workflow/SKILL.md'), 'utf8')

/** The example exactly as the agent reads it: the first fenced `js` block. */
const example = /```js\n([\s\S]*?)```/.exec(skill)?.[1]

/** Run a script body through the real workflow guest; child completion is the test's to decide. */
function run(body: string, childResult?: (request: ChildStartRequest, callId: number) => Promise<ChildResult>) {
  const requests: ChildStartRequest[] = []
  const init: WorkerInit = {
    meta: { name: 'skill-example', description: 'run the example of the skill' },
    body,
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

describe('skill dag-workflow', () => {
  it('names itself and limits itself to what the owner asks for', () => {
    const front = parse(/^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? '') as { name: string; description: string }
    expect(front.name).toBe('dag-workflow')
    expect(front.description).toContain('仅在主人明确要求')
  })

  it('offers no scheduler helper to paste', () => {
    expect(skill).not.toMatch(/function dag\(/u)
  })

  it('has an example that runs through the real workflow guest, in order and in parallel', async () => {
    expect(example).toBeDefined()
    const { result, requests } = run(example!, async (request) => {
      const text = request.prompt.startsWith('列出') ? 'a.ts\nb.ts' : `done: ${request.prompt.slice(0, 7)}`
      return { output: [{ type: 'text', text }], stopReason: 'completed' }
    })
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(requests[0]!.prompt).toContain('列出')
    expect(requests.filter(request => request.prompt.startsWith('检查 '))).toHaveLength(2)
    const last = requests.at(-1)!.prompt
    expect(last).toContain('汇总')
    expect(last).toContain('done: 检查 a.ts')
    expect(last).toContain('done: 总结这个仓库')
  })
})
