import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdEnabled } from '../src/config.ts'
import { ADMIN_COMMANDS } from '../src/admin-commands.ts'
import { parseAdminArgs } from '../src/admin-cli.ts'
import { NOTICE_LINGER_MS, mountNotices } from '../src/notice-queue.ts'
import type { NoticeItem } from '../src/notice.ts'
import { publicEntry, turnOriginOf } from '../src/tools.ts'
import { entryFrom, pendingFrom } from '../src/entries.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('holdEnabled', () => {
  it('defaults to on and follows the configuration', () => {
    expect(holdEnabled({}, {})).toBe(true)
    expect(holdEnabled({ hold: true }, {})).toBe(true)
    expect(holdEnabled({ hold: false }, {})).toBe(false)
  })

  it('lets LSY_MEMORY_HOLD=0 turn it off whatever the configuration says', () => {
    expect(holdEnabled({ hold: true }, { LSY_MEMORY_HOLD: '0' })).toBe(false)
    expect(holdEnabled({}, { LSY_MEMORY_HOLD: '0' })).toBe(false)
  })

  it('ignores every other value of the switch', () => {
    expect(holdEnabled({ hold: true }, { LSY_MEMORY_HOLD: '1' })).toBe(true)
    expect(holdEnabled({ hold: false }, { LSY_MEMORY_HOLD: '1' })).toBe(false)
  })
})

describe('parseAdminArgs', () => {
  it('splits options from the command and its words', () => {
    expect(parseAdminArgs(['recent', '--limit', '5', '--file', '/m/memory.jsonl'])).toMatchObject({ command: 'recent', ids: [], limit: 5, file: '/m/memory.jsonl' })
    expect(parseAdminArgs(['approve', 'aaaaaa', 'bbbbbb'])).toMatchObject({ command: 'approve', ids: ['aaaaaa', 'bbbbbb'], limit: 10, dryRun: false, purge: false })
    expect(parseAdminArgs(['rollback', '--session', 's1', '--since', '2026-11-01T00:00:00Z', '--dry-run']))
      .toMatchObject({ command: 'rollback', session: 's1', since: '2026-11-01T00:00:00Z', dryRun: true })
    expect(parseAdminArgs(['forget', '--purge', 'aaaaaa'])).toMatchObject({ command: 'forget', ids: ['aaaaaa'], purge: true })
    expect(parseAdminArgs(['feedback', 'list', '--scope', 'up'])).toMatchObject({ command: 'feedback', ids: ['list'], scope: 'up' })
  })

  it('reads no command from an empty line', () => {
    expect(parseAdminArgs([])).toMatchObject({ command: undefined, ids: [] })
  })

  it('refuses an unknown option, an option without its value, and a limit that is not a number', () => {
    expect(parseAdminArgs(['ids', '--bogus'])).toBeUndefined()
    expect(parseAdminArgs(['ids', '--file'])).toBeUndefined()
    expect(parseAdminArgs(['recent', '--limit', 'many'])).toBeUndefined()
    expect(parseAdminArgs(['recent', '--limit'])).toBeUndefined()
  })
})

describe('admin commands', () => {
  it('names every command the usage text lists, and nothing else', () => {
    expect([...ADMIN_COMMANDS.keys()].toSorted()).toEqual(['approve', 'discard', 'feedback', 'forget', 'ids', 'notices', 'recent', 'revert', 'rollback', 'show'])
  })
})

describe('tool helpers', () => {
  it('shows the model an entry without its Session id or origin label', () => {
    const entry = { id: 'abcdef', category: 'projects', date: '2026-11-01', text: 'DSH refactor', source: 'owner-turn', session: 'chat', origin: 'owner' } as const
    expect(publicEntry(entry)).toEqual({ id: 'abcdef', category: 'projects', date: '2026-11-01', text: 'DSH refactor', source: 'owner-turn' })
    expect(publicEntry({ id: 'abcdef', category: 'projects', date: '2026-11-01', text: 'legacy' })).toEqual({ id: 'abcdef', category: 'projects', date: '2026-11-01', text: 'legacy' })
  })

  it('counts a call outside any Agent as an unknown, unclean turn', () => {
    expect(turnOriginOf(new Context(), undefined)).toEqual({ triggers: [], owner: false, contaminated: [], clean: false })
  })
})

