import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QqPanel, QqRefreshAnswer } from '../src/view.ts'
import { clock, detailRows, formatDuration, headline, qrPath, stamp, statusLine, type Translate } from '../src/client/cards.ts'
import { de, en, es, fr, ja, pt, ru, zh, type QqKey } from '../src/client/locales.ts'
import { CALM_POLL_INTERVAL_MS, POLL_INTERVAL_MS, QqLoader, createQqStore, parsePanel, startPolling, type VisibilitySource } from '../src/client/qq.ts'

const NOW = new Date(2026, 10, 1, 12, 0, 0).getTime()

const fill = (template: string, params: Record<string, string | number> = {}): string => template.replace(/\{(\w+)\}/g, (_m, key: string) => String(params[key] ?? ''))
const t: Translate = (key, params) => fill(zh[key], params)

function panel(over: { connection?: Partial<QqPanel['connection']>; login?: Partial<QqPanel['login']> } = {}): QqPanel {
  return {
    at: NOW,
    groupsRecorded: 24,
    groups: [],
    connection: { state: 'connected', since: NOW - 3 * 3_600_000, attempt: 0, lastError: null, selfId: '2153925085', ...over.connection },
    login: { door: 'ok', state: 'online', uin: '2153925085', nickname: '小号', error: null, qr: null, ...over.login },
  }
}

const QR = { size: 3, rows: ['101', '010', '111'] }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('headline', () => {
  it('says connected with the account and how long, whatever the door says', () => {
    const connected = headline(panel({ login: { door: 'unreachable', state: null, uin: null, nickname: null } }), NOW, t)
    expect(connected).toMatchObject({ kind: 'connected', tone: 'ok', text: 'QQ 已连接' })
    expect(connected.detail).toBe('账号 2153925085 · 已连续在线 3 小时 0 分')
  })

  it('asks for a scan while a code waits, and the section may draw it', () => {
    const scan = headline(panel({ connection: { state: 'reconnecting', attempt: 40, since: NOW - 1000, selfId: null }, login: { state: 'qr', uin: null, nickname: null, qr: QR } }), NOW, t)
    expect(scan).toMatchObject({ kind: 'scan', tone: 'action', text: '需要扫码登录' })
    expect(scan.detail).toContain('扫一扫')
  })

  it.each([
    ['scanned', 'scanned', 'action'],
    ['logging-in', 'logging-in', 'wait'],
    ['preparing', 'preparing', 'wait'],
    ['offline', 'offline', 'bad'],
    ['restarting', 'restarting', 'wait'],
    ['unknown', 'unknown', 'bad'],
  ] as const)('maps NapCat state %s to %s', (state, kind, tone) => {
    expect(headline(panel({ connection: { state: 'reconnecting', attempt: 3, selfId: null }, login: { state } }), NOW, t)).toMatchObject({ kind, tone })
  })

  it('says logged in and connecting when NapCat is back but the socket is not yet', () => {
    const connecting = headline(panel({ connection: { state: 'reconnecting', attempt: 2, selfId: null } }), NOW, t)
    expect(connecting).toMatchObject({ kind: 'connecting', tone: 'wait' })
    expect(connecting.detail).toContain('第 3 次')
    expect(connecting.detail).toContain('小号 (2153925085)')
  })

  it.each([
    ['napcat-down', 'napcat-down'],
    ['unreachable', 'door-down'],
    ['unauthorized', 'door-denied'],
    ['invalid', 'door-invalid'],
  ] as const)('names a %s door and how to bring it back', (door, kind) => {
    const verdict = headline(panel({ connection: { state: 'reconnecting', attempt: 5, selfId: null }, login: { door, state: null, uin: null, nickname: null } }), NOW, t)
    expect(verdict).toMatchObject({ kind, tone: 'bad' })
  })

  it('says the recorder is not running before anything else, and what to do', () => {
    const down = headline(panel({ connection: { state: 'recorder-down', attempt: 4, selfId: null, lastError: 'the recorder is not listening' }, login: { door: 'recorder-down', state: null, uin: null, nickname: null } }), NOW, t)
    expect(down).toMatchObject({ kind: 'recorder-down', tone: 'bad', text: 'QQ 记录器没有运行' })
    expect(down.detail).toContain('ams ctl restart qq-recorder')
    const mismatch = headline(panel({ connection: { state: 'protocol-mismatch', selfId: null } }), NOW, t)
    expect(mismatch).toMatchObject({ kind: 'protocol-mismatch', tone: 'bad' })
    expect(mismatch.detail).toContain('upgrade.sh')
  })

  it('shows the recorder states in the connection row, never a missing key', () => {
    for (const state of ['recorder-down', 'protocol-mismatch', 'unknown', 'starting', 'waiting-token'] as const) {
      const rows = detailRows(panel({ connection: { state, selfId: null, since: NOW - 60_000 }, login: { door: 'recorder-down', state: null, uin: null, nickname: null } }), NOW, t)
      expect(rows[0]!.value, state).not.toBe('')
      expect(rows[0]!.value, state).not.toContain('detail.connection')
    }
  })

  it('points at the secret when the token is missing, and falls back to the retry count when login is off', () => {
    expect(headline(panel({ connection: { state: 'waiting-token', selfId: null } }), NOW, t).kind).toBe('no-token')
    const off = headline(panel({ connection: { state: 'reconnecting', attempt: 7, since: NOW - 60_000, selfId: null }, login: { door: 'disabled', state: null, uin: null, nickname: null } }), NOW, t)
    expect(off).toMatchObject({ kind: 'disconnected', detail: '第 7 次重试 · 自 11:59 起' })
  })
})

