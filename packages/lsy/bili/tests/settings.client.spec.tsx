// @vitest-environment jsdom

import { act as reactAct, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { BiliAction, BiliView, LoginView, ManagedAccount } from '../src/view.ts'
import { BiliLoader, RouteError, createBiliStore, parseView, startPolling, type BiliState } from '../src/client/bili.ts'
import { BiliAccountSection, type BiliAccountProps } from '../src/client/BiliAccount.tsx'
import { agoText, countdown, dateTime, qrPath, stampTime } from '../src/client/format.ts'
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
    const readonlyGate = READONLY.gate
    if (readonlyGate === undefined) throw new Error('the READONLY fixture has no gate')
    const { actions, store } = mount({ view: { ...READONLY, gate: { ...readonlyGate, brake: BRAKE } }, checkedAt: NOW })
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
    expect(() => parseView(null)).toThrow('unexpected Bilibili account answer')
    expect(() => parseView('account')).toThrow('unexpected Bilibili account answer')
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
    } as BiliAccountProps
    const { container } = render(<BiliAccountSection {...props} />)
    expect(renderFactorySlot).toHaveBeenCalledWith('settings.plugin-config', { entries: ['bili', 'tool-bili'] })
    expect(container.querySelector('section')?.lastElementChild).toBe(screen.getByTestId('plugin-config'))
    cleanup()
    mount({ view: VIEW, checkedAt: NOW })
    expect(screen.queryByTestId('plugin-config')).toBeNull()
  })
})

describe('account cards in unusual states', () => {
  it('names an account by its id when bili-svc has no display name, and leaves out facts it does not know', () => {
    mount({ view: { ...VIEW, accounts: [{ ...MAODENG, display: '', mid: 0, refreshedAt: null, importedAt: null }] }, checkedAt: NOW })
    const account = card('maodeng')
    expect(account.textContent).toContain(t('account.id', { id: 'maodeng' }))
    expect(account.textContent).not.toContain('UID')
    expect(account.textContent).not.toContain(t('account.refreshed', { ago: '' }).trim())
    expect(account.querySelector('[aria-hidden="true"]')?.textContent).toBe('m')
  })

  it('renders nothing for the cards when bili-svc lists no account', () => {
    mount({ view: { ...VIEW, accounts: [] }, checkedAt: NOW })
    expect(screen.queryByRole('region', { name: '魔女的猫猫' })).toBeNull()
  })

  it('shows what the clicked sign-out and sign-in controls are doing', () => {
    const { view } = mount({ view: VIEW, checkedAt: NOW })
    fireEvent.click(within(card('魔女的猫猫')).getByRole('button', { name: '退出登录' }))
    view.unmount()
    // Busy while the confirmed sign-out runs: the same card in its confirming state.
    const mao = { ...VIEW }
    const { store } = mount({ view: mao, checkedAt: NOW })
    fireEvent.click(within(card('魔女的猫猫')).getByRole('button', { name: '退出登录' }))
    reactAct(() => { store.update((draft) => { draft.busy = { action: 'logout', account: 'maomao' } }) })
    const confirm = within(card('魔女的猫猫')).getByRole('button', { name: t('busy.logout') })
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
  })

  it('words a failed sign-in without a reason, and shows the retry button busy while the new code is fetched', () => {
    const { store } = mount({ view: { ...VIEW, logins: [login({ state: 'failed', qr: null, message: null })] }, checkedAt: NOW })
    const panel = screen.getByRole('group', { name: /扫码登录/ })
    expect(within(panel).getByRole('status').textContent).toBe(t('login.failed'))
    reactAct(() => { store.update((draft) => { draft.busy = { action: 'login.start', account: 'maomao' } }) })
    expect(within(panel).getByRole('button', { name: t('busy.login') })).toBeTruthy()
  })
})

