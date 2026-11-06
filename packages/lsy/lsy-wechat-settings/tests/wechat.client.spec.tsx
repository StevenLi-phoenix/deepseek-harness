// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { maskId, type LoginSnapshot, type WechatAnswer, type WechatView } from '../src/wechat-view.ts'
import { agoText, dateTime, spanText, stampTime } from '../src/client/wechat/format.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/wechat/locales.ts'
import { isWeixinLink, qrPath, qrViewSize } from '../src/client/wechat/qr.ts'
import {
  LOGIN_POLL_INTERVAL_MS, POLL_INTERVAL_MS, WechatLoader, WechatRefused, createWechatStore, parseAnswer, startPolling, type WechatState,
} from '../src/client/wechat/wechat.ts'
import { WechatSection, type WechatProps } from '../src/client/wechat/WechatSection.tsx'

const t = makeTranslate(zh) as WechatProps['t']
const NOW = Date.parse('2026-11-01T16:00:00Z')

const VIEW: WechatView = {
  binding: { state: 'bound', botId: 'bot…23@im.bot', ownerId: 'own…56@im.wechat', boundAt: Date.parse('2026-10-21T00:00:00Z') },
  channel: { link: 'connected', lastPollAt: NOW - 20_000, failures: 0, lastError: null, lastInboundAt: NOW - 3_600_000, lastOutboundAt: NOW - 120_000, lastOutboundKind: 'reply' },
  window: { open: true, closed: null, repliesLeft: 7, repliesPerToken: 10, expiresAt: NOW + 21 * 3_600_000 },
  outbox: { count: 0, limit: 50, oldestAt: null },
  loginActive: false,
  timeZone: 'America/New_York',
}
const UNBOUND: WechatView = {
  ...VIEW,
  binding: { state: 'unbound' },
  channel: { link: 'idle', lastPollAt: null, failures: 0, lastError: null, lastInboundAt: null, lastOutboundAt: null, lastOutboundKind: null },
  window: { open: false, closed: 'no-account', repliesLeft: null, repliesPerToken: 10, expiresAt: null },
}

/** A 4x4 stand-in for a code: one dark module in each corner but the last. */
const QR = { url: 'https://liteapp.weixin.qq.com/q/1?qrcode=qr-1&bot_type=3', attempt: 1, size: 4, rows: ['1001', '0000', '0000', '1000'] }
const LOGIN: LoginSnapshot = { key: 'k1', phase: 'waiting', qr: QR, codeRetry: false, failure: null }

function mount(state: Partial<WechatState>) {
  const store = createWechatStore()
  store.update((draft) => { Object.assign(draft, state) })
  const calls = {
    refresh: vi.fn(),
    startLogin: vi.fn(),
    pollLogin: vi.fn(),
    submitCode: vi.fn(),
    cancelLogin: vi.fn(),
    dismissLogin: vi.fn(),
    unbind: vi.fn(),
  }
  const props = { close: () => {}, useWechat: bindSnapshotSelector(store), ...calls, t } as WechatProps
  const view = render(<WechatSection {...props} />)
  return { store, calls, view }
}