describe('detail rows', () => {
  it('reports the connection, NapCat login, and groups; the last error only while down', () => {
    expect(detailRows(panel(), NOW, t).map(row => row.key)).toEqual(['connection', 'login', 'groups'])
    const down = detailRows(panel({ connection: { state: 'reconnecting', attempt: 9, lastError: 'socket hang up', since: new Date(2026, 9, 30, 12, 0, 0).getTime() }, login: { door: 'unreachable', state: null } }), NOW, t)
    expect(down.map(row => [row.key, row.value])).toEqual([
      ['connection', '重试中，第 9 次，自 10-30 12:00'],
      ['login', '读不到（扫码入口不可用）'],
      ['groups', '24 个'],
      ['error', 'socket hang up'],
    ])
    expect(down.at(-1)?.code).toBe(true)
  })
})

describe('formatting', () => {
  it('formats durations, clocks, and stamps', () => {
    expect([formatDuration(90, t), formatDuration(3700, t), formatDuration(200_000, t)]).toEqual(['1 分钟', '1 小时 1 分', '2 天 7 小时'])
    expect(clock(new Date(2026, 10, 1, 7, 5, 9).getTime())).toBe('07:05:09')
    expect(stamp(null, NOW, t)).toBe('—')
    expect(stamp(NOW - 60_000, NOW, t)).toBe('11:59')
  })

  it('keeps the same keys in every language', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    const placeholders = (text: string): string => (text.match(/\{\w+\}/g) ?? []).sort().join()
    for (const dictionary of [ja, es, fr, de, ru, pt]) {
      expect(Object.keys(dictionary).sort()).toEqual(Object.keys(zh).sort())
      for (const key of Object.keys(zh) as QqKey[]) expect(placeholders((dictionary as Record<QqKey, string>)[key]),
        key).toBe(placeholders(zh[key]))
    }
    for (const key of Object.keys(zh) as QqKey[]) expect(placeholders(en[key])).toBe(placeholders(zh[key]))
    for (const dictionary of [zh, en, ja, es, fr, de, ru, pt]) {
      for (const key of ['head.recorder-down', 'head.protocol-mismatch', 'detail.connection.recorder-down'] as const) expect((dictionary)[key]).not.toBe('')
    }
  })
})

describe('qrPath', () => {
  it('draws runs of dark modules inside a quiet zone', () => {
    expect(qrPath(QR)).toEqual({ viewBox: '0 0 7 7', d: 'M2 2h1v1h-1zM4 2h1v1h-1zM3 3h1v1h-1zM2 4h3v1h-3z' })
  })

  it.each([
    [{ size: 3, rows: ['101', '010'] }],
    [{ size: 2, rows: ['1x', '01'] }],
    [{ size: 0, rows: [] }],
    [{ size: 500, rows: [] }],
  ])('refuses a matrix that is not square 0/1: %j', (matrix) => {
    expect(qrPath(matrix)).toBeNull()
  })
})

describe('QqLoader', () => {
  it('publishes an answer with its time and shares one request between concurrent refreshes', async () => {
    const store = createQqStore()
    const read = vi.fn(() => Promise.resolve(panel()))
    const loader = new QqLoader(store, read, vi.fn(), () => 42)
    await Promise.all([loader.refresh(), loader.refresh()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ panel: panel(), checkedAt: 42, stale: false })
    await loader.refresh()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps the last answer through failures, marks it stale, and warns once per outage', async () => {
    const store = createQqStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const read = vi.fn<() => Promise<QqPanel>>().mockResolvedValueOnce(panel()).mockRejectedValue(new Error('down'))
    const loader = new QqLoader(store, read, vi.fn(), () => 1)
    await loader.refresh()
    await loader.refresh()
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ panel: panel(), stale: true })
    expect(warn).toHaveBeenCalledTimes(1)
    read.mockResolvedValue(panel({ connection: { attempt: 1 } }))
    await loader.refresh()
    expect(store.getSnapshot().stale).toBe(false)
  })

  it('asks for a fresh code once at a time, adopts the answer, and remembers a refusal', async () => {
    const store = createQqStore()
    let settle: (value: QqRefreshAnswer) => void = () => {}
    const renew = vi.fn(() => new Promise<QqRefreshAnswer>((resolve) => { settle = resolve }))
    const loader = new QqLoader(store, vi.fn(), renew, () => 5)
    const first = loader.renewCode()
    void loader.renewCode()
    expect(store.getSnapshot().codeRequested).toBe(true)
    expect(renew).toHaveBeenCalledTimes(1)
    settle({ ...panel({ login: { state: 'qr', qr: QR } }), refreshed: false, reason: 'too-soon' })
    await first
    expect(store.getSnapshot()).toMatchObject({ codeRequested: false, codeDeclined: true, checkedAt: 5 })
    expect(store.getSnapshot().panel?.login.qr).toEqual(QR)
  })

  it('treats a failed request for a fresh code as declined, not as a crash', async () => {
    const store = createQqStore()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = new QqLoader(store, vi.fn(), () => Promise.reject(new Error('no')), () => 5)
    await loader.renewCode()
    expect(store.getSnapshot()).toMatchObject({ codeRequested: false, codeDeclined: true, panel: null })
  })
})

