// @vitest-environment jsdom

import { act as flush, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createGmailStore, timeFormatter, type GmailState } from '../src/client/gmail.ts'
import { GmailSection, type GmailProps } from '../src/client/GmailSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { AccountRow, GmailView, PendingRow } from '../src/view.ts'

const t = makeTranslate(zh) as GmailProps['t']
const clock = timeFormatter()
const AT = Date.parse('2026-11-12T14:00:00Z')
const HOUR = 3_600_000

const HELD: PendingRow = {
  code: 'K7Q2MX', account: 'work', from: 'Owner <owner@example.com>', to: ['ann@example.com', 'bo@example.com'], cc: ['cy@example.com'],
  bcc: ['spy@example.net'], subject: 'Quarterly numbers', preview: 'Hi Ann,\nthe numbers are <b>attached</b>.', attachments: ['q3.xlsx', 'notes.pdf'],
  createdAt: AT - HOUR, origin: 'owner, read gmail_read', reason: '这一轮读过外来内容', status: 'held', resolvedAt: null, resolvedBy: null,
  noticeSent: true,
}
const PLAIN: PendingRow = {
  ...HELD, code: 'PLAIN2', to: ['dee@example.com'], cc: [], bcc: [], subject: '', preview: '', attachments: [], createdAt: AT - 70 * HOUR,
  noticeSent: false,
}
const RESOLVED: PendingRow[] = [
  { ...HELD, code: 'SENT22', subject: 'Sent one', status: 'sent', resolvedAt: AT - HOUR, resolvedBy: 'settings' },
  { ...HELD, code: 'DISC33', subject: 'Dropped one', status: 'discarded', resolvedAt: AT - HOUR, resolvedBy: 'owner-turn' },
  { ...PLAIN, code: 'EXPD44', subject: 'Old one', status: 'expired', resolvedAt: null, resolvedBy: null },
]
const WORK: AccountRow = {
  id: 'work', email: 'me@work.example', name: '', policy: 'confirm-untrusted', addedAt: AT - 100 * HOUR, lastOkAt: AT - 5 * 60_000,
  lastError: null, needsReconnect: false, sentToday: 3,
}
const BOT: AccountRow = { ...WORK, id: 'bot', email: 'bot@example.com', name: 'News bot', policy: 'direct', needsReconnect: true, lastOkAt: null }

const VIEW: GmailView = {
  client: { configured: true, clientId: 'abc.apps.googleusercontent.com', secretConfigured: true },
  redirectUri: null,
  accounts: [WORK, BOT],
  pending: [HELD, PLAIN, ...RESOLVED],
  activity: [
    { seq: 3, at: AT - 60_000, account: 'work', kind: 'held', detail: 'ann@example.com: reason' },
    { seq: 2, at: AT - 120_000, account: 'bot', kind: 'reconnect', detail: 'invalid_grant' },
    { seq: 1, at: AT - 180_000, account: 'work', kind: 'archived', detail: 'a kind the page does not know' },
  ],
  maxSendsPerDay: 50,
  confirmTtlHours: 72,
  trustedRecipients: ['owner@example.com', 'boss@example.com'],
}

function mount(state: Partial<GmailState>, renderFactorySlot?: GmailProps['renderFactorySlot']) {
  const store = createGmailStore()
  store.update((draft) => { Object.assign(draft, { at: AT, ...state }) })
  const refresh = vi.fn()
  const act = vi.fn(async (_action: unknown, _control?: string) => true)
  const copy = vi.fn(async (_text: string) => {})
  const props = { close: () => {}, useGmail: bindSnapshotSelector(store), refresh, act, copy, origin: 'https://dsh.example.com', t, renderFactorySlot } as GmailProps
  render(<GmailSection {...props} />)
  return { store, refresh, act }
}

const card = (name: string) => screen.getByRole('article', { name })
const follows = (first: Element, second: Element) => first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING

afterEach(() => { cleanup() })