describe('the gate card in unusual states', () => {
  const GATE = VIEW.gate!

  it('labels a mode it does not know by its name, and an empty one with a dash', () => {
    const { view } = mount({ view: { ...VIEW, gate: { ...GATE, mode: 'maintenance', readonly: true } }, checkedAt: NOW })
    expect(card('操作闸门').textContent).toContain(t('gate.mode', { mode: 'maintenance' }))
    view.unmount()
    mount({ view: { ...VIEW, gate: { ...GATE, mode: '', readonly: true } }, checkedAt: NOW })
    expect(card('操作闸门').textContent).toContain(t('gate.mode', { mode: '—' }))
  })

  it('shows a brake without a reason, detail, or time as just the brake, and no counters bili-svc did not send', () => {
    mount({ view: { ...VIEW, gate: { ...GATE, mode: 'readonly', readonly: true, brake: { reason: '', detail: '', ts: null }, used: null, caps: null } }, checkedAt: NOW })
    const gate = card('操作闸门')
    expect(within(gate).getByRole('status').textContent).toBe(t('gate.brake', { reason: '—' }))
    expect(gate.textContent).not.toContain('今日已用')
  })

  it('shows the time of a brake with the full time as its title', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mount({ view: { ...VIEW, gate: { ...GATE, mode: 'readonly', readonly: true, brake: { reason: 'risk', detail: '', ts: NOW - 3_600_000 } } }, checkedAt: NOW })
    const at = within(card('操作闸门')).getByTitle(/^\d\d-\d\d \d\d:\d\d$/)
    expect(at.textContent).toContain(t('ago.hours', { n: 1 }))
  })

  it('marks the brake release, the stop, and the confirmed switch busy while they run', () => {
    const braked = { ...VIEW, gate: { ...GATE, mode: 'readonly', readonly: true, brake: { reason: 'risk', detail: '', ts: null } } }
    const first = mount({ view: braked, checkedAt: NOW, busy: { action: 'brake.release', account: null } })
    expect(within(card('操作闸门')).getByRole('button', { name: t('busy.brake') }).getAttribute('aria-busy')).toBe('true')
    first.view.unmount()
    const stop = mount({ view: VIEW, checkedAt: NOW, busy: { action: 'gate.mode', account: null } })
    expect(within(card('操作闸门')).getByRole('button', { name: t('busy.mode') }).getAttribute('aria-busy')).toBe('true')
    stop.view.unmount()
    const readonly = { ...VIEW, gate: { ...GATE, mode: 'readonly', readonly: true } }
    const confirming = mount({ view: readonly, checkedAt: NOW })
    fireEvent.click(within(card('操作闸门')).getByRole('button', { name: '切到自动' }))
    reactAct(() => { confirming.store.update((draft) => { draft.busy = { action: 'gate.mode', account: null } }) })
    expect(within(card('操作闸门')).getByRole('button', { name: t('busy.mode') }).getAttribute('aria-busy')).toBe('true')
  })

  it('shows a refusal that has no words of bili-svc\'s as the fixed line alone', () => {
    mount({ view: { ...VIEW, gate: { ...GATE, mode: 'readonly', readonly: true } }, checkedAt: NOW, error: null, errorCode: 'mode_refused' })
    expect(within(card('操作闸门')).getByRole('alert').textContent).toBe(t('error.mode_refused'))
  })
})

describe('the ledger card in unusual states', () => {
  const row = (patch: Partial<NonNullable<BiliView['ledger']>['rows'][number]> = {}) => ({
    ts: NOW - 60_000, kind: 'dm', target: '1', state: 'sent', reason: '', caller: '', draft: '', verdict: '', ...patch,
  })

  it('shows a row without a time as a dash, a row without details as its summary alone, and an empty ledger as empty', () => {
    const { view } = mount({ view: { ...VIEW, ledger: { rows: [row({ ts: null })], summary: {} } }, checkedAt: NOW })
    const ledger = screen.getByText('最近动作').closest('details')!
    expect(ledger.querySelector('summary + details summary, details details summary')?.textContent).toContain('—')
    expect(ledger.querySelector('dl')).toBeNull()
    expect(ledger.querySelector('.chips')).toBeNull()
    view.unmount()
    mount({ view: { ...VIEW, ledger: { rows: [], summary: {} } }, checkedAt: NOW })
    expect(screen.getByText(t('ledger.empty'))).toBeTruthy()
  })

  it('marks the load-more button busy while it loads', () => {
    mount({ view: VIEW, checkedAt: NOW, ledgerLimit: 2, busy: { action: 'ledger', account: null } })
    const more = screen.getByRole('button', { name: t('busy.more') })
    expect(more.getAttribute('aria-busy')).toBe('true')
  })
})

