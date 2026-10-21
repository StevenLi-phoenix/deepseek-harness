/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */
import { LsySubscriptionError } from '@deepseek-ai/dsh-lsy-event-bus'
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

const NOW = '2026-10-21T00:00:00.000Z'

/** Mount with `acme/tool` served and the configured streams answering, so the first tick records baselines. */
async function withAcme(options: Parameters<typeof harness>[0] = {}) {
  const gh = new FakeGitHub('https://api.github.test')
  gh.set(ACME.repo, repository('acme/tool'))
  gh.set(ACME.releases, [release(1)])
  gh.set(OCTO_RELEASES, [])
  gh.set(NOTIFICATIONS, [])
  return await harness({ gh, ...options })
}

describe('watch tools registration', () => {
  it('registers watch_create, watch_list, and watch_delete with model-facing guidance', async () => {
    const { ctx } = await harness()
    const schemas = ctx.tools.schemas()
    const create = schemas.find(schema => schema.name === 'watch_create')!
    expect(create.description).toMatch(/baseline/)
    expect(create.description).toMatch(/NO_REPLY/)
    expect(create.description).toMatch(/schedule_create/)
    const parameters = create.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(parameters.properties)).toEqual([
      'id', 'github_repo', 'streams', 'branch', 'github_notifications', 'action', 'instructions', 'workspace_path', 'coalesce_seconds', 'max_per_hour',
    ])
    expect(parameters.required).toEqual(['id'])
    expect(schemas.map(schema => schema.name)).toEqual(expect.arrayContaining(['watch_list', 'watch_delete']))
  })

  it('presents each call with a short title', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.get('watch_create')!.presentCall!({ id: 'acme', github_repo: 'acme/tool' })).toEqual({ card: 'generic', title: 'Watch acme/tool', kind: 'other', rawInput: 'acme' })
    expect(ctx.tools.get('watch_create')!.presentCall!({ id: 'mine', github_notifications: true })).toEqual({ card: 'generic', title: 'Watch GitHub notifications', kind: 'other', rawInput: 'mine' })
    expect(ctx.tools.get('watch_list')!.presentCall!({})).toEqual({ card: 'generic', title: 'List watches', kind: 'read' })
    expect(ctx.tools.get('watch_delete')!.presentCall!({ id: 'acme' })).toEqual({ card: 'generic', title: 'Delete watch', kind: 'other', rawInput: 'acme' })
  })
})