describe('notice queue', () => {
  const item = (text: string, kind: NoticeItem['kind'] = 'saved'): NoticeItem => ({ kind, id: 'abcdef', category: 'preferences', text, origin: 'owner' })

  function mount(options: { notify?: boolean; noticesPerDay?: number; notifier?: boolean } = {}) {
    const ctx = new Context()
    contexts.push(ctx)
    const sent: Array<{ title: string; body?: string }> = []
    if (options.notifier !== false) ctx.provide('lsyNotifier', { send: (note: { title: string; body?: string }) => { sent.push(note); return Promise.resolve() } } as never)
    const enqueue = mountNotices(ctx, { notify: options.notify ?? true, noticesPerDay: options.noticesPerDay ?? 12 })
    const endTurn = (session: Session) => { ctx.emit('session/event', session, { type: 'turn/end', seq: session.seq as never, time: 0, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent) }
    return { ctx, enqueue, sent, endTurn }
  }

  it('merges one turn\'s changes into a single notice sent when the turn ends', async () => {
    const { enqueue, sent, endTurn } = mount()
    const session = Session.create(SessionId('chat'))
    enqueue('chat', item('likes tea'))
    enqueue('chat', item('likes coffee', 'replaced'))
    expect(sent).toEqual([])
    endTurn(session)
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    expect(JSON.stringify(sent[0])).toContain('likes tea')
    expect(JSON.stringify(sent[0])).toContain('likes coffee')
  })

  it('sends after the linger when the turn never reports its end', async () => {
    vi.useFakeTimers()
    const { enqueue, sent } = mount()
    enqueue('chat', item('likes tea'))
    await vi.advanceTimersByTimeAsync(NOTICE_LINGER_MS - 1)
    expect(sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(sent).toHaveLength(1)
  })

  it('sends nothing when notices are off or the call has no Session', async () => {
    vi.useFakeTimers()
    const off = mount({ notify: false })
    off.enqueue('chat', item('a'))
    const on = mount()
    on.enqueue(undefined, item('b'))
    await vi.advanceTimersByTimeAsync(NOTICE_LINGER_MS + 1)
    expect(off.sent).toHaveLength(0)
    expect(on.sent).toHaveLength(0)
  })

  it('stops at the daily cap, counting Sessions apart', async () => {
    vi.useFakeTimers()
    const { enqueue, sent } = mount({ noticesPerDay: 2 })
    for (const id of ['s1', 's2', 's3']) enqueue(id, item(`from ${id}`))
    await vi.advanceTimersByTimeAsync(NOTICE_LINGER_MS + 1)
    expect(sent).toHaveLength(2)
  })

  it.each([
    [new Error('channel down'), 'channel down'],
    ['plain refusal', 'plain refusal'],
  ])('logs why a notice could not be sent and goes on (%s)', async (reason, text) => {
    vi.useFakeTimers()
    const ctx = new Context()
    contexts.push(ctx)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the case under test.
    ctx.provide('lsyNotifier', { send: () => Promise.reject(reason) } as never)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const enqueue = mountNotices(ctx, { notify: true, noticesPerDay: 12 })
    enqueue('chat', item('likes tea'))
    await vi.advanceTimersByTimeAsync(NOTICE_LINGER_MS + 1)
    expect(warn).toHaveBeenCalledWith('memory notice for session %s failed: %s', 'chat', text)
  })

  it('goes on without a channel and drops the queue when the scope is disposed', async () => {
    vi.useFakeTimers()
    const quiet = mount({ notifier: false })
    quiet.enqueue('chat', item('a'))
    await vi.advanceTimersByTimeAsync(NOTICE_LINGER_MS + 1)
    expect(quiet.sent).toHaveLength(0)

    const disposed = mount()
    const before = vi.getTimerCount()
    disposed.enqueue('chat', item('b'))
    expect(vi.getTimerCount()).toBe(before + 1)
    await disposed.ctx.fiber.dispose()
    expect(vi.getTimerCount()).toBe(before)
    await vi.advanceTimersByTimeAsync(NOTICE_LINGER_MS + 1)
    expect(disposed.sent).toHaveLength(0)
  })
})

describe('entry records', () => {
  const base = { id: 'abcdef', category: 'projects', date: '2026-11-01', text: 'DSH refactor' }

  it('reads a well-formed record and nothing else', () => {
    expect(entryFrom(base)).toEqual(base)
    expect(entryFrom(null)).toBeUndefined()
    expect(entryFrom('abcdef')).toBeUndefined()
  })

  it('rejects a record with a bad id, category, or date', () => {
    expect(entryFrom({ ...base, id: 'ABCDEF' })).toBeUndefined()
    expect(entryFrom({ ...base, category: 'secrets' })).toBeUndefined()
    expect(entryFrom({ ...base, date: '1 Nov 2026' })).toBeUndefined()
    expect(entryFrom({ ...base, date: 20261101 })).toBeUndefined()
  })

  it('rejects a record whose text is missing, empty, too long, or not on one normalized line', () => {
    expect(entryFrom({ ...base, text: undefined })).toBeUndefined()
    expect(entryFrom({ ...base, text: '' })).toBeUndefined()
    expect(entryFrom({ ...base, text: 'x'.repeat(2001) })).toBeUndefined()
    expect(entryFrom({ ...base, text: 'two  spaces' })).toBeUndefined()
  })

  it('reads a waiting write only with a known op, and a replacement only with a valid target', () => {
    expect(pendingFrom({ ...base, op: 'add' })).toEqual({ ...base, op: 'add' })
    expect(pendingFrom({ ...base, op: 'replace', target: '012345' })).toEqual({ ...base, op: 'replace', target: '012345' })
    expect(pendingFrom({ ...base, id: 'nope', op: 'add' })).toBeUndefined()
    expect(pendingFrom({ ...base, op: 'delete' })).toBeUndefined()
    expect(pendingFrom({ ...base, op: 'replace', target: 'nope' })).toBeUndefined()
    expect(pendingFrom({ ...base, op: 'replace' })).toBeUndefined()
  })
})