describe('the owner card and the status line in unusual states', () => {
  it('shows when the main account was saved, and follows a UID saved elsewhere unless the draft was edited', () => {
    const { store } = mount({ view: { ...VIEW, ownerMid: 100, ownerUpdatedAt: NOW - 60_000 }, checkedAt: NOW })
    const owner = card('主号')
    expect(owner.textContent).toContain(t('owner.saved', { time: '' }).replace(/\s*$/, '').slice(0, 2))
    const input = within(owner).getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('100')
    reactAct(() => { store.update((draft) => { draft.view = { ...VIEW, ownerMid: 200, ownerUpdatedAt: NOW } } ) })
    expect(within(card('主号')).getByRole<HTMLInputElement>('textbox').value).toBe('200')
    fireEvent.change(within(card('主号')).getByRole('textbox'), { target: { value: '12' } })
    reactAct(() => { store.update((draft) => { draft.view = { ...VIEW, ownerMid: 300, ownerUpdatedAt: NOW } } ) })
    expect(within(card('主号')).getByRole<HTMLInputElement>('textbox').value).toBe('12')
  })

  it('says it is loading before the first answer, and shows the age of a stale view', () => {
    const loading = mount({ view: null, checkedAt: null })
    expect(screen.getByRole('status').textContent).toContain(t('status.loading'))
    loading.view.unmount()
    mount({ view: VIEW, stale: true, checkedAt: null })
    expect(screen.getAllByRole('status')[0]!.textContent).toMatch(/\d\d:\d\d:\d\d/)
  })

  it('shows a live status with the time of the last answer, or the time now when none was recorded', () => {
    const answered = mount({ view: VIEW, checkedAt: NOW })
    expect(screen.getAllByRole('status')[0]!.textContent).toContain(t('status.live', { time: '' }).replace(/\s*$/, '').slice(0, 2))
    answered.view.unmount()
    mount({ view: VIEW, checkedAt: null })
    expect(screen.getAllByRole('status')[0]!.textContent).toMatch(/\d\d:\d\d:\d\d/)
  })

  it.each([
    [{ action: 'gate.mode', account: null, outcome: 'auto', days: null }, 'result.mode', { mode: '自动' }],
    [{ action: 'gate.mode', account: null, outcome: 'readonly', days: null }, 'result.mode', { mode: '只读' }],
    [{ action: 'gate.mode', account: null, outcome: 'weird', days: null }, 'result.mode', { mode: 'weird' }],
    [{ action: 'brake.release', account: null, outcome: 'released', days: null }, 'result.released', {}],
    [{ action: 'brake.release', account: null, outcome: 'none', days: null }, 'result.noBrake', {}],
    [{ action: 'session.refresh', account: 'maomao', outcome: 'unchanged', days: null }, 'result.unchanged', { account: 'maomao' }],
    [{ action: 'session.check', account: 'maomao', outcome: 'valid', days: null }, 'result.checkValid', { account: 'maomao' }],
    [{ action: 'logout', account: 'maomao', outcome: 'logged-out', days: null }, 'result.loggedOut', { account: 'maomao' }],
    [{ action: 'login.poll', account: 'maomao', outcome: 'done', days: null }, 'result.loginDone', { account: 'maomao' }],
  ] as const)('says what %j did', (result, key, params) => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mount({ view: VIEW, checkedAt: NOW, result: { value: result, at: NOW - 1000 } })
    expect(screen.getAllByRole('status').some(node => node.textContent === t(key, params))).toBe(true)
  })

  it('says nothing for results that need no words, and for a result without an account', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const polled = mount({ view: VIEW, checkedAt: NOW, result: { value: { action: 'login.poll', account: 'maomao', outcome: 'waiting', days: null }, at: NOW } })
    expect(polled.view.container.querySelector('[class*="done"]')).toBeNull()
    polled.view.unmount()
    const ledger = mount({ view: VIEW, checkedAt: NOW, result: { value: { action: 'ledger', account: null, outcome: 'ok', days: null }, at: NOW } })
    expect(ledger.view.container.querySelector('[class*="done"]')).toBeNull()
    ledger.view.unmount()
    mount({ view: VIEW, checkedAt: NOW, result: { value: { action: 'logout', account: null, outcome: 'logged-out', days: null }, at: NOW } })
    expect(screen.getAllByRole('status').some(node => node.textContent === t('result.loggedOut', { account: '' }))).toBe(true)
  })

  it.each([
    ['not_owner', 'error.not_owner'],
    ['no_token', 'error.no_token'],
    ['session_unavailable', 'error.no_session'],
  ] as const)('explains the failure code %s', (code, key) => {
    mount({ view: VIEW, checkedAt: NOW, error: 'x', errorCode: code })
    expect(screen.getByRole('alert').textContent).toBe(t(key))
  })
})