describe('watch_create for a repository', () => {
  it('probes, watches, subscribes, and reports a view with no warnings', async () => {
    const { call, bus, sensor } = await withAcme()
    const result = await call('watch_create', { id: 'acme', github_repo: 'acme/tool' })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      id: 'acme',
      origin: 'agent',
      target: { kind: 'github_repo', repo: 'acme/tool', streams: ['releases'] },
      action: 'notify',
      coalesce_seconds: 60,
      max_per_hour: 12,
      created_at: NOW,
      // The baseline poll the watch started may or may not have finished yet.
      status: { pending_events: 0, batches_last_hour: 0, polling: [expect.objectContaining({ stream: 'releases', polled: true })] },
      warnings: [],
    })
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.value) }])
    expect(bus.listSubscriptions().find(entry => entry.id === 'acme')).toMatchObject({
      sources: ['github'], kinds: ['github.release'], subjects: ['acme/tool'], action: 'notify', coalesceMs: 60_000, maxPerHour: 12,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(sensor.cursor('repo:acme/tool:releases')?.initialized).toBe(true)
  })

  it('maps streams to event kinds, keeps the commits branch, and honors pacing arguments', async () => {
    const { call, bus, sensor, gh } = await withAcme()
    gh.set(ACME.commits, [])
    gh.set(ACME.tags, [])
    const result = await call('watch_create', {
      id: 'acme-dev', github_repo: 'acme/tool', streams: ['commits', 'tags', 'commits'], branch: 'dev', coalesce_seconds: 300, max_per_hour: 2,
    })
    expect(result.value).toMatchObject({ target: { kind: 'github_repo', repo: 'acme/tool', streams: ['commits', 'tags'], branch: 'dev' }, coalesce_seconds: 300, max_per_hour: 2 })
    expect(bus.listSubscriptions().find(entry => entry.id === 'acme-dev')).toMatchObject({ kinds: ['github.commit', 'github.tag'], coalesceMs: 300_000, maxPerHour: 2 })
    expect(sensor.watchedRepos().find(entry => entry.ref === 'acme-dev')).toMatchObject({ watch: ['commits', 'tags'], branch: 'dev' })
  })

  it('watches GitHub\'s canonical name and says so', async () => {
    const { call, gh, bus } = await withAcme()
    gh.set(ACME.repo, repository('Acme/Tool'))
    const result = await call('watch_create', { id: 'acme', github_repo: 'acme/tool' })
    expect(result.value).toMatchObject({ target: { repo: 'Acme/Tool' }, warnings: [expect.stringContaining('canonical name')] })
    expect(bus.listSubscriptions().find(entry => entry.id === 'acme')!.subjects).toEqual(['Acme/Tool'])
  })

  it('warns that polling is unauthenticated without a repository token', async () => {
    const { call } = await withAcme({ tokens: {} })
    const result = await call('watch_create', { id: 'acme', github_repo: 'acme/tool' })
    expect(result.value).toMatchObject({ warnings: [expect.stringMatching(/LSY_GITHUB_TOKEN is not configured.*60 requests per hour/)] })
  })

  it('refuses a repository the probe cannot read and leaves nothing behind', async () => {
    const { call, bus, sensor } = await withAcme({ tokens: {} })
    const result = await call('watch_create', { id: 'gone', github_repo: 'acme/gone' })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ code: 'repo_unavailable', message: expect.stringMatching(/acme\/gone.*HTTP 404.*LSY_GITHUB_TOKEN is not configured/) })
    expect(bus.listSubscriptions().map(entry => entry.id)).not.toContain('gone')
    expect(sensor.watchedRepos().map(entry => entry.ref)).not.toContain('gone')
  })

  it('omits the token hint when the token is configured', async () => {
    const { call } = await withAcme()
    const result = await call('watch_create', { id: 'gone', github_repo: 'acme/gone' })
    expect(result.value).toEqual({ code: 'repo_unavailable', message: 'acme/gone cannot be read: HTTP 404: Not Found' })
  })
})

describe('watch_create for notifications', () => {
  it('subscribes to notification events', async () => {
    const { call, bus } = await withAcme()
    const result = await call('watch_create', { id: 'inbox', github_notifications: true })
    expect(result.value).toEqual({
      id: 'inbox',
      origin: 'agent',
      target: { kind: 'github_notifications' },
      action: 'notify',
      coalesce_seconds: 60,
      max_per_hour: 12,
      created_at: NOW,
      status: { pending_events: 0, batches_last_hour: 0, polling: [{ stream: 'notifications', polled: true, baseline: true, last_poll: { at: NOW, ok: true } }] },
      warnings: [],
    })
    expect(bus.listSubscriptions().find(entry => entry.id === 'inbox')).toMatchObject({ sources: ['github'], kinds: ['github.notification.*'], subjects: [] })
  })

  it('warns when the notifications token is missing', async () => {
    const { call } = await withAcme({ tokens: { LSY_GITHUB_TOKEN: 'repo-token' } })
    const result = await call('watch_create', { id: 'inbox', github_notifications: true })
    expect(result.value).toMatchObject({
      status: { polling: [{ stream: 'notifications', polled: false, baseline: false }] },
      warnings: [expect.stringMatching(/LSY_GITHUB_NOTIFICATIONS_TOKEN is not configured/)],
    })
  })

  it('warns when notification polling is off', async () => {
    const { call } = await withAcme({ sensor: { notifications: false } })
    const result = await call('watch_create', { id: 'inbox', github_notifications: true })
    expect(result.value).toMatchObject({ warnings: [expect.stringMatching(/notification polling is turned off/)] })
  })
})