function answer(view: WechatView, login: LoginSnapshot | null = null): WechatAnswer {
  return { view, login }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WechatSection status', () => {
  it('shows a bound bot with masked ids, the long-poll, and the latest traffic', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mount({ view: VIEW, checkedAt: NOW })
    const hero = screen.getByRole('region', { name: '微信 bot' })
    expect(hero.textContent).toContain('已连接')
    expect(hero.textContent).toContain('bot bot…23@im.bot')
    expect(hero.textContent).toContain('主人 own…56@im.wechat')
    expect(hero.textContent).toContain('10-20 20:00 绑定')
    expect(hero.textContent).toContain('20 秒前有响应')
    expect(hero.textContent).toContain('1 小时前')
    expect(hero.textContent).toContain('2 分钟前（回复）')
    expect(within(hero).queryAllByRole('button')).toEqual([])
  })

  it('says what is wrong: retrying with the last error, an expired sign-in, an unreadable file, not bound', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const retrying = mount({ view: { ...VIEW, channel: { ...VIEW.channel, link: 'retrying', failures: 2, lastError: { at: NOW - 60_000, where: 'poll', text: 'iLink ilink/bot/getupdates: HTTP 502' } } }, checkedAt: NOW })
    let hero = screen.getByRole('region', { name: '微信 bot' })
    expect(hero.textContent).toContain('连接中断，正在重试')
    expect(hero.textContent).toContain('收消息：iLink ilink/bot/getupdates: HTTP 502 · 1 分钟前')
    retrying.view.unmount()
    mount({ view: { ...VIEW, channel: { ...VIEW.channel, link: 'stale' } }, checkedAt: NOW }).view.unmount()
    expect(screen.queryByText('登录已失效，需要重新绑定')).toBeNull()
    mount({ view: { ...VIEW, channel: { ...VIEW.channel, link: 'stale' } }, checkedAt: NOW })
    expect(screen.getByText('登录已失效，需要重新绑定')).toBeTruthy()
    cleanup()
    mount({ view: { ...VIEW, binding: { state: 'invalid', reason: 'not valid JSON' } }, checkedAt: NOW })
    hero = screen.getByRole('region', { name: '微信 bot' })
    expect(hero.textContent).toContain('账号文件读不了')
    expect(hero.textContent).toContain('原因：not valid JSON')
    cleanup()
    mount({ view: UNBOUND, checkedAt: NOW })
    hero = screen.getByRole('region', { name: '微信 bot' })
    expect(hero.textContent).toContain('未绑定')
    expect(hero.textContent).toContain('还没有绑定微信')
  })

  it('shows the reply window, why it is closed, and the queue behind it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mount({ view: { ...VIEW, outbox: { count: 3, limit: 50, oldestAt: NOW - 7_200_000 } }, checkedAt: NOW })
    let card = screen.getByRole('region', { name: '回复窗口' })
    expect(card.textContent).toContain('还能回 7 / 10 条')
    expect(card.textContent).toContain('21 小时后结束')
    expect(card.textContent).toContain('3 条在排队（最多 50 条） · 2 小时前排上的最早一条')
    cleanup()
    mount({ view: { ...VIEW, window: { ...VIEW.window, open: false, closed: 'used-up', repliesLeft: 0 } }, checkedAt: NOW })
    card = screen.getByRole('region', { name: '回复窗口' })
    expect(card.textContent).toContain('这个窗口的回复额度用完了')
    expect(card.textContent).toContain('没有排队的内容')
    cleanup()
    mount({ view: UNBOUND, checkedAt: NOW })
    expect(screen.getByRole('region', { name: '回复窗口' }).textContent).toContain('没有绑定账号，发不出去')
  })

  it('says when the status cannot be read, and polls while mounted', () => {
    const { calls } = mount({ view: null, stale: true, checkedAt: NOW })
    expect(calls.refresh).toHaveBeenCalled()
    expect(screen.getByText('暂时读不到微信状态，稍后自动重试。')).toBeTruthy()
  })
})

