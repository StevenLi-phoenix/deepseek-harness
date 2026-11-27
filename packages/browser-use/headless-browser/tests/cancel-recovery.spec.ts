/** A cancelled DSH turn leaves its live form available to a new Session through the real Loader and agent loop. */

import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { chromium } from 'playwright-core'
import { expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const FORM_PATH = '/draft-form'
const FORM_TITLE = 'Draft form'
const DRAFT = 'unsent example draft'
const FORM_HTML = `<!doctype html><title>${FORM_TITLE}</title>
<form autocomplete="off">
  <label for="draft">Draft phrase</label><input id="draft" type="text">
  <button id="show" type="button">Show draft</button>
</form>
<p id="observed">Waiting</p>
<script>
  document.querySelector('#show').addEventListener('click', () => {
    document.querySelector('#observed').textContent = document.querySelector('#draft').value;
  });
</script>`

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toolJson(agent: Agent, callId: string): Record<string, unknown> {
  const event = agent.session.snapshotEvents().find(entry =>
    entry.type === 'tool/result' && entry.data.message.toolCallId === callId)
  if (event?.type !== 'tool/result') throw new Error(`no result for ${callId}`)
  const { message } = event.data
  const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
  if (message.isError) throw new Error(`${callId} failed in the tool executor: ${text}`)
  const result: unknown = JSON.parse(text)
  if (!isRecord(result)) throw new Error(`expected an object result for ${callId}`)
  return result
}

function tabId(result: Record<string, unknown>): string {
  const id = result['tab']
  if (typeof id !== 'string') throw new Error(`expected an opened tab ID, got ${JSON.stringify(result)}`)
  return id
}

function tabRow(result: unknown, id: string): Record<string, unknown> {
  if (!isRecord(result) || !Array.isArray(result['tabs'])) throw new Error('expected a tab list')
  const rows: unknown[] = result['tabs']
  for (const row of rows) {
    if (isRecord(row) && row['id'] === id) return row
  }
  throw new Error(`tab ${id} is missing from the list`)
}

function endings(agent: Agent) {
  return agent.session.snapshotEvents().flatMap(event => event.type === 'turn/end' ? [event.data.reason] : [])
}

it.skipIf(!existsSync(chromium.executablePath()))('resumes the same unsubmitted form from a fresh Session after the opening turn is cancelled', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-cancel-'))
  const home = join(root, 'home')
  vi.stubEnv('DSH_HOME', home)
  const ctx = new Context()
  let formLoads = 0
  await using server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === FORM_PATH) {
      formLoads++
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(FORM_HTML)
    } else if (request.method === 'GET' && request.url === '/spare') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Spare tab</title>')
    } else {
      response.writeHead(404).end()
    }
  })
  try {
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture HTTP server did not bind a port')
    const origin = `http://127.0.0.1:${String(address.port)}`
    const formUrl = `${origin}${FORM_PATH}`
    const spareUrl = `${origin}/spare`

    // Import after stubbing DSH_HOME: the config captures default storage paths when loaded.
    const browserModule = await import('../src/index.ts')
    expect('default' in browserModule).toBe(false)
    const script: (StreamChunk[] | 'hang')[] = [
      toolCallResponse('open-form', 'headless_browser_open', { url: formUrl }),
      toolCallResponse('fill-form', 'headless_browser_type', { selector: '#draft', text: DRAFT }),
      toolCallResponse('open-spare', 'headless_browser_open', { url: spareUrl, newTab: true }),
      'hang',
    ]
    const adapter = new MockAdapter(script)
    let host: Context | undefined
    const agents = {
      name: 'fixture-agents',
      async apply(context: Context) {
        host = context
        await mountAgentLoopTestDependencies(context)
        await context.plugin(AgentLoop, { agents: [] })
        context.effect(() => context.get('llm')!.registerAdapter(['mock'], adapter))
      },
    }
    const modules = new Map<string, unknown>([
      ['fixture-agents', agents],
      ['@deepseek-ai/dsh-headless-browser', browserModule],
    ])
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, `- name: fixture-agents
- name: '@deepseek-ai/dsh-headless-browser'
`)
    ctx.baseUrl = `${pathToFileURL(root).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    Reflect.set(ctx.loader, 'internal', {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    })
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])

    const agentOptions = { provider: 'mock', model: 'mock' }
    const registry = host?.get('agents')
    if (registry === undefined) throw new Error('fixture Agent registry did not mount')
    const opening = await registry.create({ sessionId: SessionId('browser-form-opener'), agentOptions })
    const opener = opening.agent
    const stop = ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (agent === opener && adapter.requests.length === 4 && frame.type === 'chunk' && frame.chunk.type === 'text-delta') {
        opener.cancel({ kind: 'user' })
      }
    })
    send(opener, 'Prepare a draft without submitting it.')
    await opener.whenIdle()
    stop()
    expect(endings(opener)).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
    const firstTab = tabId(toolJson(opener, 'open-form'))
    const spareTab = tabId(toolJson(opener, 'open-spare'))
    expect(spareTab).not.toBe(firstTab)
    const fill = toolJson(opener, 'fill-form')
    expect(fill['url']).toBe(formUrl)
    expect(typeof fill['typed']).toBe('string')
    expect(formLoads).toBe(1)
    await opening.dispose()

    script.push(
      toolCallResponse('list-tabs', 'headless_browser_tabs', {}),
      toolCallResponse('missing-tab', 'headless_browser_resume', { tab: 'absent-tab' }),
      toolCallResponse('hand-over', 'headless_browser_hand_over', { reason: 'Inspect the draft' }),
      toolCallResponse('resume-while-held', 'headless_browser_resume', { urlSubstring: FORM_PATH }),
      toolCallResponse('hand-back', 'headless_browser_hand_back', {}),
      toolCallResponse('resume-form', 'headless_browser_resume', { urlSubstring: FORM_PATH }),
      toolCallResponse('show-draft', 'headless_browser_click', { selector: '#show' }),
      toolCallResponse('read-draft', 'headless_browser_read', { selector: '#observed' }),
      textResponse('Read the existing draft.'),
    )
    const { agent: recovery } = await registry.create({ sessionId: SessionId('browser-form-recovery'), agentOptions })
    expect(recovery.session.id).not.toBe(opener.session.id)
    send(recovery, 'Find the existing draft without reopening the page.')
    await recovery.whenIdle()
    expect(endings(recovery)).toEqual([{ kind: 'completed' }])
    const title = { untrusted: origin, content: FORM_TITLE }
    const listed = toolJson(recovery, 'list-tabs')
    const formTab = tabRow(listed, firstTab)
    expect(formTab).toMatchObject({ url: formUrl, title, active: false })
    expect(typeof formTab['openedAt']).toBe('string')
    expect(typeof formTab['lastNavigatedAt']).toBe('string')
    expect(tabRow(listed, spareTab)).toMatchObject({ url: spareUrl, active: true })
    expect(toolJson(recovery, 'missing-tab')['error']).toContain('no longer open')
    expect(toolJson(recovery, 'hand-over')).toMatchObject({ holder: 'human' })
    expect(toolJson(recovery, 'resume-while-held')['error']).toContain('the user holds the browser')
    expect(toolJson(recovery, 'hand-back')).toMatchObject({ holder: 'agent' })
    expect(toolJson(recovery, 'resume-form')).toEqual({ tab: firstTab, url: formUrl, title, hasForm: true })
    expect(toolJson(recovery, 'show-draft')['url']).toBe(formUrl)
    expect(toolJson(recovery, 'read-draft')).toMatchObject({ text: { untrusted: origin, content: DRAFT } })
    expect(formLoads).toBe(1)

    const ledger: unknown = JSON.parse(await readFile(join(home, 'data', 'headless-browser', 'tabs.json'), 'utf8'))
    expect(tabRow(ledger, firstTab)).toMatchObject({ openedBySessionId: opener.session.id, status: 'open' })
  } finally {
    try {
      await ctx.fiber.dispose()
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  }
})
