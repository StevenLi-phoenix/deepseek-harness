/** End-to-end: fake GitHub → sensor → real bus → notifier and webhook runtime doubles. */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import LsyEventBus, { LSY_EVENT_KIND, type Config as BusConfig, type LsyNote } from '@deepseek-ai/dsh-lsy-event-bus'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { VerifiedWebhookDelivery, WebhookRule } from '@deepseek-ai/dsh-webhook'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import GithubSensor, { type Config as SensorConfig } from '../src/index.ts'
import { FakeGitHub, commit, release, thread } from './fake-github.ts'

const busConfig: BusConfig = {
  subscriptions: [
    { id: 'releases', sources: ['github'], kinds: ['github.release'], subjects: ['octo/*'], action: 'notify', coalesceMs: 30_000, maxPerHour: 10 },
    {
      id: 'triage',
      sources: ['github'],
      kinds: ['github.notification.*', 'github.commit'],
      subjects: [],
      action: 'session',
      coalesceMs: 30_000,
      maxPerHour: 4,
      session: {
        workspacePath: '/Users/dsh-runtime/work',
        agentPreset: 'unattended',
        permissionPreset: 'danger-full-access',
        instructions: 'Triage these GitHub events.',
        maxPromptEvents: 20,
        maxTextChars: 500,
      },
    },
  ],
  suppress: { actors: ['dsh-agent-bot'], markers: ['Dsh-Agent:'] },
  retainEvents: 1000,
  retainBatches: 100,
  maxTextChars: 2000,
  notifySessionResult: true,
  reportScheduledTurns: true,
  maxNoteEvents: 10,
}

const sensorConfig: SensorConfig = {
  intervalMs: 60_000,
  apiBase: 'https://api.github.test',
  tokenEnv: 'LSY_GITHUB_TOKEN',
  notificationsTokenEnv: 'LSY_GITHUB_NOTIFICATIONS_TOKEN',
  notifications: true,
  repos: [{ repo: 'octo/repo', watch: ['releases', 'commits'] }],
  timeoutMs: 10_000,
  maxTextChars: 2000,
  perPage: 20,
  maxSeenPerStream: 200,
}

const REL = '/repos/octo/repo/releases?per_page=20'
const COMMITS = '/repos/octo/repo/commits?per_page=20'
const NOTIFICATIONS = '/notifications?per_page=50'

let ctx: Context | undefined

async function pipeline(gh: FakeGitHub) {
  vi.stubGlobal('fetch', gh.fetch)
  ctx = new Context()
  await ctx.plugin(Timer)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(new MemoryMediaPool())
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  const root = ctx
  root.effect(() => root.storage.backend.register('fixture', backend))
  root.effect(() => {
    const unmount = root.storage.mount('domain', facility)
    root.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount(); await backend.close() }
  })
  root.provide('credentials', {
    resolve: async (ref: string) => ({ value: `${ref}-value`, source: 'env' }),
  } as never)
  const notes: LsyNote[] = []
  root.provide('lsyNotifier', { send: async (note: LsyNote) => { notes.push(note) } })
  const rules: WebhookRule[] = []
  const deliveries: VerifiedWebhookDelivery[] = []
  root.provide('webhookRuntime', {
    register: (rule: WebhookRule) => { rules.push(rule); return async () => {} },
    dispatch: (delivery: VerifiedWebhookDelivery) => { deliveries.push(delivery) },
  } as never)
  await root.plugin(LsyEventBus, busConfig)
  await root.plugin(GithubSensor, sensorConfig)
  await vi.advanceTimersByTimeAsync(0)
  return { ctx: root, notes, rules, deliveries }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('GitHub event pipeline', () => {
  it('turns a new release into one phone notification and nothing else', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [release(1)])
    gh.set(COMMITS, [commit('c1', 'init')])
    gh.set(NOTIFICATIONS, [])
    const { notes, deliveries } = await pipeline(gh)

    gh.set(REL, [release(2), release(1)])
    await vi.advanceTimersByTimeAsync(60_000 + 30_000)
    expect(notes).toEqual([{ title: 'releases: 1 event(s)', body: '• octo/repo v2.0.0\n  https://github.com/octo/repo/releases/tag/v2.0.0' }])
    expect(deliveries).toHaveLength(0)
  })

  it('starts one unattended Session for a burst of notifications and commits, skipping the agent\'s own commit', async () => {
    const gh = new FakeGitHub()
    gh.set(REL, [])
    gh.set(COMMITS, [commit('c1', 'init')])
    gh.set(NOTIFICATIONS, [])
    const { ctx: root, deliveries, rules, notes } = await pipeline(gh)

    gh.set(COMMITS, [
      commit('c3', 'chore: agent fix\n\nDsh-Agent: triage-1', 'someone'),
      commit('c2', 'feat: human change', 'octocat'),
      commit('c1', 'init'),
    ])
    gh.set(NOTIFICATIONS, [thread('9', '2026-10-21T00:00:30Z')])
    await vi.advanceTimersByTimeAsync(60_000 + 30_000)

    expect(deliveries).toHaveLength(1)
    const delivery = deliveries[0]!
    expect(delivery.kind).toBe(LSY_EVENT_KIND)
    const request = await rules[0]!.run(delivery, new AbortController().signal)
    expect(request).toMatchObject({ workspacePath: '/Users/dsh-runtime/work', agentPreset: 'unattended', permissionPreset: 'danger-full-access' })
    expect(request!.prompt).toContain('feat: human change')
    expect(request!.prompt).toContain('[subscribed] Issue 9')
    expect(request!.prompt).not.toContain('chore: agent fix')
    expect(root.lsyEventBus.events().find(event => event.key === 'octo/repo:commit:c3')).toMatchObject({ outcome: 'suppressed', reason: 'marker:Dsh-Agent:' })

    // The webhook runtime would start the Session; its first turn end comes back as one message.
    const emit = (event: unknown): void => { (root.emit as (...args: unknown[]) => void)('session/event', { id: 'webhook-1' }, event) }
    emit({ type: 'user/message', seq: 1, data: { role: 'user', content: [], source: { kind: 'webhook', provider: LSY_EVENT_KIND, source: 'triage', deliveryId: delivery.deliveryId } } })
    emit({ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'Issue 9 needs a reply; the human change is fine.' }] } } })
    emit({ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(notes.at(-1)?.title).toMatch(/^✅ triage: /)
    expect(notes.at(-1)?.body).toBe('Issue 9 needs a reply; the human change is fine.')
  })
})