describe('GmailSection', () => {
  it('shows loading and refreshes once mounted, and says when nothing could be read', () => {
    const { refresh } = mount({})
    expect(screen.getByRole('status').textContent).toBe('正在读取…')
    expect(refresh).toHaveBeenCalledTimes(1)
    cleanup()
    mount({ stale: true })
    expect(screen.getByRole('status').textContent).toBe(t('status.failed'))
  })

  it('puts the held messages first, then the recently handled, the accounts, the OAuth client, the rules, and the activity', () => {
    mount({ view: VIEW })
    expect(screen.getAllByRole('status')[0]?.textContent).toBe('2 个账号 · 2 封等你确认 · 1 个需要重新登录')
    const order = [
      screen.getByRole('region', { name: '等你确认' }), screen.getByText('最近处理'), screen.getByRole('region', { name: '账号' }),
      screen.getByText('Google OAuth 客户端'), screen.getByRole('region', { name: '发信规则' }), screen.getByText('最近活动'),
    ]
    for (let index = 1; index < order.length; index += 1) expect(follows(order[index - 1]!, order[index]!)).toBeTruthy()
    expect(screen.getByText('2 封')).toBeTruthy()
  })

  it('shows everything about a held message, with Bcc set apart, and its text as plain text that keeps line breaks', () => {
    mount({ view: VIEW })
    const held = within(card('Quarterly numbers'))
    expect(held.getByText('Owner <owner@example.com>')).toBeTruthy()
    expect(held.getByText('ann@example.com, bo@example.com')).toBeTruthy()
    expect(held.getByText('cy@example.com')).toBeTruthy()
    const bcc = held.getByText('spy@example.net')
    expect(bcc.closest('[data-tone="bcc"]')?.textContent).toBe('密送spy@example.net其他收件人看不到这些地址')
    expect(held.getByText('q3.xlsx, notes.pdf')).toBeTruthy()
    const preview = held.getByText(/Hi Ann/u)
    expect(preview.textContent).toBe(HELD.preview)
    expect(preview.querySelector('b')).toBeNull()
    expect(held.getByText('这一轮读过外来内容')).toBeTruthy()
    expect(held.getByText('owner, read gmail_read')).toBeTruthy()
    expect(held.getByText('确认码 K7Q2MX')).toBeTruthy()
    expect(held.getByText('2 天后过期').parentElement?.textContent).toBe(`${clock(AT - HOUR)} 写好 · 2 天后过期`)
    expect(held.getByText('已在微信通知你')).toBeTruthy()
  })

  it('says when the WeChat notice did not go out, names an empty subject and text, and counts down the last hours', () => {
    mount({ view: VIEW })
    const plain = within(card('（无主题）'))
    expect(plain.getByText(t('held.noticeMissing'))).toBeTruthy()
    expect(plain.getByText('（没有正文）')).toBeTruthy()
    expect(plain.getByText('2 小时后过期')).toBeTruthy()
    expect(plain.queryByText('密送')).toBeNull()
    expect(plain.queryByText('抄送')).toBeNull()
    cleanup()
    mount({ view: { ...VIEW, pending: [{ ...PLAIN, createdAt: AT - 80 * HOUR }] } })
    expect(screen.getByText('已到期，马上自动作废')).toBeTruthy()
  })

  it('asks once more before sending, restating every recipient with Bcc, and posts only on the second click', () => {
    const { act } = mount({ view: VIEW })
    const held = within(card('Quarterly numbers'))
    fireEvent.click(held.getByRole('button', { name: '发送' }))
    expect(act).not.toHaveBeenCalled()
    const confirm = held.getByRole('group', { name: '确定发送？发出后无法撤回' })
    expect(document.activeElement).toBe(confirm)
    expect(within(confirm).getByText('收件人：ann@example.com, bo@example.com')).toBeTruthy()
    expect(within(confirm).getByText('抄送：cy@example.com')).toBeTruthy()
    expect(within(confirm).getByText('密送：spy@example.net（其他收件人看不到）')).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: '确认发送' }))
    expect(act).toHaveBeenCalledTimes(1)
    expect(act).toHaveBeenCalledWith({ action: 'confirm', code: 'K7Q2MX' })
  })

  it('says a message has no Bcc before sending, and closes the confirmation with its button or Escape', () => {
    const { act } = mount({ view: VIEW })
    const plain = within(card('（无主题）'))
    fireEvent.click(plain.getByRole('button', { name: '发送' }))
    const confirm = plain.getByRole('group', { name: t('held.confirmTitle') })
    expect(within(confirm).getByText('密送：无')).toBeTruthy()
    expect(within(confirm).queryByText(/抄送/u)).toBeNull()
    fireEvent.click(within(confirm).getByRole('button', { name: '取消' }))
    expect(plain.queryByRole('group')).toBeNull()
    fireEvent.click(plain.getByRole('button', { name: '发送' }))
    fireEvent.keyDown(plain.getByRole('group'), { key: 'Enter' })
    expect(plain.getByRole('group')).toBeTruthy()
    fireEvent.keyDown(plain.getByRole('group'), { key: 'Escape' })
    expect(plain.queryByRole('group')).toBeNull()
    expect(act).not.toHaveBeenCalled()
  })

  it('shows the send in flight on its button, keeps the confirmation open, and locks every other action meanwhile', () => {
    const { store } = mount({ view: VIEW })
    const held = within(card('Quarterly numbers'))
    fireEvent.click(held.getByRole('button', { name: '发送' }))
    flush(() => { store.update((draft) => { draft.busy = 'confirm:K7Q2MX' }) })
    expect(held.getByRole<HTMLButtonElement>('button', { name: '正在发送…' }).disabled).toBe(true)
    expect(held.getByRole<HTMLButtonElement>('button', { name: '取消' }).disabled).toBe(true)
    fireEvent.keyDown(held.getByRole('group'), { key: 'Escape' })
    expect(held.getByRole('group')).toBeTruthy()
    expect(within(card('（无主题）')).getByRole<HTMLButtonElement>('button', { name: '发送' }).disabled).toBe(true)
    expect(within(card('（无主题）')).getByRole<HTMLButtonElement>('button', { name: '丢弃' }).disabled).toBe(true)
  })

  it('discards with one click, shows it in flight, and then says what happened', () => {
    const { store, act } = mount({ view: VIEW })
    fireEvent.click(within(card('Quarterly numbers')).getByRole('button', { name: '丢弃' }))
    expect(act).toHaveBeenCalledWith({ action: 'discard', code: 'K7Q2MX' })
    flush(() => { store.update((draft) => { draft.busy = 'discard:K7Q2MX' }) })
    expect(within(card('Quarterly numbers')).getByRole<HTMLButtonElement>('button', { name: '正在丢弃…' }).disabled).toBe(true)
    flush(() => {
      store.update((draft) => {
        draft.busy = null
        draft.view = { ...VIEW, pending: [PLAIN, { ...HELD, status: 'discarded', resolvedAt: AT, resolvedBy: 'settings' }] }
        draft.done = { control: 'discard:K7Q2MX', action: 'discard', target: 'Quarterly numbers' }
      })
    })
    expect(screen.getByText('已丢弃「Quarterly numbers」，不会发出，Gmail 里的草稿也会删掉')).toBeTruthy()
    expect(screen.queryByRole('article', { name: 'Quarterly numbers' })).toBeNull()
  })

  it('shows a refusal in the Host\'s words beside the message it concerns, and generic copy for other failures', () => {
    mount({ view: VIEW, failure: { control: 'confirm:K7Q2MX', kind: 'refused', message: 'the draft changed after the notice' } })
    expect(within(card('Quarterly numbers')).getByRole('alert').textContent).toBe('the draft changed after the notice')
    expect(within(card('（无主题）')).queryByRole('alert')).toBeNull()
    cleanup()
    mount({ view: VIEW, failure: { control: 'discard:PLAIN2', kind: 'failed' } })
    expect(within(card('（无主题）')).getByRole('alert').textContent).toBe('没有完成，DSH 日志里有详情')
    cleanup()
    mount({ view: VIEW, failure: { control: 'discard:PLAIN2', kind: 'offline' } })
    expect(within(card('（无主题）')).getByRole('alert').textContent).toBe('连不上 DSH，检查网络后再试一次')
  })

  it('lists the recently handled messages collapsed, with how and when each was resolved', () => {
    mount({ view: VIEW })
    const handled = screen.getByText('最近处理').closest('details')!
    expect(handled.open).toBe(false)
    expect(within(handled).getByText('3 封')).toBeTruthy()
    const recipients = 'ann@example.com, bo@example.com, cy@example.com, spy@example.net'
    expect(within(handled).getByText(`已发送 · work · ${recipients} · ${clock(AT - HOUR)} · 在设置里处理`)).toBeTruthy()
    expect(within(handled).getByText(`已丢弃 · work · ${recipients} · ${clock(AT - HOUR)} · 你在对话里确认`)).toBeTruthy()
    expect(within(handled).getByText('已过期 · work · dee@example.com')).toBeTruthy()
    expect(within(handled).getByText('Old one')).toBeTruthy()
  })

  it('moves the recently handled messages below the rules when nothing waits, and leaves them out when there are none', () => {
    mount({ view: { ...VIEW, pending: RESOLVED } })
    expect(screen.queryByRole('region', { name: '等你确认' })).toBeNull()
    expect(follows(screen.getByRole('region', { name: '发信规则' }), screen.getByText('最近处理'))).toBeTruthy()
    expect(follows(screen.getByText('最近处理'), screen.getByText('最近活动'))).toBeTruthy()
    cleanup()
    mount({ view: { ...VIEW, pending: [] } })
    expect(screen.queryByText('最近处理')).toBeNull()
  })

  it('lists the send rules with the trusted recipients and where to change them', () => {
    mount({ view: VIEW })
    expect(screen.getByText('发给这些地址不用确认：owner@example.com, boss@example.com')).toBeTruthy()
    expect(screen.getByText('每个账号 24 小时内最多发 50 封，超过的会被拒绝')).toBeTruthy()
    expect(screen.getByText('等你确认的信 72 小时后作废，草稿留在 Gmail 里')).toBeTruthy()
    expect(screen.getByText(t('rules.edit'))).toBeTruthy()
    cleanup()
    mount({ view: { ...VIEW, trustedRecipients: [] } })
    expect(screen.getByText('没有设置额外的可信收件人')).toBeTruthy()
  })

  it('lists the activity collapsed, newest first, naming known kinds and marking warnings', () => {
    mount({ view: VIEW })
    const activity = screen.getByText('最近活动').closest('details')!
    expect(activity.open).toBe(false)
    expect(within(activity).getByText('3 条')).toBeTruthy()
    const rows = within(activity).getAllByRole('listitem')
    expect(rows.map(row => row.textContent)).toEqual([
      `${clock(AT - 60_000)}work等确认ann@example.com: reason`,
      `${clock(AT - 120_000)}bot要重新登录invalid_grant`,
      `${clock(AT - 180_000)}workarchiveda kind the page does not know`,
    ])
    expect(rows.map(row => row.getAttribute('data-tone'))).toEqual([null, 'warn', null])
    cleanup()
    mount({ view: { ...VIEW, activity: [] } })
    expect(screen.getByText('还没有活动')).toBeTruthy()
  })

  it('keeps the last status under a notice when a later read failed', () => {
    mount({ view: VIEW, stale: true })
    expect(screen.getByText(t('status.stale'))).toBeTruthy()
    expect(screen.getByRole('region', { name: '邮箱' }).hasAttribute('data-stale')).toBe(true)
  })

  it('leads with the OAuth client setup until it is configured, and keeps the add form disabled meanwhile', () => {
    mount({ view: { ...VIEW, client: { configured: false, clientId: null, secretConfigured: false }, accounts: [], pending: [] } })
    expect(screen.getAllByRole('status')[0]?.textContent).toBe('还没有连接账号')
    const setup = screen.getByRole('region', { name: 'Google OAuth 客户端' })
    expect(follows(setup, screen.getByRole('region', { name: '账号' }))).toBeTruthy()
    expect(screen.getByText('还没有连接 Gmail 账号')).toBeTruthy()
    expect(screen.getByText('先配置好 Google OAuth 客户端，才能连接账号')).toBeTruthy()
    expect(screen.getByRole('button', { name: '连接 Google 账号' }).closest('fieldset')?.disabled).toBe(true)
  })

  it('shows a calm summary when accounts are connected and nothing waits', () => {
    mount({ view: { ...VIEW, accounts: [WORK], pending: [] } })
    expect(screen.getAllByRole('status')[0]?.textContent).toBe('1 个账号')
  })
})

describe('GmailSection All settings card', () => {
  it('ends with the All settings card of fork-gmail, loading or loaded', () => {
    const factory = vi.fn((_name: string, _props: object) => <div data-testid="plugin-config" />)
    mount({}, factory as never)
    expect(screen.getByTestId('plugin-config')).toBeTruthy()
    expect(factory).toHaveBeenCalledWith('settings.plugin-config', { entries: ['fork-gmail'] })
    cleanup()
    factory.mockClear()
    mount({ view: VIEW }, factory as never)
    const section = screen.getByRole('region', { name: '邮箱' })
    expect(section.lastElementChild?.getAttribute('data-testid')).toBe('plugin-config')
    expect(factory).toHaveBeenCalledWith('settings.plugin-config', { entries: ['fork-gmail'] })
  })
})