describe('watch_create with a session action', () => {
  it('fills the unattended defaults', async () => {
    const { call, bus } = await withAcme()
    const result = await call('watch_create', { id: 'acme', github_repo: 'acme/tool', action: 'session', instructions: '  Summarize the release.  ' })
    expect(result.value).toMatchObject({ action: 'session', instructions: 'Summarize the release.', workspace_path: '/Users/dsh-runtime/work', max_per_hour: 4 })
    expect(bus.listSubscriptions().find(entry => entry.id === 'acme')!.session).toEqual({
      workspacePath: '/Users/dsh-runtime/work',
      agentPreset: 'unattended',
      permissionPreset: 'danger-full-access',
      instructions: 'Summarize the release.',
      maxPromptEvents: 50,
      maxTextChars: 2000,
    })
  })

  it('uses the configured defaults and an explicit workspace', async () => {
    const { call, bus } = await withAcme({ tool: { defaultAgentPreset: 'standard', defaultPermissionPreset: 'workspace-write', defaultSessionMaxPerHour: 1, defaultCoalesceSeconds: 5 } })
    await call('watch_create', { id: 'acme', github_repo: 'acme/tool', action: 'session', instructions: 'Go.', workspace_path: '/tmp/ws' })
    expect(bus.listSubscriptions().find(entry => entry.id === 'acme')).toMatchObject({
      coalesceMs: 5_000, maxPerHour: 1, session: { workspacePath: '/tmp/ws', agentPreset: 'standard', permissionPreset: 'workspace-write' },
    })
  })
})

describe('watch_create validation', () => {
  it.each([
    ['an unknown argument', { id: 'a', repo: 'acme/tool' }, 'invalid_arguments'],
    ['an id with capitals', { id: 'Acme', github_repo: 'acme/tool' }, 'invalid_id'],
    ['an id starting with a hyphen', { id: '-a', github_repo: 'acme/tool' }, 'invalid_id'],
    ['an id that is too long', { id: 'a'.repeat(64), github_repo: 'acme/tool' }, 'invalid_id'],
    ['no target', { id: 'a' }, 'invalid_target'],
    ['two targets', { id: 'a', github_repo: 'acme/tool', github_notifications: true }, 'invalid_target'],
    ['notifications set to false', { id: 'a', github_notifications: false }, 'invalid_target'],
    ['streams with notifications', { id: 'a', github_notifications: true, streams: ['releases'] }, 'invalid_target'],
    ['a branch with notifications', { id: 'a', github_notifications: true, branch: 'main' }, 'invalid_target'],
    ['a repository that is not owner/name', { id: 'a', github_repo: 'https://github.com/acme/tool' }, 'invalid_target'],
    ['no streams', { id: 'a', github_repo: 'acme/tool', streams: [] }, 'invalid_streams'],
    ['a branch without commits', { id: 'a', github_repo: 'acme/tool', branch: 'main' }, 'invalid_streams'],
    ['a blank branch', { id: 'a', github_repo: 'acme/tool', streams: ['commits'], branch: ' ' }, 'invalid_streams'],
    ['a session without instructions', { id: 'a', github_repo: 'acme/tool', action: 'session' }, 'invalid_action'],
    ['a session with blank instructions', { id: 'a', github_repo: 'acme/tool', action: 'session', instructions: ' ' }, 'invalid_action'],
    ['instructions on a notify watch', { id: 'a', github_repo: 'acme/tool', instructions: 'x' }, 'invalid_action'],
    ['a workspace on a notify watch', { id: 'a', github_repo: 'acme/tool', workspace_path: '/w' }, 'invalid_action'],
    ['a relative workspace', { id: 'a', github_repo: 'acme/tool', action: 'session', instructions: 'x', workspace_path: 'work' }, 'invalid_workspace'],
    ['a negative coalesce window', { id: 'a', github_repo: 'acme/tool', coalesce_seconds: -1 }, 'invalid_limits'],
    ['a coalesce window over a day', { id: 'a', github_repo: 'acme/tool', coalesce_seconds: 86_401 }, 'invalid_limits'],
    ['a fractional coalesce window', { id: 'a', github_repo: 'acme/tool', coalesce_seconds: 1.5 }, 'invalid_limits'],
    ['a zero hourly limit', { id: 'a', github_repo: 'acme/tool', max_per_hour: 0 }, 'invalid_limits'],
    ['an hourly limit over 60', { id: 'a', github_repo: 'acme/tool', max_per_hour: 61 }, 'invalid_limits'],
  ])('rejects %s', async (_label, args, code) => {
    // The tool body checks every argument itself, including what the registry's schema check would already refuse.
    const { callAs, bus } = await withAcme()
    expect(await callAs('s1', 'watch_create', args)).toEqual({ code, message: expect.any(String) })
    expect(bus.listSubscriptions()).toHaveLength(2)
  })

  it.each([
    ['an unknown stream', { id: 'a', github_repo: 'acme/tool', streams: ['issues'] }],
    ['an unknown action', { id: 'a', github_repo: 'acme/tool', action: 'email' }],
    ['a non-numeric limit', { id: 'a', github_repo: 'acme/tool', max_per_hour: '5' }],
  ])('lets the registry refuse %s before the tool runs', async (_label, args) => {
    const { call, bus } = await withAcme()
    expect((await call('watch_create', args)).isError).toBe(true)
    expect(bus.listSubscriptions()).toHaveLength(2)
  })

  it('refuses ids the configuration or another watch already uses', async () => {
    const { call } = await withAcme()
    expect((await call('watch_create', { id: 'config-releases', github_notifications: true })).value)
      .toEqual({ code: 'duplicate_id', message: expect.stringMatching(/deployment configuration/) })
    await call('watch_create', { id: 'inbox', github_notifications: true })
    expect((await call('watch_create', { id: 'inbox', github_repo: 'acme/tool' })).value)
      .toEqual({ code: 'duplicate_id', message: expect.stringMatching(/already exists/) })
  })
})