describe('BiliLoader in unusual states', () => {
  it('keeps a thrown value that is not an Error as the failure text, and tells an account action apart in the busy state', async () => {
    const store = createBiliStore()
    store.update((draft) => { draft.view = VIEW })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error arm is the case under test.
    const post = vi.fn((_action: BiliAction) => Promise.reject('offline'))
    const loader = new BiliLoader(store, () => Promise.resolve(VIEW), post, () => 1)
    const pending = loader.act({ action: 'session.check', account: 'maomao' })
    expect(store.getSnapshot().busy).toEqual({ action: 'session.check', account: 'maomao' })
    await pending
    expect(store.getSnapshot()).toMatchObject({ error: 'offline', errorCode: null, busy: null })
  })

  it('keeps the view as it was when an action fails before any view was read', async () => {
    const store = createBiliStore()
    const loader = new BiliLoader(store, () => Promise.resolve(VIEW), () => Promise.reject(new RouteError('no way', 'x')), () => 1)
    await loader.act({ action: 'gate.mode', mode: 'readonly' })
    expect(store.getSnapshot()).toMatchObject({ view: null, error: 'no way', errorCode: 'x' })
  })

  it('does not warn twice for a view that stays stale', async () => {
    const store = createBiliStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader = new BiliLoader(store, () => Promise.reject(new Error('offline')), () => Promise.resolve(VIEW), () => 1)
    await loader.refresh()
    await loader.refresh()
    expect(warn).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it('keeps a background result that is not a finished sign-in out of the result line', async () => {
    const store = createBiliStore()
    const loader = new BiliLoader(store, () => Promise.resolve(VIEW), () => Promise.resolve({ ...VIEW, result: null }), () => 1)
    await loader.quiet({ action: 'login.poll', account: 'maomao' })
    expect(store.getSnapshot().result).toBeNull()
    expect(store.getSnapshot().view).toEqual({ ...VIEW, result: null })
  })
})

describe('the polling of a visible page', () => {
  it('refreshes at once and on each period, pauses while the page is hidden, and resumes when it shows again', () => {
    vi.useFakeTimers()
    const listeners = new Set<() => void>()
    const page = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    }
    const refresh = vi.fn()
    const stop = startPolling(refresh, 1000, page)
    expect(refresh).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(refresh).toHaveBeenCalledTimes(3)
    // Showing an already visible page changes nothing; hiding it twice stops once.
    for (const listener of listeners) listener()
    expect(refresh).toHaveBeenCalledTimes(3)
    page.visibilityState = 'hidden'
    for (const listener of listeners) listener()
    for (const listener of listeners) listener()
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(3)
    page.visibilityState = 'visible'
    for (const listener of listeners) listener()
    expect(refresh).toHaveBeenCalledTimes(4)
    stop()
    expect(listeners.size).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(4)
  })

  it('polls without a page to watch', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const stop = startPolling(refresh, 1000, null)
    vi.advanceTimersByTime(1000)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
  })
})

describe('time helpers', () => {
  it('writes minutes ago, and the time of a date in the runtime\'s zone when none is given', () => {
    expect(agoText(NOW - 5 * 60_000, NOW, t as never)).toBe('5 分钟前')
    expect(dateTime(NOW, 'America/New_York')).toBe('10-31 14:00')
    expect(dateTime(NOW)).toMatch(/^\d\d-\d\d \d\d:\d\d$/)
    expect(stampTime(NOW)).toMatch(/^\d\d:\d\d:\d\d$/)
  })
})
