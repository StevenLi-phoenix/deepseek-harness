// @vitest-environment jsdom

import { act as reactAct, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { BiliAction, BiliView, LoginView, ManagedAccount } from '../src/view.ts'
import { BiliLoader, RouteError, createBiliStore, parseView, type BiliState } from '../src/client/bili.ts'
import { BiliAccountSection, type BiliAccountProps } from '../src/client/BiliAccount.tsx'
import { agoText, countdown, qrPath } from '../src/client/format.ts'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as BiliAccountProps['t']
const NOW = Date.parse('2026-10-31T18:00:00Z')

const MAODENG: ManagedAccount = {
  id: 'maodeng', mid: 1_000_001, display: '猫灯魔女岚栖', session: 'ok', refreshMode: 'external', login: false, agent: false,
  refreshedAt: NOW - 3_600_000, importedAt: null, deadReason: null,
}
const MAOMAO: ManagedAccount = {
  id: 'maomao', mid: 3_000_001, display: '魔女的猫猫', session: 'dead', refreshMode: 'owner', login: true, agent: true,
  refreshedAt: NOW - 86_400_000, importedAt: NOW - 5 * 86_400_000, deadReason: '-101 not logged in',
}

const VIEW: BiliView = {
  account: { account: 'maomao', session: 'dead', mid: 3_000_001, uname: '魔女的猫猫', checkedAt: NOW - 60_000 },
  gate: { mode: 'auto', readonly: false, brake: null, used: { comment: 2, dm: 7 }, caps: { comment: 5, dm: 20 } },
  accounts: [MAODENG, MAOMAO],
  speaker: { id: 'maomao', display: '魔女的猫猫' },
  ledger: {
    rows: [
      { ts: NOW - 60_000, kind: 'dm', target: '200000001', state: 'sent', reason: '', caller: 'bili', draft: '在的 <b>x</b>', verdict: 'ok' },
      { ts: NOW - 120_000, kind: 'comment', target: 'BV1aa4y1X7aa', state: 'held', reason: 'cap', caller: 'up', draft: '', verdict: '' },
    ],
    summary: { total: 2 },
  },
  logins: [],
  manage: true,
  manageEnv: 'BILI_SVC_TOKEN_MANAGE',
  manageError: null,
  result: null,
  ownerMid: 200000001,
  ownerUpdatedAt: null,
  timeZone: 'America/New_York',
}

function login(patch: Partial<LoginView> = {}): LoginView {
  return { account: 'maomao', state: 'waiting', qr: ['0000', '0110', '0110', '0000'], expiresAt: NOW + 150_000, message: null, ...patch }
}

function mount(state: Partial<BiliState>) {
  const store = createBiliStore()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const actions: BiliAction[] = []
  const polls: BiliAction[] = []
  const props = {
    close: () => {}, useBili: bindSnapshotSelector(store), refresh,
    act: (action: BiliAction): void => { actions.push(action) },
    poll: (action: BiliAction): void => { polls.push(action) },
    t,
  } as BiliAccountProps
  const view = render(<BiliAccountSection {...props} />)
  return { store, refresh, actions, polls, view }
}

const card = (name: string): HTMLElement => screen.getByRole('region', { name })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('account cards', () => {
  it('shows every account with its state, who renews it, and when', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mount({ view: VIEW, checkedAt: NOW })
    const mao = card('魔女的猫猫')
    expect(mao.textContent).toContain('登录失效')
    expect(mao.textContent).toContain('智能体的号')
    expect(mao.textContent).toContain('UID 3000001')
    expect(mao.textContent).toContain('1 天前'.replace('1 天前', '24 小时前'))
    expect(mao.textContent).toContain('bili-svc 负责登录并自动续期这个号')
    expect(mao.textContent).toContain('失效原因：-101 not logged in')
    const deng = card('猫灯魔女岚栖')
    expect(deng.textContent).toContain('在线')
    expect(deng.textContent).toContain('这个号的会话由别的服务保管')
    // An account another service owns has no write control at all.
    expect(within(deng).queryAllByRole('button')).toEqual([])
    expect(within(mao).getAllByRole('button').map(button => button.textContent)).toEqual(['扫码登录', '刷新会话', '检查', '退出登录'])
  })

  it('sends each control\'s action, and asks twice before signing out', () => {
    const { actions } = mount({ view: VIEW, checkedAt: NOW })
    const mao = card('魔女的猫猫')
    fireEvent.click(within(mao).getByRole('button', { name: '扫码登录' }))
    fireEvent.click(within(mao).getByRole('button', { name: '刷新会话' }))
    fireEvent.click(within(mao).getByRole('button', { name: '检查' }))
    expect(actions).toEqual([
      { action: 'login.start', account: 'maomao' }, { action: 'session.refresh', account: 'maomao' }, { action: 'session.check', account: 'maomao' },
    ])
    fireEvent.click(within(mao).getByRole('button', { name: '退出登录' }))
    expect(actions).toHaveLength(3)
    fireEvent.click(within(mao).getByRole('button', { name: '取消' }))
    expect(within(mao).queryByRole('button', { name: /确认退出/ })).toBeNull()
    fireEvent.click(within(mao).getByRole('button', { name: '退出登录' }))
    fireEvent.click(within(mao).getByRole('button', { name: '确认退出 魔女的猫猫' }))
    expect(actions.at(-1)).toEqual({ action: 'logout', account: 'maomao', confirm: 'maomao' })
  })

  it('marks the clicked control busy at once and disables the others', () => {
    mount({ view: VIEW, checkedAt: NOW, busy: { action: 'session.refresh', account: 'maomao' } })
    const mao = card('魔女的猫猫')
    const refresh = within(mao).getByRole('button', { name: '刷新中…' })
    expect(refresh.getAttribute('aria-busy')).toBe('true')
    for (const button of within(mao).getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows no controls, and names the credential, without the manage token', () => {
    mount({ view: { ...VIEW, manage: false, ledger: null, accounts: [{ ...MAOMAO, refreshMode: null, login: false }] }, checkedAt: NOW })
    expect(within(card('魔女的猫猫')).queryAllByRole('button')).toEqual([])
    expect(screen.getByText(/BILI_SVC_TOKEN_MANAGE/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /解除急停|切到/ })).toBeNull()
    expect(screen.queryByText('最近动作')).toBeNull()
  })

  it('says why the controls are missing when bili-svc refused the token', () => {
    mount({ view: { ...VIEW, manage: false, manageError: 'status: unauthorized' }, checkedAt: NOW })
    expect(screen.getByText(/没有接受管理令牌，或没有回应（status: unauthorized）/)).toBeTruthy()
  })
})