describe('watch_create failures', () => {
  it('rolls the repository watch back when the subscription is refused', async () => {
    const { call, bus, sensor } = await withAcme()
    const refusals = [
      new LsySubscriptionError('duplicate_id', 'taken'),
      new LsySubscriptionError('invalid_subscription', 'bad'),
      new Error('disk full'),
    ]
    const codes: unknown[] = []
    for (const refusal of refusals) {
      bus.subscribe = async () => { throw refusal }
      codes.push((await call('watch_create', { id: 'acme', github_repo: 'acme/tool' })).value)
      expect(sensor.watchedRepos().map(entry => entry.ref)).not.toContain('acme')
    }
    expect(codes).toEqual([
      { code: 'duplicate_id', message: 'taken' },
      { code: 'internal_error', message: 'The watch operation failed.' },
      { code: 'internal_error', message: 'The watch operation failed.' },
    ])
  })

  it('reports an internal error when the rollback fails too', async () => {
    const { call, bus, sensor } = await withAcme()
    bus.subscribe = async () => { throw new Error('disk full') }
    sensor.unwatch = async () => { throw new Error('still full') }
    expect((await call('watch_create', { id: 'acme', github_repo: 'acme/tool' })).value).toEqual({ code: 'internal_error', message: 'The watch operation failed.' })
  })

  it('reports an internal error when the sensor cannot store the watch', async () => {
    const { call, sensor, bus } = await withAcme()
    sensor.watch = async () => { throw new Error('disk full') }
    expect((await call('watch_create', { id: 'acme', github_repo: 'acme/tool' })).value).toEqual({ code: 'internal_error', message: 'The watch operation failed.' })
    expect(bus.listSubscriptions().map(entry => entry.id)).not.toContain('acme')
  })

  it('records the calling Session as the creator', async () => {
    const { callAs, bus } = await withAcme()
    await callAs('session-7', 'watch_create', { id: 'inbox', github_notifications: true })
    expect(bus.listSubscriptions().find(entry => entry.id === 'inbox')).toMatchObject({ createdBy: 'session-7' })
  })
})