describe('parsePanel', () => {
  it('accepts the Host shape and rejects anything else', () => {
    expect(parsePanel(panel())).toEqual(panel())
    for (const bad of [null, 'x', {}, { at: 1 }, { at: 1, connection: {}, login: null }]) expect(() => parsePanel(bad)).toThrow('unexpected QQ answer')
  })
})

describe('headline account naming', () => {
  it('shows a dash when neither the login nor the connection knows the account, and zero duration without a start time', () => {
    const unknown = headline(panel({ connection: { selfId: null, since: null }, login: { uin: null, nickname: null } }), NOW, t)
    expect(unknown).toMatchObject({ kind: 'connected' })
    expect(unknown.detail).toBe(`账号 — · 已连续在线 ${formatDuration(0, t)}`)
  })
})

describe('statusLine', () => {
  it('reads loading, live, stale, and failed', () => {
    const store = createQqStore()
    expect(statusLine(store.getSnapshot(), t).tone).toBe('loading')
    expect(statusLine({ ...store.getSnapshot(), stale: true }, t)).toMatchObject({ tone: 'stale', text: '暂时读不到 QQ 状态，稍后自动重试。' })
    expect(statusLine({ ...store.getSnapshot(), panel: panel() }, t).tone).toBe('live')
    expect(statusLine({ ...store.getSnapshot(), panel: panel(), stale: true }, t).tone).toBe('stale')
  })
})

/** A document double whose visibility the test flips. */
function page(initial: DocumentVisibilityState): VisibilitySource & { show: (state: DocumentVisibilityState) => void; listeners: number } {
  const listeners = new Set<() => void>()
  const doc = {
    visibilityState: initial,
    addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
    removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    show: (state: DocumentVisibilityState) => { doc.visibilityState = state; for (const listener of listeners) listener() },
    get listeners() { return listeners.size },
  }
  return doc
}

describe('startPolling', () => {
  it('refreshes at once and every interval, pauses while hidden, and stops cleanly', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const doc = page('visible')
    const stop = startPolling(refresh, POLL_INTERVAL_MS, doc)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 2)
    expect(refresh).toHaveBeenCalledTimes(3)
    doc.show('hidden')
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 5)
    expect(refresh).toHaveBeenCalledTimes(3)
    doc.show('visible')
    expect(refresh).toHaveBeenCalledTimes(4)
    stop()
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 5)
    expect(refresh).toHaveBeenCalledTimes(4)
    expect(doc.listeners).toBe(0)
  })

  it('polls every 3 seconds while something needs attention, and once a minute while connected', () => {
    expect(POLL_INTERVAL_MS).toBe(3000)
    expect(CALM_POLL_INTERVAL_MS).toBe(60_000)
  })

  it('asks for the next period after every refresh', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    let calm = false
    const stop = startPolling(refresh, () => (calm ? CALM_POLL_INTERVAL_MS : POLL_INTERVAL_MS), page('visible'))
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    calm = true
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(CALM_POLL_INTERVAL_MS - 1)
    expect(refresh).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledTimes(4)
    stop()
  })

  it('polls without a visibility source outside a browser', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const stop = startPolling(refresh, 1000)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(refresh).toHaveBeenCalledTimes(3)
    stop()
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(3)
  })

  it('does not refresh while the page starts hidden, and starts when it is shown', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const doc = page('hidden')
    const stop = startPolling(refresh, POLL_INTERVAL_MS, doc)
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3)
    expect(refresh).not.toHaveBeenCalled()
    doc.show('visible')
    expect(refresh).toHaveBeenCalledTimes(1)
    stop()
    expect(doc.listeners).toBe(0)
  })

  it('keeps one timer when the page is shown again while already polling', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const doc = page('visible')
    const stop = startPolling(refresh, POLL_INTERVAL_MS, doc)
    doc.show('visible')
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
  })
})
