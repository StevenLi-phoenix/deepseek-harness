/** End-to-end: watch_create → fake GitHub → sensor → real bus → notifier and webhook runtime doubles. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeGitHub, release } from '../../lsy-github-sensor/tests/fake-github.ts'
import { ACME, NOTIFICATIONS, OCTO_RELEASES, disposeAll, harness, repository } from './harness.ts'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'))
})

afterEach(async () => {
  await disposeAll()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount() {
  const gh = new FakeGitHub('https://api.github.test')
  gh.set(ACME.repo, repository('acme/tool'))
  gh.set(ACME.releases, [release(1)])
  gh.set(OCTO_RELEASES, [])
  gh.set(NOTIFICATIONS, [])
  return await harness({ gh })
}

describe('watch pipeline', () => {
  it('turns a release published after watch_create into one WeChat note, and the baseline into none', async () => {
    const { call, gh, notes } = await mount()
    expect((await call('watch_create', { id: 'acme', github_repo: 'acme/tool', coalesce_seconds: 30 })).isError).toBe(false)
    await vi.advanceTimersByTimeAsync(120_000)
    // Only the audit note of the call itself: the existing release is the baseline.
    expect(notes.map(note => note.title)).toEqual(['🆕 watch created: acme'])

    gh.set(ACME.releases, [release(2), release(1)])
    await vi.advanceTimersByTimeAsync(60_000 + 30_000)
    expect(notes).toEqual([
      { title: '🆕 watch created: acme', body: 'target: GitHub repo acme/tool [releases]\naction: notify\nSession: unknown' },
      { title: 'acme: 1 event(s)', body: '• acme/tool v2.0.0\n  https://github.com/octo/repo/releases/tag/v2.0.0' },
    ])

    // After watch_delete the repository is no longer polled.
    await call('watch_delete', { id: 'acme' })
    const polled = gh.requestsTo(ACME.releases).length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(gh.requestsTo(ACME.releases)).toHaveLength(polled)
  })

  it('starts an unattended Session for a session watch and relays its answer unless it is NO_REPLY', async () => {
    const { ctx, call, gh, notes, deliveries, rules } = await mount()
    await call('watch_create', { id: 'acme', github_repo: 'acme/tool', action: 'session', instructions: 'Decide whether to upgrade.', coalesce_seconds: 0 })
    await vi.advanceTimersByTimeAsync(0)

    const emit = (sessionId: string, event: unknown): void => { (ctx.emit as (...args: unknown[]) => void)('session/event', { id: sessionId }, event) }
    for (const [n, answer] of [[2, 'Upgrade: it fixes a bug you hit.'], [3, 'NO_REPLY']] as const) {
      gh.set(ACME.releases, Array.from({ length: n }, (_, index) => release(n - index)))
      await vi.advanceTimersByTimeAsync(60_000)
      // Node clamps the zero-length coalesce timer armed by the publish to 1 ms.
      await vi.advanceTimersByTimeAsync(1)
      const delivery = deliveries.at(-1) as { deliveryId: string }
      type SessionRequest = { workspacePath: string; agentPreset: string; permissionPreset: string; prompt: string }
      const request = await rules[0]!.run(delivery, new AbortController().signal) as SessionRequest
      expect(request).toMatchObject({ workspacePath: '/Users/dsh-runtime/work', agentPreset: 'unattended', permissionPreset: 'danger-full-access' })
      expect(request.prompt.startsWith('Decide whether to upgrade.')).toBe(true)
      expect(request.prompt).toContain(`v${n}.0.0`)

      const sessionId = `w${n}`
      emit(sessionId, { type: 'user/message', seq: 1, data: { role: 'user', content: [], source: { kind: 'webhook', provider: 'lsy-event', source: 'acme', deliveryId: delivery.deliveryId } } })
      emit(sessionId, { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: answer }] } } })
      emit(sessionId, { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(deliveries).toHaveLength(2)
    expect(notes).toEqual([
      { title: '🆕 watch created: acme', body: 'target: GitHub repo acme/tool [releases]\naction: session\ninstructions: Decide whether to upgrade.\nSession: unknown' },
      { title: '✅ acme: acme/tool v2.0.0', body: 'Upgrade: it fixes a bug you hit.', url: 'https://dsh.example/' },
    ])
  })
})
