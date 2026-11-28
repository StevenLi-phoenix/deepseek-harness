import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import * as Browser from '@deepseek-ai/dsh-headless-browser'
import * as Persona from '@deepseek-ai/dsh-persona'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as TimeContext from '@deepseek-ai/dsh-time-context'
import * as Gmail from '@deepseek-ai/dsh-tool-gmail'
import * as SubagentTool from '@deepseek-ai/dsh-tool-subagent'
import * as SubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import * as Web from '@deepseek-ai/dsh-tool-web'
import * as WeChat from '@deepseek-ai/dsh-tool-wechat'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { afterEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountLocalActivations, startPreparedActivation } from '../../../subagent/subagent/tests/local-activation.ts'
import * as JobTools from '../src/index.ts'

interface Row {
  id: string
  name: string
  config?: Record<string, unknown> & { id?: string; plugins?: Row[] }
  insert?: Row[]
}

const namesByPreset = {
  'job-apply': [
    'defer_deliver', 'gmail_accounts', 'gmail_verification_code',
    'headless_browser_click', 'headless_browser_close', 'headless_browser_credential', 'headless_browser_open', 'headless_browser_read',
    'headless_browser_resume', 'headless_browser_scroll', 'headless_browser_snapshot', 'headless_browser_tabs',
    'headless_browser_type', 'headless_browser_upload',
    'job_cover_convert', 'job_issue', 'job_log', 'job_repo', 'jobtracker', 'list_agents', 'read_image', 'send_message',
    'skill', 'subagent', 'todo_write', 'web_fetch', 'web_search',
  ],
  'job-inbox': ['defer_deliver', 'gmail_read', 'gmail_search', 'job_issue', 'job_log', 'job_repo', 'jobtracker', 'skill', 'todo_write'],
  'job-lead': ['job_issue', 'job_log', 'job_repo', 'jobtracker', 'list_agents', 'send_message', 'skill', 'subagent', 'todo_write'],
} as const

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup() {
  const rows = parse(readFileSync(new URL('../../../../fork/bundles/event/cordis.patch.yml', import.meta.url), 'utf8'), { logLevel: 'error' }) as Row[]
  const presets = rows.flatMap(patch => patch.insert ?? [])
    .filter(preset => preset.config?.id !== undefined && Object.hasOwn(namesByPreset, preset.config.id))
  expect(presets.map(row => row.config?.id)).toEqual(['job-apply', 'job-inbox', 'job-lead'])
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx)
  await mountLocalActivations(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'job-apply' })
  ctx.provide('gmail', {} as never)
  ctx.provide('web', { searchReady: () => true, fetchReady: () => true } as never)
  ctx.provide('ownerNotifier', { delivery: () => 'hybrid' } as never)
  await ctx.plugin(Browser, Browser.Config({} as Browser.Config))
  const forbidden = vi.fn(() => Promise.resolve('danger'))
  for (const name of ['bash', 'gmail_read', 'gmail_search', 'gmail_attachment', 'wechat_send', 'wechat_send_file', 'cc_start']) {
    ctx.tools.register(defineTool({ name, description: 'Forbidden inherited fixture', parameters: {}, output: { schema: { type: 'string' }, render: () => [] }, execute: forbidden }))
  }
  Object.assign(ctx.loader.builtins, {
    'dsh-agent-preset': AgentPreset, 'dsh-headless-browser': Browser, 'dsh-persona': Persona,
    'dsh-time-context': TimeContext, 'dsh-tool-gmail': Gmail, 'dsh-tool-job-apply': JobTools,
    'dsh-tool-subagent': SubagentTool, 'dsh-tool-subagent-control': SubagentControl, 'dsh-tool-todo': Todo,
    'dsh-tool-web': Web, 'dsh-tool-wechat': WeChat,
  })
  const asBuiltin = (entry: Row) => ({ ...entry, name: entry.name.replace('@deepseek-ai/', 'cordis:') })
  // The compaction group adds no tool and needs the Host's token meter and session projections, which this host
  // does not mount; preset-compaction.spec.ts checks it.
  const toolRows = (plugins: Row[] | undefined) => plugins?.filter(entry => entry.id !== 'compaction').map(asBuiltin)
  await ctx.loader.root.update(presets.map(row => ({
    ...asBuiltin(row), config: { ...row.config, plugins: toolRows(row.config?.plugins) },
  })))
  const adapter = new MockAdapter([textResponse('child done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agentOf = async (preset: keyof typeof namesByPreset) => (await ctx.agents.create({
    sessionId: SessionId(preset), meta: { agentPreset: preset }, agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (scope) => { await ctx.agentPresets.mount(scope, preset) },
  })).agent
  return { ctx, adapter, agentOf, forbidden }
}