describe('watch_list', () => {
  it('lists config and agent watches with status and credentials', async () => {
    const { call, gh } = await withAcme({ tokens: { LSY_GITHUB_TOKEN: 'repo-token' } })
    await call('watch_create', { id: 'acme', github_repo: 'acme/tool', action: 'session', instructions: 'Check it.' })
    await vi.advanceTimersByTimeAsync(0)
    gh.set(ACME.releases, [release(2), release(1)])
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await call('watch_list', {})
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      watches: [
        {
          id: 'config-releases',
          origin: 'config',
          target: { kind: 'github_repo', repo: 'octo/repo', streams: ['releases'] },
          action: 'notify',
          coalesce_seconds: 60,
          max_per_hour: 12,
          status: { pending_events: 0, batches_last_hour: 0, polling: [{ stream: 'releases', polled: true, baseline: true, last_poll: { at: '2026-10-21T00:01:00.000Z', ok: true } }] },
        },
        {
          id: 'config-everything',
          origin: 'config',
          target: { kind: 'event_filter', sources: [], kinds: ['custom.*'], subjects: [] },
          action: 'notify',
          coalesce_seconds: 60,
          max_per_hour: 12,
          status: { pending_events: 0, batches_last_hour: 0 },
        },
        {
          id: 'acme',
          origin: 'agent',
          target: { kind: 'github_repo', repo: 'acme/tool', streams: ['releases'] },
          action: 'session',
          instructions: 'Check it.',
          workspace_path: '/Users/dsh-runtime/work',
          coalesce_seconds: 60,
          max_per_hour: 4,
          created_at: NOW,
          status: {
            pending_events: 1,
            batches_last_hour: 0,
            next_batch_at: '2026-10-21T00:02:00.000Z',
            polling: [{ stream: 'releases', polled: true, baseline: true, last_poll: { at: '2026-10-21T00:01:00.000Z', ok: true } }],
          },
        },
      ],
      credentials: {
        github_token: { name: 'LSY_GITHUB_TOKEN', configured: true },
        github_notifications_token: { name: 'LSY_GITHUB_NOTIFICATIONS_TOKEN', configured: false },
        notifications_polling: true,
      },
    })
  })

  it('reports the last batch with its outcome, failures, and unpolled streams', async () => {
    const { call, notifier, gh, sensor } = await withAcme()
    await call('watch_create', { id: 'acme', github_repo: 'acme/tool' })
    await vi.advanceTimersByTimeAsync(0)
    notifier.send = async () => { throw new Error('wechat down') }
    gh.set(ACME.releases, [release(2), release(1)])
    await vi.advanceTimersByTimeAsync(120_000)
    gh.set(ACME.releases, { message: 'gone' }, { status: 404 })
    await sensor.unwatch('acme')
    await sensor.watch('acme', { repo: 'acme/tool', watch: ['releases'] })
    await vi.advanceTimersByTimeAsync(0)
    let acme = ((await call('watch_list', {})).value as { watches: { id: string; status: unknown }[] }).watches.find(entry => entry.id === 'acme')
    expect(acme!.status).toEqual({
      pending_events: 0,
      batches_last_hour: 1,
      last_batch: { at: '2026-10-21T00:02:00.000Z', events: 1, status: 'failed', error: 'wechat down' },
      polling: [{ stream: 'releases', polled: true, baseline: false, last_poll: { at: '2026-10-21T00:02:00.000Z', ok: false, detail: 'HTTP 404' } }],
    })
    await sensor.unwatch('acme')
    acme = ((await call('watch_list', {})).value as { watches: { id: string; status: unknown }[] }).watches.find(entry => entry.id === 'acme')
    expect(acme!.status).toMatchObject({ polling: [{ stream: 'releases', polled: false, baseline: false }] })
  })

  it('reports Session outcomes and silent replies of the last batch', async () => {
    const { call, ctx, bus, deliveries } = await withAcme()
    await call('watch_create', { id: 'inbox', github_notifications: true, action: 'session', instructions: 'Triage.', coalesce_seconds: 0 })
    await bus.publish({ source: 'github', kind: 'github.notification.issue', key: 'n1', subject: 'octo/repo', title: 'Issue' })
    await vi.advanceTimersByTimeAsync(1)
    const deliveryId = (deliveries[0] as { deliveryId: string }).deliveryId
    const emit = (event: unknown): void => { (ctx.emit as (...args: unknown[]) => void)('session/event', { id: 'w1' }, event) }
    emit({ type: 'user/message', seq: 1, data: { role: 'user', content: [], source: { kind: 'webhook', provider: 'lsy-event', source: 'inbox', deliveryId } } })
    emit({ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'NO_REPLY' }] } } })
    emit({ type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.advanceTimersByTimeAsync(0)
    const inbox = ((await call('watch_list', {})).value as { watches: { id: string; status: { last_batch?: unknown } }[] }).watches.find(entry => entry.id === 'inbox')
    expect(inbox!.status.last_batch).toEqual({ at: NOW, events: 1, status: 'completed', outcome: 'completed', silent: true })
  })

  it('reports an internal error when the credential check fails', async () => {
    const { call, sensor } = await withAcme()
    for (const failure of [new Error('locked'), 'plain failure']) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercises non-Error rejections.
      sensor.credentialStatus = () => Promise.reject(failure)
      expect((await call('watch_list', {})).value).toEqual({ code: 'internal_error', message: 'The watch operation failed.' })
    }
  })
})