describe('QR sign-in', () => {
  it('shows the code with its state and countdown, and closes it on request', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { actions } = mount({ view: { ...VIEW, logins: [login()] }, checkedAt: NOW })
    const panel = screen.getByRole('group', { name: '用 B站 App 扫码登录 魔女的猫猫' })
    expect(within(panel).getByRole('img', { name: '登录二维码' })).toBeTruthy()
    expect(panel.textContent).toContain('等待扫码…')
    expect(panel.textContent).toContain('2:30 后过期')
    // A waiting code offers no retry.
    expect(within(panel).queryByRole('button', { name: '重新获取' })).toBeNull()
    fireEvent.click(within(panel).getByRole('button', { name: '关闭' }))
    expect(actions).toEqual([{ action: 'login.cancel', account: 'maomao' }])
  })

  it('polls every two seconds while a code waits, and stops when it settles', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const { polls, store } = mount({ view: { ...VIEW, logins: [login({ state: 'scanned' })] }, checkedAt: NOW })
    expect(screen.getByRole('group', { name: /扫码登录/ }).textContent).toContain('已扫码，请在手机上点确认。')
    expect(polls).toEqual([{ action: 'login.poll', account: 'maomao' }])
    reactAct(() => { vi.advanceTimersByTime(4000) })
    expect(polls.length).toBeGreaterThanOrEqual(3)
    const before = polls.length
    reactAct(() => { store.update((draft) => { draft.view = { ...VIEW, logins: [login({ state: 'done', qr: null })] } }) })
    expect(screen.getByRole('group', { name: /扫码登录/ }).textContent).toContain('登录成功。')
    reactAct(() => { vi.advanceTimersByTime(6000) })
    expect(polls.length).toBe(before)
  })

  it('offers a new code after expiry or failure, with bili-svc\'s words', () => {
    const { actions, view } = mount({ view: { ...VIEW, logins: [login({ state: 'expired', qr: null })] }, checkedAt: NOW })
    expect(screen.getByRole('group', { name: /扫码登录/ }).textContent).toContain('二维码已过期。')
    fireEvent.click(screen.getByRole('button', { name: '重新获取' }))
    expect(actions).toEqual([{ action: 'login.start', account: 'maomao' }])
    view.unmount()
    mount({ view: { ...VIEW, logins: [login({ state: 'failed', qr: null, message: 'risk control' })] }, checkedAt: NOW })
    expect(screen.getByRole('group', { name: /扫码登录/ }).textContent).toContain('登录没有成功：risk control')
  })
})