it('scopes exactly the shipped tool rosters, even when powerful tools are mounted above them', async () => {
  const { ctx, agentOf, forbidden } = await setup()
  const roster = await ctx.agentPresets.remoteExportList()
  for (const preset of ['job-apply', 'job-inbox', 'job-lead'] as const) {
    const entry = roster.presets.find(candidate => candidate.id === preset)
    expect(entry).toBeDefined()
    expect(entry).not.toHaveProperty('broken')
    const agent = await agentOf(preset)
    const schemas = ctx.tools.schemas(agent)
    const names = schemas.map(tool => tool.name).sort()
    expect(names).toEqual(namesByPreset[preset])
    if (preset === 'job-apply') {
      expect(names.filter(name => name.startsWith('gmail_'))).toEqual(['gmail_accounts', 'gmail_verification_code'])
      expect(ctx.tools.get('bash', agent)).toBeUndefined()
      expect(ctx.tools.get('gmail_read', agent)).toBeUndefined()
      expect(ctx.tools.get('headless_browser_cookies', agent)).toBeUndefined()
    }
    if (preset === 'job-lead') {
      expect(schemas.find(tool => tool.name === 'subagent')?.parameters?.['properties']).toMatchObject({
        agent_preset: { enum: ['job-apply', 'job-inbox'] },
      })
      const delegate = ctx.tools.get('subagent', agent)
      if (delegate === undefined) throw new Error('Missing delegation tool')
      await expect(delegate.execute({ agent_preset: 'unattended', description: 'wrong preset', prompt: 'not allowed' }, {
        agent, signal: new AbortController().signal,
      } as Parameters<typeof delegate.execute>[1])).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    }
  }
  expect(forbidden).not.toHaveBeenCalled()
})

it('projects only its own captured snapshot through the read_image replacement', async () => {
  const { ctx, agentOf } = await setup()
  const worker = await agentOf('job-apply')
  const inbox = await agentOf('job-inbox')
  const id = 'job-snapshot:fixture.png'
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ref = { attachmentId: 'sha256:fixture', mediaType: 'image/png', bytes: 8, width: 1, height: 1 }
  const saveImage = vi.fn(async () => ref)
  ctx.provide('attachments', { saveImage } as never)
  vi.spyOn(ctx.headlessBrowserJobBridge.browser, 'jobSnapshot').mockImplementation((owner, path) =>
    owner === worker.session.id && path === id ? bytes : undefined)
  const tool = ctx.tools.get('read_image', worker)
  if (tool === undefined) throw new Error('Missing scoped image tool')
  const run = async (file_path: string, agent: typeof worker) => await tool.execute({ file_path }, {
    agent, signal: new AbortController().signal,
  } as Parameters<typeof tool.execute>[1])
  await expect(run('/tmp/unrelated.png', worker)).rejects.toThrow('belongs to this Session')
  await expect(run(id, inbox)).rejects.toThrow('belongs to this Session')
  expect(ctx.tools.get('read_image', inbox)).toBeUndefined()
  expect(saveImage).not.toHaveBeenCalled()
  const value = await run(id, worker)
  expect(saveImage).toHaveBeenCalledExactlyOnceWith({ data: bytes, mediaType: 'image/png', name: 'job-snapshot.png' })
  expect(value).toEqual({ path: id, image: ref })
  expect(tool.output.render({ file_path: id }, { path: id, image: ref })).toContainEqual({ type: 'image', attachment: ref })
})

it('inherits the same job-apply tools when a worker delegates', async () => {
  const { adapter, agentOf } = await setup()
  const agent = await agentOf('job-apply')
  const child = await startPreparedActivation({ parent: agent, label: 'Posting', prompt: [{ type: 'text', text: 'Review one posting' }], signal: new AbortController().signal })
  try {
    const result = await child.result
    expect(result.stopReason, JSON.stringify(child.localAgent?.session.snapshotEvents())).not.toBe('error')
    expect(adapter.requests.at(-1)?.tools?.map(tool => tool.name).sort()).toEqual(namesByPreset['job-apply'])
    expect(child.localAgent?.session.header.agentPreset).toBe('job-apply')
  } finally { await child.dispose() }
})
