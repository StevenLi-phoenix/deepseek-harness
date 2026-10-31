// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { BiliView } from '../src/view.ts'
import { BiliLoader, createBiliStore, parseView, type BiliState } from '../src/client/bili.ts'
import { BiliAccountSection, type BiliAccountProps } from '../src/client/BiliAccount.tsx'
import { agoText } from '../src/client/format.ts'
import { en, zh } from '../src/client/locales.ts'

const t = makeTranslate(zh) as BiliAccountProps['t']
const NOW = Date.parse('2026-10-23T18:00:00Z')

const VIEW: BiliView = {
  account: { account: 'maomao', session: 'ok', mid: 3_000_001, uname: '魔女的猫猫', checkedAt: NOW - 60_000 },
  gate: { mode: 'auto', readonly: false },
  ownerMid: 200000001,
  ownerUpdatedAt: null,
  timeZone: 'America/New_York',
}

function mount(state: Partial<BiliState>) {
  const store = createBiliStore()
  store.update((draft) => { Object.assign(draft, state) })
  const refresh = vi.fn()
  const actions: unknown[] = []
  const act = (action: unknown): void => { actions.push(action) }
  const props = { close: () => {}, useBili: bindSnapshotSelector(store), refresh, act, t } as BiliAccountProps
  const view = render(<BiliAccountSection {...props} />)
  return { store, refresh, actions, view }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BiliAccountSection', () => {
  it('shows the account as bili-svc reports it, read-only, with no sign-in', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mount({ view: VIEW, checkedAt: NOW })
    const hero = screen.getByRole('region', { name: '账号' })
    expect(hero.textContent).toContain('魔女的猫猫')
    expect(hero.textContent).toContain('在线')
    expect(hero.textContent).toContain('UID 3000001')
    expect(hero.textContent).toContain('bili-svc 账号 maomao')
    expect(hero.textContent).toContain('1 分钟前检查过')
    expect(hero.textContent).toContain('登录由 bili-svc 保管和续期')
    // Nothing to press on the account card: the login is bili-svc's.
    expect(within(hero).queryAllByRole('button')).toEqual([])
    expect(screen.queryByText(/扫码登录|二维码|立即唤醒|今日额度|它刷过的视频|它记住的口味|圈内热梗|关注关键词|主人的兴趣/)).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('says when bili-svc holds the session as dead or cannot be reached', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const dead = mount({ view: { ...VIEW, account: { ...VIEW.account, session: 'dead' } }, checkedAt: NOW })
    expect(screen.getByRole('region', { name: '账号' }).textContent).toContain('登录失效')
    dead.view.unmount()
    mount({ view: { ...VIEW, gate: null, account: { account: 'maomao', session: 'unreachable', error: 'bili-svc is unreachable (TypeError)', checkedAt: NOW } }, checkedAt: NOW })
    const hero = screen.getByRole('region', { name: '账号' })
    expect(hero.textContent).toContain('连不上 bili-svc')
    expect(hero.textContent).toContain('原因：bili-svc is unreachable (TypeError)')
    expect(hero.textContent).toContain('还不知道是哪个号')
  })

  it('shows a banner while bili-svc holds every action', () => {
    mount({ view: { ...VIEW, gate: { mode: 'readonly', readonly: true } }, checkedAt: NOW })
    expect(screen.getByText('bili-svc 暂停了所有操作（readonly）')).toBeTruthy()
    cleanup()
    mount({ view: VIEW, checkedAt: NOW })
    expect(screen.queryByText(/bili-svc 暂停了所有操作/)).toBeNull()
  })

  it('sets the main account from a UID, and says nothing is answered until then', () => {
    const { actions } = mount({ view: { ...VIEW, ownerMid: 0 }, checkedAt: NOW })
    const card = screen.getByRole('region', { name: '主号' })
    expect(card.textContent).toContain('还没设置：在这之前，它不读也不回任何私信。')
    const input = within(card).getByRole('textbox')
    const save = within(card).getByRole('button', { name: '保存' })
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
  it('shares one read, keeps the last view through failures, and posts actions', async () => {
    const store = createBiliStore()
    const read = vi.fn<() => Promise<BiliView>>(() => Promise.resolve(VIEW))
    const post = vi.fn((_action: unknown) => Promise.resolve({ ...VIEW, ownerMid: 7, ownerUpdatedAt: 1 }))
    const loader = new BiliLoader(store, read, post, () => 42)
    await Promise.all([loader.refresh(), loader.refresh()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, checkedAt: 42, stale: false })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    read.mockRejectedValueOnce(new Error('offline'))
    await loader.refresh()
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, stale: true })
    await loader.act({ action: 'owner', mid: 7 })
    expect(store.getSnapshot()).toMatchObject({ view: { ownerMid: 7 }, stale: false, busy: null, error: null })
    post.mockRejectedValueOnce(new Error('mid must be a positive integer UID'))
    await loader.act({ action: 'owner', mid: 7 })
    expect(store.getSnapshot().error).toBe('mid must be a positive integer UID')
    vi.restoreAllMocks()
  })

  it('checks the answer shape, formats times, and keeps every dictionary on the same keys', () => {
    expect(() => parseView({})).toThrow('unexpected Bilibili account answer')
    expect(() => parseView({ account: {}, login: {}, usage: {}, clock: {}, recent: [] })).toThrow('unexpected Bilibili account answer')
    expect(parseView(VIEW)).toBe(VIEW)
    expect(agoText(NOW - 30_000, NOW, t as never)).toBe('刚刚')
    expect(agoText(NOW - 3 * 86_400_000, NOW, t as never)).toBe('3 天前')
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    const retired = /^(login|clock|seen|taste|trends|keywords|interests|usage|pause|verify|progress|recent|action)\./
    for (const key of Object.keys(zh)) expect(key).not.toMatch(retired)
  })
})