describe('WechatSection partial status', () => {
  it('says a bound bot has no bind time, long-poll answer, or traffic yet', () => {
    const quiet = { ...UNBOUND.channel, link: 'starting' as const }
    const binding = { state: 'bound' as const, botId: 'b…1@im.bot', ownerId: 'o…2@im.wechat', boundAt: null }
    mount({ view: { ...VIEW, binding, channel: quiet }, checkedAt: NOW })
    const hero = screen.getByRole('region', { name: '微信 bot' })
    expect(hero.textContent).toContain('bot b…1@im.bot · 主人 o…2@im.wechat')
    expect(hero.textContent).not.toContain('绑定')
    expect(hero.textContent).toContain('还没有响应')
    expect(within(hero).getAllByText('暂无')).toHaveLength(2)
  })

  it('shows a dash for traffic of an unknown kind, and which side a failure was on', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const channel = { ...VIEW.channel, lastOutboundKind: null, lastError: { at: NOW - 60_000, where: 'send' as const, text: 'HTTP 500' } }
    mount({ view: { ...VIEW, channel }, checkedAt: NOW })
    const hero = screen.getByRole('region', { name: '微信 bot' })
    expect(hero.textContent).toContain('2 分钟前（—）')
    expect(hero.textContent).toContain('发消息：HTTP 500 · 1 分钟前')
  })

  it('shows neither a count, an end, nor a reason for an open window without a record', () => {
    const window = { open: true, closed: null, repliesLeft: null, repliesPerToken: 10, expiresAt: null }
    mount({ view: { ...VIEW, window }, checkedAt: NOW })
    expect(screen.getByRole('region', { name: '回复窗口' }).textContent).toBe(`回复窗口${zh['window.hint']}${zh['outbox.empty']}`)
  })

  it('shows the queue without an age when the oldest entry has no time', () => {
    mount({ view: { ...VIEW, outbox: { count: 2, limit: 50, oldestAt: null } }, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '回复窗口' })
    expect(card.textContent).toContain('2 条在排队（最多 50 条）')
    expect(card.textContent).not.toContain('排上的最早一条')
  })

  it('says it is reading until the first answer, and draws no card', () => {
    mount({ view: null })
    expect(screen.getByText('正在读取…')).toBeTruthy()
    expect(screen.queryByRole('region', { name: '微信 bot' })).toBeNull()
  })

  it('dates the line from the last check, or from now before any check settled', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const checked = NOW - 3_600_000
    mount({ view: VIEW, stale: true, checkedAt: checked })
    expect(screen.getByText(`未能刷新 · 显示 ${stampTime(checked)} 的数据`)).toBeTruthy()
    cleanup()
    mount({ view: VIEW, stale: true, checkedAt: null })
    expect(screen.getByText(`未能刷新 · 显示 ${stampTime(NOW)} 的数据`)).toBeTruthy()
    cleanup()
    mount({ view: VIEW, checkedAt: null })
    expect(screen.getByText(`${stampTime(NOW)} 更新`)).toBeTruthy()
  })
})