describe('watch_delete', () => {
  it('removes the subscription and the repository watch', async () => {
    const { call, bus, sensor } = await withAcme()
    await call('watch_create', { id: 'acme', github_repo: 'acme/tool' })
    const result = await call('watch_delete', { id: 'acme' })
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ id: 'acme', deleted: true })
    expect(bus.listSubscriptions().map(entry => entry.id)).not.toContain('acme')
    expect(sensor.watchedRepos().map(entry => entry.ref)).not.toContain('acme')
    expect((await call('watch_delete', { id: 'acme' })).value).toEqual({ code: 'watch_not_found', message: expect.stringMatching(/watch_list/) })
  })

  it('removes a notifications watch and a repository watch left without a subscription', async () => {
    const { call, sensor } = await withAcme()
    await call('watch_create', { id: 'inbox', github_notifications: true })
    expect((await call('watch_delete', { id: 'inbox' })).value).toEqual({ id: 'inbox', deleted: true })
    await sensor.watch('orphan', { repo: 'acme/tool', watch: ['releases'] })
    expect((await call('watch_delete', { id: 'orphan' })).value).toEqual({ id: 'orphan', deleted: true })
    expect(sensor.watchedRepos().map(entry => entry.ref)).not.toContain('orphan')
  })

  it('refuses config-owned watches and invalid ids', async () => {
    const { call } = await withAcme()
    expect((await call('watch_delete', { id: 'config-releases' })).value).toEqual({ code: 'config_owned', message: expect.stringMatching(/deployment configuration/) })
    expect((await call('watch_delete', { id: ' acme' })).value).toEqual({ code: 'invalid_id', message: expect.any(String) })
    expect((await call('watch_delete', { id: '' })).value).toEqual({ code: 'invalid_id', message: expect.any(String) })
  })

  it('reports an internal error when storage fails', async () => {
    const { call, bus } = await withAcme()
    bus.unsubscribe = async () => { throw new Error('disk full') }
    expect((await call('watch_delete', { id: 'acme' })).value).toEqual({ code: 'internal_error', message: 'The watch operation failed.' })
  })
})