describe('gate', () => {
  it('shows the mode, counters, and a one-click switch to read-only', () => {
    const { actions } = mount({ view: VIEW, checkedAt: NOW })
    const gate = card('操作闸门')
    expect(gate.textContent).toContain('放行中')
    expect(gate.textContent).toContain('模式：自动')
    expect(gate.textContent).toContain('今日已用：评论 2/5，私信 7/20')
    fireEvent.click(within(gate).getByRole('button', { name: '切到只读' }))
    expect(actions).toEqual([{ action: 'gate.mode', mode: 'readonly' }])
  })

  it('asks for confirmation before switching to automatic', () => {
    const readonly = { ...VIEW, gate: { ...VIEW.gate!, mode: 'readonly', readonly: true } }
    const { actions } = mount({ view: readonly, checkedAt: NOW })
    const gate = card('操作闸门')
    expect(gate.textContent).toContain('已暂停')
    fireEvent.click(within(gate).getByRole('button', { name: '切到自动' }))
    expect(actions).toEqual([])
    // The confirmation says who will speak in public and what it covers; the counters stay on the card above it.
    expect(within(gate).getByRole('note').textContent).toBe('切到自动后，会以「魔女的猫猫」的名义公开回复：在创作者视频下回评论，也回私信，受今日额度限制（用量见上面）。确认开始吗？')
    expect(gate.textContent).toContain('今日已用：评论 2/5，私信 7/20')
    fireEvent.click(within(gate).getByRole('button', { name: '取消' }))
    expect(within(gate).queryByRole('button', { name: '确认切到自动' })).toBeNull()
    fireEvent.click(within(gate).getByRole('button', { name: '切到自动' }))
    fireEvent.click(within(gate).getByRole('button', { name: '确认切到自动' }))
    expect(actions).toEqual([{ action: 'gate.mode', mode: 'auto' }])
  })

  it('shows the brake with its reason, releases it, and keeps automatic off until then', () => {
    const braked = { ...VIEW, gate: { ...VIEW.gate!, mode: 'readonly', readonly: true, brake: { reason: 'risk_352', detail: 'Bilibili answered -352', ts: NOW - 120_000 } } }
    const { actions } = mount({ view: braked, checkedAt: NOW })
    const gate = card('操作闸门')
    expect(gate.textContent).toContain('已急停：risk_352')
    expect(gate.textContent).toContain('Bilibili answered -352')
    expect(within(gate).getByRole<HTMLButtonElement>('button', { name: '切到自动' }).disabled).toBe(true)
    fireEvent.click(within(gate).getByRole('button', { name: '先解除急停' }))
    expect(actions).toEqual([{ action: 'brake.release' }])
  })

  it('says when the gate cannot be read', () => {
    mount({ view: { ...VIEW, gate: null }, checkedAt: NOW })
    expect(screen.getByText('读不到闸门状态。')).toBeTruthy()
  })
})