describe('WechatSection bind', () => {
  it('offers a scan to an unbound bot and a rebind to a bound one, and shows no unbind until bound', () => {
    const unbound = mount({ view: UNBOUND, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '绑定' })
    fireEvent.click(within(card).getByRole('button', { name: '扫码绑定' }))
    expect(unbound.calls.startLogin).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('region', { name: '解绑' })).toBeNull()
    cleanup()
    const bound = mount({ view: VIEW, checkedAt: NOW })
    fireEvent.click(within(screen.getByRole('region', { name: '重新绑定' })).getByRole('button', { name: '重新扫码' }))
    expect(bound.calls.startLogin).toHaveBeenCalledTimes(1)
  })

  it('answers the click at once: the button reads busy and is disabled while the code is fetched', () => {
    mount({ view: UNBOUND, checkedAt: NOW, busy: 'login.start' })
    const button = within(screen.getByRole('region', { name: '绑定' })).getByRole('button', { name: '正在获取二维码…' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('draws the QR code from its rows, scannable on white, with the link as a fallback', () => {
    const { view } = mount({ view: UNBOUND, checkedAt: NOW, login: LOGIN })
    const panel = screen.getByRole('region', { name: '绑定' })
    const svg = within(panel).getByRole('img', { name: '微信登录二维码' })
    expect(svg.getAttribute('viewBox')).toBe('0 0 10 10')
    expect(svg.querySelector('path')?.getAttribute('d')).toBe('M3 3h1v1h-1zM6 3h1v1h-1zM3 6h1v1h-1z')
    expect(svg.querySelector('rect')?.getAttribute('fill')).toBe('#fff')
    expect(panel.textContent).toContain('用手机微信扫描这个二维码')
    expect(panel.textContent).toContain('第 1 张二维码')
    const link = within(panel).getByRole('link', { name: '扫不出来？用微信打开这个链接' })
    expect(link.getAttribute('href')).toBe(QR.url)
    expect(link.getAttribute('rel')).toContain('noopener')
    view.unmount()
    mount({ view: UNBOUND, checkedAt: NOW, login: { ...LOGIN, qr: { ...QR, url: 'javascript:alert(1)' } } })
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('tells a scan from a wait, and cancels', () => {
    const { calls } = mount({ view: UNBOUND, checkedAt: NOW, login: { ...LOGIN, phase: 'scanned' } })
    expect(screen.getByText('已扫码，请在手机微信上确认')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(calls.cancelLogin).toHaveBeenCalledTimes(1)
  })

  it('asks for the number WeChat shows: digits only, a retry note after a wrong one, cleared after sending', () => {
    const { calls, view } = mount({ view: UNBOUND, checkedAt: NOW, login: { ...LOGIN, phase: 'needs-code' } })
    const input = screen.getByRole('textbox')
    const submit = screen.getByRole('button', { name: '提交' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    expect(screen.getByText('输入手机微信上显示的数字。')).toBeTruthy()
    fireEvent.change(input, { target: { value: '12ab' } })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(submit.disabled).toBe(true)
    fireEvent.change(input, { target: { value: ' 4821 ' } })
    fireEvent.click(submit)
    expect(calls.submitCode).toHaveBeenCalledWith('4821')
    expect((input as HTMLInputElement).value).toBe('')
    view.unmount()
    mount({ view: UNBOUND, checkedAt: NOW, login: { ...LOGIN, phase: 'needs-code', codeRetry: true } })
    expect(screen.getByText('数字不对，再看一眼手机上的数字。')).toBeTruthy()
    cleanup()
    mount({ view: UNBOUND, checkedAt: NOW, login: { ...LOGIN, phase: 'needs-code' }, busy: 'login.code' })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '提交中…' }).disabled).toBe(true)
  })

  it('offers a new code after expiry and the reason after a failure', () => {
    const expired = mount({ view: UNBOUND, checkedAt: NOW, login: { ...LOGIN, phase: 'expired', qr: null } })
    expect(screen.getByText('二维码过期了')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '换一个新二维码' }))
    expect(expired.calls.startLogin).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(expired.calls.dismissLogin).toHaveBeenCalledTimes(1)
    cleanup()
    const failed = mount({ view: UNBOUND, checkedAt: NOW, login: { ...LOGIN, phase: 'failed', qr: null, failure: 'bound-elsewhere' } })
    expect(screen.getByRole('alert').textContent).toContain('已经绑在别处')
    fireEvent.click(screen.getByRole('button', { name: '再试一次' }))
    expect(failed.calls.startLogin).toHaveBeenCalledTimes(1)
    cleanup()
    mount({ view: UNBOUND, checkedAt: NOW, login: { ...LOGIN, phase: 'failed', qr: null, failure: null } })
    expect(screen.getByRole('alert').textContent).toContain('出了点问题')
  })

  it('sends no number by the Enter key while it is invalid or while one is in flight', () => {
    const idle = mount({ view: UNBOUND, checkedAt: NOW, login: { ...LOGIN, phase: 'needs-code' } })
    const input = screen.getByRole<HTMLInputElement>('textbox')
    fireEvent.submit(input.closest('form')!)
    fireEvent.change(input, { target: { value: '12ab' } })
    fireEvent.submit(input.closest('form')!)
    expect(idle.calls.submitCode).not.toHaveBeenCalled()
    expect(input.value).toBe('12ab')
    cleanup()
    const inFlight = mount({ view: UNBOUND, checkedAt: NOW, login: { ...LOGIN, phase: 'needs-code' }, busy: 'login.code' })
    const typed = screen.getByRole<HTMLInputElement>('textbox')
    fireEvent.change(typed, { target: { value: '4821' } })
    fireEvent.submit(typed.closest('form')!)
    expect(inFlight.calls.submitCode).not.toHaveBeenCalled()
    expect(typed.value).toBe('4821')
  })

  it('answers the retry at once in the expired and the failed panels', () => {
    mount({ view: UNBOUND, checkedAt: NOW, busy: 'login.start', login: { ...LOGIN, phase: 'expired', qr: null } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在获取二维码…' }).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '换一个新二维码' })).toBeNull()
    cleanup()
    mount({ view: UNBOUND, checkedAt: NOW, busy: 'login.start', login: { ...LOGIN, phase: 'failed', qr: null, failure: 'timeout' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在获取二维码…' }).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '再试一次' })).toBeNull()
  })

  it('shows an open login that has no code yet without a drawing, an attempt, or a link', () => {
    mount({ view: UNBOUND, checkedAt: NOW, login: { ...LOGIN, qr: null } })
    expect(screen.getByText('用手机微信扫描这个二维码')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.queryByText('第 1 张二维码')).toBeNull()
  })

  it('confirms a finished bind', () => {
    const { calls } = mount({ view: VIEW, checkedAt: NOW, login: { ...LOGIN, phase: 'done', qr: null } })
    expect(screen.getByText('绑定成功')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '好' }))
    expect(calls.dismissLogin).toHaveBeenCalledTimes(1)
  })

  it('polls an open login every 2 s, and stops once it is over', () => {
    vi.useFakeTimers()
    const { calls, store } = mount({ view: UNBOUND, checkedAt: NOW, login: LOGIN })
    expect(calls.pollLogin).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(LOGIN_POLL_INTERVAL_MS * 2)
    expect(calls.pollLogin).toHaveBeenCalledTimes(3)
    act(() => { store.update((draft) => { draft.login = { ...LOGIN, phase: 'done', qr: null } }) })
    vi.advanceTimersByTime(LOGIN_POLL_INTERVAL_MS * 3)
    expect(calls.pollLogin).toHaveBeenCalledTimes(3)
  })
})

describe('WechatSection unbind', () => {
  it('needs two clicks, can be called off, and shows progress', () => {
    const { calls, view } = mount({ view: VIEW, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '解绑' })
    fireEvent.click(within(card).getByRole('button', { name: '解绑…' }))
    expect(calls.unbind).not.toHaveBeenCalled()
    expect(card.textContent).toContain('确定要解绑吗？')
    fireEvent.click(within(card).getByRole('button', { name: '先不解' }))
    expect(within(card).queryByRole('button', { name: '确认解绑' })).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: '解绑…' }))
    fireEvent.click(within(card).getByRole('button', { name: '确认解绑' }))
    expect(calls.unbind).toHaveBeenCalledTimes(1)
    view.unmount()
    mount({ view: VIEW, checkedAt: NOW, busy: 'unbind' })
    const busy = within(screen.getByRole('region', { name: '解绑' })).getByRole('button', { name: '正在解绑…' })
    expect((busy as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a failed action', () => {
    mount({ view: VIEW, checkedAt: NOW, error: 'the account file could not be moved' })
    expect(screen.getByRole('alert').textContent).toBe('操作没有完成：the account file could not be moved')
  })
})

describe('WechatLoader', () => {
  function loader(overrides: { read?: () => Promise<WechatAnswer>; post?: (action: unknown) => Promise<WechatAnswer> } = {}) {
    const store = createWechatStore()
    const read = vi.fn(overrides.read ?? (() => Promise.resolve(answer(VIEW))))
    const post = vi.fn(overrides.post ?? (() => Promise.resolve(answer(VIEW))))
    return { store, read, post, loader: new WechatLoader(store, read, post, () => 42) }
  }

  it('shares one read and keeps the last view through failures', async () => {
    const { store, read, loader: l } = loader()
    await Promise.all([l.refresh(), l.refresh()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, checkedAt: 42, stale: false })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    read.mockRejectedValueOnce(new Error('offline'))
    await l.refresh()
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, stale: true })
  })

  it('starts a login: busy at once, then the first code', async () => {
    const { store, post, loader: l } = loader({ post: () => Promise.resolve(answer({ ...UNBOUND, loginActive: true }, LOGIN)) })
    const pending = l.startLogin()
    expect(store.getSnapshot().busy).toBe('login.start')
    await pending
    expect(post).toHaveBeenCalledWith({ action: 'login.start' })
    expect(store.getSnapshot()).toMatchObject({ busy: null, error: null, login: LOGIN, view: { loginActive: true } })
  })

  it('polls the open login with its key, adopts the new phase and view, and ignores an answer for another login', async () => {
    const { store, post, loader: l } = loader()
    store.update((draft) => { draft.login = LOGIN })
    post.mockResolvedValueOnce(answer(VIEW, { ...LOGIN, phase: 'done', qr: null }))
    await l.pollLogin()
    expect(post).toHaveBeenCalledWith({ action: 'login.poll', key: 'k1' })
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, login: { phase: 'done' }, busy: null })
    // A login that is over is not polled again.
    await l.pollLogin()
    expect(post).toHaveBeenCalledTimes(1)

    store.update((draft) => { draft.login = LOGIN })
    post.mockImplementationOnce(async () => {
      store.update((draft) => { draft.login = { ...LOGIN, key: 'k2' } })
      return answer(VIEW, { ...LOGIN, phase: 'scanned' })
    })
    await l.pollLogin()
    expect(store.getSnapshot().login).toMatchObject({ key: 'k2', phase: 'waiting' })
  })

  it('closes the panel of a login the Host forgot, and keeps it through a transport failure', async () => {
    const { store, post, loader: l } = loader()
    store.update((draft) => { draft.login = LOGIN })
    post.mockRejectedValueOnce(new TypeError('offline'))
    await l.pollLogin()
    expect(store.getSnapshot().login).toEqual(LOGIN)
    post.mockRejectedValueOnce(new WechatRefused('that login is gone', 404))
    await l.pollLogin()
    expect(store.getSnapshot().login).toBeNull()
  })

  it('submits the number, cancels, dismisses, and unbinds', async () => {
    const { store, post, loader: l } = loader()
    store.update((draft) => { draft.login = { ...LOGIN, phase: 'needs-code' } })
    post.mockResolvedValueOnce(answer(VIEW, { ...LOGIN, phase: 'scanned' }))
    await l.submitCode('4821')
    expect(post).toHaveBeenLastCalledWith({ action: 'login.code', key: 'k1', code: '4821' })
    expect(store.getSnapshot().login?.phase).toBe('scanned')
    post.mockRejectedValueOnce(new WechatRefused('the login is not asking for a number', 409))
    await l.submitCode('1')
    expect(store.getSnapshot().error).toBe('the login is not asking for a number')

    await l.cancelLogin()
    expect(post).toHaveBeenLastCalledWith({ action: 'login.cancel', key: 'k1' })
    expect(store.getSnapshot()).toMatchObject({ login: null, error: null })
    store.update((draft) => { draft.login = { ...LOGIN, phase: 'failed', qr: null, failure: 'timeout' } })
    const calls = post.mock.calls.length
    await l.cancelLogin()
    expect(post).toHaveBeenCalledTimes(calls)

    store.update((draft) => { draft.login = { ...LOGIN, phase: 'expired', qr: null } })
    l.dismissLogin()
    expect(store.getSnapshot().login).toBeNull()

    post.mockResolvedValueOnce(answer(UNBOUND))
    const pending = l.unbind()
    expect(store.getSnapshot().busy).toBe('unbind')
    await pending
    expect(post).toHaveBeenLastCalledWith({ action: 'unbind', confirm: 'unbind' })
    expect(store.getSnapshot()).toMatchObject({ view: { binding: { state: 'unbound' } }, busy: null })
  })

  it('turns a refused action into a visible error and frees the buttons', async () => {
    const { store, loader: l } = loader({ post: () => Promise.reject(new WechatRefused('no bot is bound', 409)) })
    await l.unbind()
    expect(store.getSnapshot()).toMatchObject({ busy: null, error: 'no bot is bound' })
    await l.startLogin()
    expect(store.getSnapshot()).toMatchObject({ busy: null, error: 'no bot is bound', login: null })
  })
})

describe('WechatLoader edges', () => {
  function edges(post: (action: unknown) => Promise<WechatAnswer> = () => Promise.resolve(answer(VIEW))) {
    const store = createWechatStore()
    const read = vi.fn(() => Promise.resolve(answer(VIEW)))
    const posted = vi.fn(post)
    return { store, read, post: posted, loader: new WechatLoader(store, read, posted, () => 42) }
  }

  it('warns once when the view goes stale, and again only after it recovered', async () => {
    const { store, read, loader } = edges()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    read.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    await loader.refresh()
    await loader.refresh()
    expect(store.getSnapshot().stale).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[lsy-wechat] status read failed')
    await loader.refresh()
    expect(store.getSnapshot().stale).toBe(false)
    read.mockRejectedValueOnce(new Error('offline'))
    await loader.refresh()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('sends no number when the panel has closed', async () => {
    const { store, post, loader } = edges()
    await loader.submitCode('4821')
    expect(post).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toMatchObject({ busy: null, error: null })
  })

  it('shows a rejection that is not an Error as its text', async () => {
    const { store, loader } = edges(async () => { throw 'gateway said no' })
    await loader.unbind()
    expect(store.getSnapshot()).toMatchObject({ busy: null, error: 'gateway said no' })
  })

  it('keeps the panel of a newer login when the Host forgot the old one', async () => {
    const { store, post, loader } = edges()
    store.update((draft) => { draft.login = LOGIN })
    post.mockImplementationOnce(async () => {
      store.update((draft) => { draft.login = { ...LOGIN, key: 'k2' } })
      throw new WechatRefused('that login is gone', 404)
    })
    await loader.pollLogin()
    expect(store.getSnapshot().login?.key).toBe('k2')
  })
})

describe('client helpers', () => {
  it('checks the answer fields', () => {
    expect(() => parseAnswer({})).toThrow('unexpected WeChat answer')
    expect(() => parseAnswer(null)).toThrow('unexpected WeChat answer')
    expect(() => parseAnswer('not an object')).toThrow('unexpected WeChat answer')
    expect(() => parseAnswer({ view: { ...VIEW, outbox: null }, login: null })).toThrow('unexpected WeChat answer')
    expect(() => parseAnswer({ view: VIEW, login: { phase: 'waiting' } })).toThrow('unexpected WeChat answer')
    const ok = answer(VIEW, LOGIN)
    expect(parseAnswer(ok)).toBe(ok)
  })

  it('writes one rectangle per run of dark modules inside the quiet zone', () => {
    expect(qrViewSize(QR)).toBe(10)
    expect(qrPath({ ...QR, size: 5, rows: ['11011', '00000', '00000', '00000', '10001'] })).toBe('M3 3h2v1h-2zM6 3h2v1h-2zM3 7h1v1h-1zM7 7h1v1h-1z')
  })

  it('offers only HTTPS links on WeChat domains', () => {
    expect(isWeixinLink('https://liteapp.weixin.qq.com/q/1')).toBe(true)
    expect(isWeixinLink('https://weixin.qq.com/x')).toBe(true)
    expect(isWeixinLink('http://liteapp.weixin.qq.com/q/1')).toBe(false)
    expect(isWeixinLink('https://weixin.qq.com.evil.example/x')).toBe(false)
    expect(isWeixinLink('javascript:alert(1)')).toBe(false)
    expect(isWeixinLink('not a url')).toBe(false)
  })

  it('formats times in the largest whole unit', () => {
    expect(agoText(NOW - 2000, NOW, t as never)).toBe('刚刚')
    expect(agoText(NOW - 30_000, NOW, t as never)).toBe('30 秒前')
    expect(agoText(NOW - 3 * 86_400_000, NOW, t as never)).toBe('3 天前')
    expect(spanText(NOW + 30_000, NOW, t as never)).toBe('不到 1 分钟')
    expect(spanText(NOW + 45 * 60_000, NOW, t as never)).toBe('45 分钟')
    expect(spanText(NOW + 5 * 3_600_000, NOW, t as never)).toBe('5 小时')
    expect(spanText(NOW + 4 * 86_400_000, NOW, t as never)).toBe('4 天')
  })

  it('dates an instant in the zone it is given, and in the local zone without one', () => {
    expect(dateTime(NOW, 'America/New_York')).toBe('11-01 11:00')
    const local = new Date(NOW)
    const pad = (value: number): string => String(value).padStart(2, '0')
    expect(dateTime(NOW)).toBe(`${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`)
  })

  it('leaves a part blank when the formatter does not give it', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([{ type: 'month', value: '11' }])
    expect(dateTime(NOW, 'America/New_York')).toBe('11- :')
  })

  it('masks an id down to its ends and keeps the domain after the last @', () => {
    expect(maskId('o9cabcdefx1f@im.wechat')).toBe('o9c…1f@im.wechat')
    expect(maskId('a@b@im.bot')).toBe('a…@im.bot')
    expect(maskId('abcdef@im.bot')).toBe('a…@im.bot')
    expect(maskId('abcdefg')).toBe('abc…fg')
    expect(maskId('😀😁😂😃😄😅😆')).toBe('😀😁😂…😅😆')
    expect(maskId('@im.bot')).toBe('…@im.bot')
    expect(maskId('')).toBe('…')
  })

  it('keeps every dictionary on the same keys and placeholders', () => {
    const keys = Object.keys(zh).sort()
    const holes = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]!).sort()
    const source: Record<string, string> = zh
    for (const dictionary of [en, ja, es, fr, de, ru, pt] as Array<Record<string, string>>) {
      expect(Object.keys(dictionary).sort()).toEqual(keys)
      for (const [key, text] of Object.entries(dictionary)) expect(holes(text), key).toEqual(holes(source[key] ?? ''))
    }
  })

  it('polls now and every period while visible, pauses while hidden, and refreshes when shown again', () => {
    vi.useFakeTimers()
    const listeners = new Set<() => void>()
    const page = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    }
    const refresh = vi.fn()
    const stop = startPolling(refresh, POLL_INTERVAL_MS, page)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    page.visibilityState = 'hidden'
    for (const listener of listeners) listener()
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3)
    expect(refresh).toHaveBeenCalledTimes(2)
    page.visibilityState = 'visible'
    for (const listener of listeners) listener()
    expect(refresh).toHaveBeenCalledTimes(3)
    stop()
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3)
    expect(refresh).toHaveBeenCalledTimes(3)
    expect(listeners.size).toBe(0)
  })

  it('stays paused on a page that starts hidden, and keeps one timer through repeated events', () => {
    vi.useFakeTimers()
    const listeners = new Set<() => void>()
    const page = {
      visibilityState: 'hidden' as DocumentVisibilityState,
      addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    }
    const refresh = vi.fn()
    const stop = startPolling(refresh, POLL_INTERVAL_MS, page)
    for (const listener of listeners) listener()
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(refresh).not.toHaveBeenCalled()
    page.visibilityState = 'visible'
    for (const listener of listeners) listener()
    for (const listener of listeners) listener()
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(POLL_INTERVAL_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
  })
})