describe('reopening the Reply Gate', () => {
  const READONLY = { ...VIEW, gate: { ...VIEW.gate!, mode: 'readonly', readonly: true } }
  const BRAKE = { reason: 'risk_352', detail: 'Bilibili answered -352', ts: NOW - 120_000 }

  it('without a brake: one switch, one confirmation that names the speaker, and one click back to read-only', () => {
    const { actions, store } = mount({ view: READONLY, checkedAt: NOW })
    const gate = card('操作闸门')
    expect(within(gate).queryByRole('button', { name: '先解除急停' })).toBeNull()
    fireEvent.click(within(gate).getByRole('button', { name: '切到自动' }))
    fireEvent.click(within(gate).getByRole('button', { name: '确认切到自动' }))
    expect(actions).toEqual([{ action: 'gate.mode', mode: 'auto' }])
    // The Host answers with the new state; the card shows it and offers the one-click stop.
    reactAct(() => { store.update((draft) => { draft.view = VIEW }) })
    expect(gate.textContent).toContain('模式：自动')
    fireEvent.click(within(gate).getByRole('button', { name: '切到只读' }))
    expect(actions.at(-1)).toEqual({ action: 'gate.mode', mode: 'readonly' })
    expect(within(gate).queryByRole('note')).toBeNull()
  })

  it('with a brake: switching is off until it is released, then the same confirmation follows', () => {
    const { actions, store } = mount({ view: { ...READONLY, gate: { ...READONLY.gate!, brake: BRAKE } }, checkedAt: NOW })
    const gate = card('操作闸门')
    expect(gate.textContent).toContain('已急停：risk_352')
    expect(gate.textContent).toContain('急停还没解除：先解除急停，再切到自动。')
    const toAuto = within(gate).getByRole<HTMLButtonElement>('button', { name: '切到自动' })
    expect(toAuto.disabled).toBe(true)
    fireEvent.click(toAuto)
    expect(within(gate).queryByRole('button', { name: '确认切到自动' })).toBeNull()
    fireEvent.click(within(gate).getByRole('button', { name: '先解除急停' }))
    expect(actions).toEqual([{ action: 'brake.release' }])
    reactAct(() => { store.update((draft) => { draft.view = READONLY }) })
    expect(within(gate).queryByRole('button', { name: '先解除急停' })).toBeNull()
    fireEvent.click(within(gate).getByRole<HTMLButtonElement>('button', { name: '切到自动' }))
    fireEvent.click(within(gate).getByRole('button', { name: '确认切到自动' }))
    expect(actions).toEqual([{ action: 'brake.release' }, { action: 'gate.mode', mode: 'auto' }])
  })

  it('falls back to a plain name when the speaker is unknown, and shows bili-svc\'s refusal inside the card, not above it', () => {
    const { view } = mount({ view: { ...READONLY, speaker: null }, checkedAt: NOW })
    fireEvent.click(within(card('操作闸门')).getByRole('button', { name: '切到自动' }))
    expect(within(card('操作闸门')).getByRole('note').textContent).toContain('「智能体的账号」')
    view.unmount()
    mount({ view: READONLY, checkedAt: NOW, error: 'the brake is set (risk_352); release it first', errorCode: 'mode_refused' })
    const gate = card('操作闸门')
    expect(within(gate).getByRole('alert').textContent).toBe('急停还没解除，不能切到自动。the brake is set (risk_352); release it first')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
})

describe('ledger', () => {
  it('is collapsed, shows rows as plain text, and loads more on request', () => {
    const { actions } = mount({ view: VIEW, checkedAt: NOW, ledgerLimit: 2 })
    const ledger = screen.getByText('最近动作').closest('details')!
    expect(ledger.hasAttribute('open')).toBe(false)
    expect(ledger.textContent).toContain('2 条')
    // Draft text with markup stays text.
    expect(ledger.textContent).toContain('在的 <b>x</b>')
    expect(ledger.querySelector('b')).toBeNull()
    expect(ledger.textContent).toContain('total 2')
    fireEvent.click(within(ledger).getByRole('button', { name: '再看更多' }))
    expect(actions).toEqual([{ action: 'ledger', limit: 32 }])
  })

  it('offers no more rows when the Host returned fewer than asked, and says when the log is unavailable', () => {
    const { view } = mount({ view: VIEW, checkedAt: NOW })
    expect(screen.queryByRole('button', { name: '再看更多' })).toBeNull()
    view.unmount()
    mount({ view: { ...VIEW, ledger: null }, checkedAt: NOW })
    expect(screen.getByText('暂时读不到动作记录。')).toBeTruthy()
  })
})

describe('feedback', () => {
  it('says what an action did for a few seconds, and explains known failures', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const refreshed = { action: 'session.refresh', account: 'maomao', outcome: 'refreshed', days: null } as const
    const { view } = mount({ view: VIEW, checkedAt: NOW, result: { value: refreshed, at: NOW - 1000 } })
    expect(screen.getByText('已刷新 maomao 的会话。')).toBeTruthy()
    view.unmount()
    mount({ view: VIEW, checkedAt: NOW, result: { value: refreshed, at: NOW - 7000 } })
    expect(screen.queryByText('已刷新 maomao 的会话。')).toBeNull()
    cleanup()
    const checked = { action: 'session.check', account: 'maomao', outcome: 'valid', days: 23 } as const
    mount({ view: VIEW, checkedAt: NOW, result: { value: checked, at: NOW - 1000 } })
    expect(screen.getByText('maomao 的会话有效，约 23 天后到期。')).toBeTruthy()
    cleanup()
    mount({ view: VIEW, checkedAt: NOW, result: { value: { ...checked, outcome: 'invalid', days: null }, at: NOW - 1000 } })
    expect(screen.getByText('maomao 的会话已失效，需要重新登录。')).toBeTruthy()
    cleanup()
    mount({ view: VIEW, checkedAt: NOW, error: 'no_session', errorCode: 'no_session' })
    expect(screen.getByRole('alert').textContent).toBe('这个号现在没有会话，先扫码登录。')
    cleanup()
    mount({ view: VIEW, checkedAt: NOW, error: 'the brake is set', errorCode: 'mode_refused' })
    // Inside the gate card, with bili-svc's own words.
    expect(within(card('操作闸门')).getByRole('alert').textContent).toBe('急停还没解除，不能切到自动。the brake is set')
    cleanup()
    mount({ view: VIEW, checkedAt: NOW, error: 'Bilibili refused the refresh token', errorCode: 'refresh_failed' })
    expect(screen.getByRole('alert').textContent).toBe('刷新没有成功：Bilibili refused the refresh token')
    cleanup()
    mount({ view: VIEW, checkedAt: NOW, error: 'boom', errorCode: null })
    expect(screen.getByRole('alert').textContent).toBe('操作没有完成：boom')
  })
})

describe('owner and status', () => {
  it('sets the main account from a UID, and says nothing is answered until then', () => {
    const { actions } = mount({ view: { ...VIEW, ownerMid: 0 }, checkedAt: NOW })
    const owner = card('主号')
    expect(owner.textContent).toContain('还没设置：在这之前，它不读也不回任何私信。')
    const input = within(owner).getByRole('textbox')
    const save = within(owner).getByRole('button', { name: '保存' })
    fireEvent.change(input, { target: { value: '12ab' } })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect((save as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(input, { target: { value: '200000002' } })
    fireEvent.click(save)
    expect(actions).toEqual([{ action: 'owner', mid: 200000002 }])
  })

  it('polls while mounted and says when the status cannot be read', () => {
    const { refresh } = mount({ view: null, stale: true, checkedAt: NOW })
    expect(refresh).toHaveBeenCalled()
    expect(screen.getByText('暂时读不到账号状态，稍后自动重试。')).toBeTruthy()
  })
})

describe('BiliLoader', () => {
  it('shares one read, keeps the last view through failures, and remembers the ledger length', async () => {
    const store = createBiliStore()
    const read = vi.fn<(limit: number) => Promise<BiliView>>(() => Promise.resolve(VIEW))
    const post = vi.fn((_action: BiliAction) => Promise.resolve({ ...VIEW, ownerMid: 7 }))
    const loader = new BiliLoader(store, read, post, () => 42)
    await Promise.all([loader.refresh(), loader.refresh()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith(20)
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, checkedAt: 42, stale: false })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    read.mockRejectedValueOnce(new Error('offline'))
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, stale: true })
    await loader.act({ action: 'owner', mid: 7 })
    expect(store.getSnapshot()).toMatchObject({ view: { ownerMid: 7 }, stale: false, busy: null, error: null })
    post.mockResolvedValueOnce(VIEW)
    await loader.act({ action: 'ledger', limit: 50 })
    await loader.refresh()
    expect(read).toHaveBeenLastCalledWith(50)
    vi.restoreAllMocks()
  })

  it('shows the gate mode at once, restores it when the Host refuses, and keeps the code', async () => {
    const store = createBiliStore()
    store.update((draft) => { draft.view = VIEW })
    let release: (view: BiliView) => void = () => {}
    const post = vi.fn((_action: BiliAction) => new Promise<BiliView>((resolve) => { release = resolve }))
    const loader = new BiliLoader(store, () => Promise.resolve(VIEW), post, () => 1)
    const pending = loader.act({ action: 'gate.mode', mode: 'readonly' })
    expect(store.getSnapshot()).toMatchObject({ busy: { action: 'gate.mode', account: null }, view: { gate: { mode: 'readonly', readonly: true } } })
    const result = { action: 'gate.mode', account: null, outcome: 'readonly', days: null } as const
    release({ ...VIEW, gate: { ...VIEW.gate!, mode: 'readonly', readonly: true }, result })
    await pending
    expect(store.getSnapshot()).toMatchObject({ busy: null, result: { value: { outcome: 'readonly' } } })
    post.mockRejectedValueOnce(new RouteError('the brake is set', 'mode_refused'))
    const refused = loader.act({ action: 'gate.mode', mode: 'auto' })
    // Automatic is not shown ahead of bili-svc's answer: it may refuse.
    expect(store.getSnapshot().view?.gate?.mode).toBe('readonly')
    await refused
    expect(store.getSnapshot()).toMatchObject({ error: 'the brake is set', errorCode: 'mode_refused', view: { gate: { mode: 'readonly' } }, busy: null })
  })

  it('runs background actions without busy state or banners, one at a time, and not during an action', async () => {
    const store = createBiliStore()
    store.update((draft) => { draft.view = VIEW })
    const gates: ((view: BiliView) => void)[] = []
    const post = vi.fn((_action: BiliAction) => new Promise<BiliView>((resolve, reject) => { gates.push(resolve); void reject }))
    const loader = new BiliLoader(store, () => Promise.resolve(VIEW), post, () => 1)
    const first = loader.quiet({ action: 'login.poll', account: 'maomao' })
    void loader.quiet({ action: 'login.poll', account: 'maomao' })
    expect(post).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().busy).toBeNull()
    gates[0]!({ ...VIEW, result: { action: 'login.poll', account: 'maomao', outcome: 'done', days: null } })
    await first
    expect(store.getSnapshot().result?.value.outcome).toBe('done')
    store.update((draft) => { draft.busy = { action: 'logout', account: 'maomao' } })
    await loader.quiet({ action: 'login.poll', account: 'maomao' })
    expect(post).toHaveBeenCalledTimes(1)
    store.update((draft) => { draft.busy = null })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    post.mockRejectedValueOnce(new Error('offline'))
    await loader.quiet({ action: 'login.poll', account: 'maomao' })
    expect(store.getSnapshot().error).toBeNull()
    vi.restoreAllMocks()
  })

  it('checks the answer shape, formats times and QR paths, and keeps every dictionary on the same keys', () => {
    expect(() => parseView({})).toThrow('unexpected Bilibili account answer')
    expect(() => parseView({ account: {}, ownerMid: 1, timeZone: 'UTC' })).toThrow('unexpected Bilibili account answer')
    expect(parseView(VIEW)).toBe(VIEW)
    expect(agoText(NOW - 30_000, NOW, t as never)).toBe('刚刚')
    expect(agoText(NOW - 3 * 86_400_000, NOW, t as never)).toBe('3 天前')
    expect(countdown(NOW + 150_000, NOW)).toBe('2:30')
    expect(countdown(NOW - 5, NOW)).toBe('0:00')
    expect(qrPath(['01', '10'])).toBe('M1 0h1v1h-1zM0 1h1v1h-1z')
    const keys = Object.keys(zh).sort()
    for (const dictionary of [en, ja, es, fr, de, ru, pt]) expect(Object.keys(dictionary).sort()).toEqual(keys)
    const retired = /^(clock|seen|taste|trends|keywords|interests|usage|pause|verify|progress|recent|action)\./
    for (const key of keys) expect(key).not.toMatch(retired)
    // Every placeholder of the Chinese copy appears in each translation.
    for (const dictionary of [en, ja, es, fr, de, ru, pt]) {
      for (const key of keys as (keyof typeof zh)[]) {
        const names = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort()
        expect(names(dictionary[key]), key).toEqual(names(zh[key]))
      }
    }
  })
})

describe('All settings card', () => {
  it('ends the page with the card for the bili and tool-bili entries, and renders without the card factory', () => {
    const store = createBiliStore()
    store.update((draft) => { Object.assign(draft, { view: VIEW, checkedAt: NOW }) })
    const renderFactorySlot = vi.fn((_name: string, _props: object) => <div data-testid="plugin-config" />)
    const props = {
      close: () => {}, useBili: bindSnapshotSelector(store), refresh: vi.fn(), act: vi.fn(), poll: vi.fn(), t, renderFactorySlot,
    } as unknown as BiliAccountProps
    const { container } = render(<BiliAccountSection {...props} />)
    expect(renderFactorySlot).toHaveBeenCalledWith('settings.plugin-config', { entries: ['bili', 'tool-bili'] })
    expect(container.querySelector('section')?.lastElementChild).toBe(screen.getByTestId('plugin-config'))
    cleanup()
    mount({ view: VIEW, checkedAt: NOW })
    expect(screen.queryByTestId('plugin-config')).toBeNull()
  })
})
