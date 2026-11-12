// @vitest-environment jsdom

import { act as flush, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createGmailStore, type GmailState } from '../src/client/gmail.ts'
import { GmailSection, type GmailProps } from '../src/client/GmailSection.tsx'
import { zh } from '../src/client/locales.ts'
import type { AccountRow, GmailView, PendingRow } from '../src/view.ts'

const t = makeTranslate(zh) as GmailProps['t']
const AT = Date.parse('2026-11-12T14:00:00Z')

const WORK: AccountRow = {
  id: 'work', email: 'me@work.example', name: '', policy: 'confirm-untrusted', addedAt: AT - 86_400_000, lastOkAt: AT - 5 * 60_000,
  lastError: null, needsReconnect: false, sentToday: 3,
}
const BOT: AccountRow = {
  ...WORK, id: 'bot', email: 'bot@example.com', name: 'News bot', policy: 'direct', needsReconnect: true, lastOkAt: null,
  lastError: 'invalid_grant: Token has been expired or revoked.', sentToday: 50,
}
const HELD: PendingRow = {
  code: 'K7Q2MX', account: 'work', from: 'me@work.example', to: ['ann@example.com'], cc: [], bcc: [], subject: 'Hi', preview: 'x',
  attachments: [], createdAt: AT, origin: 'owner', reason: 'r', status: 'held', resolvedAt: null, resolvedBy: null, noticeSent: true,
}
const VIEW: GmailView = {
  client: { configured: true, clientId: 'abc.apps.googleusercontent.com', secretConfigured: true },
  redirectUri: null, accounts: [WORK, BOT], pending: [HELD, { ...HELD, code: 'K7Q2MY' }], activity: [], maxSendsPerDay: 50, confirmTtlHours: 72,
  trustedRecipients: [],
}
const SETUP: GmailView = { ...VIEW, client: { configured: false, clientId: null, secretConfigured: false }, accounts: [], pending: [] }

type Act = (action: unknown, control?: string) => Promise<boolean>

function mount(state: Partial<GmailState>, options: { act?: Act; copy?: (text: string) => Promise<void>; origin?: string } = {}) {
  const store = createGmailStore()
  store.update((draft) => { Object.assign(draft, { at: AT, ...state }) })
  const act = vi.fn(options.act ?? (async () => true))
  const copy = vi.fn(options.copy ?? (async () => {}))
  const props = {
    close: () => {}, useGmail: bindSnapshotSelector(store), refresh: vi.fn(), act, copy, origin: options.origin ?? 'https://dsh.example.com', t,
  } as GmailProps
  render(<GmailSection {...props} />)
  return { store, act, copy }
}

const card = (name: string) => within(screen.getByRole('article', { name }))
const addForm = () => within(screen.getByRole('region', { name: '添加账号' }))

afterEach(() => { cleanup() })

describe('account cards', () => {
  it('shows each account\'s address, sends against the cap, last success, last error, and a stressed 重新登录 when the sign-in was lost', () => {
    const { act } = mount({ view: VIEW })
    const work = card('work')
    expect(work.getByText('me@work.example')).toBeTruthy()
    expect(work.getByText('24 小时内已发 3 / 50 封').parentElement?.textContent).toBe('24 小时内已发 3 / 50 封 · 上次正常 5 分钟前')
    expect(work.queryByText('需要重新登录')).toBeNull()
    const bot = card('bot')
    expect(bot.getByText('News bot <bot@example.com>')).toBeTruthy()
    expect(bot.getByText('需要重新登录')).toBeTruthy()
    expect(bot.getByText('24 小时内已发 50 / 50 封').parentElement?.textContent).toContain('还没有成功用过')
    expect(bot.getByText('上次出错：invalid_grant: Token has been expired or revoked.')).toBeTruthy()
    fireEvent.click(bot.getByRole('button', { name: '重新登录' }))
    expect(act).toHaveBeenCalledWith({ action: 'sign-in', account: 'bot' })
  })

  it('shows the re-sign-in in flight and its failure on that account only', () => {
    mount({ view: VIEW, busy: 'sign-in:work', failure: { control: 'sign-in:work', kind: 'refused', message: 'too many sign-ins are open' } })
    expect(card('work').getByRole<HTMLButtonElement>('button', { name: '正在打开 Google…' }).disabled).toBe(true)
    expect(card('work').getByRole('alert').textContent).toBe('too many sign-ins are open')
    expect(card('bot').queryByRole('alert')).toBeNull()
    expect(card('bot').getByRole<HTMLButtonElement>('button', { name: '重新登录' }).disabled).toBe(true)
  })

  it('explains the chosen policy, and keeps a new pick on screen while it saves', async () => {
    const save = Promise.withResolvers<boolean>()
    const { act, store } = mount({ view: VIEW }, { act: () => save.promise })
    const work = card('work')
    const select = work.getByRole<HTMLSelectElement>('combobox', { name: '发信规则' })
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['只读', '每封都确认', '按情况确认（推荐）', '直接发送'])
    expect(work.getByText(t('policy.confirm-untrusted.hint'))).toBeTruthy()
    expect(card('bot').getByText('不等你确认直接发出，只适合机器人账号')).toBeTruthy()
    fireEvent.change(select, { target: { value: 'read-only' } })
    expect(act).toHaveBeenCalledWith({ action: 'policy', account: 'work', policy: 'read-only' })
    flush(() => { store.update((draft) => { draft.busy = 'policy:work' }) })
    expect(select.value).toBe('read-only')
    expect(select.disabled).toBe(true)
    expect(work.getByText('正在保存…')).toBeTruthy()
    await flush(async () => {
      store.update((draft) => { draft.busy = null })
      save.resolve(false)
      await save.promise
    })
    // Refused: the Host's status still has the old policy, and the select shows it again.
    expect(select.value).toBe('confirm-untrusted')
  })

  it('asks before disconnecting, saying the held messages go too, and posts only on the second click', () => {
    const { act } = mount({ view: VIEW })
    const work = card('work')
    fireEvent.click(work.getByRole('button', { name: '断开' }))
    expect(act).not.toHaveBeenCalled()
    const confirm = within(work.getByRole('group', { name: '确认断开' }))
    expect(confirm.getByText('断开 work 会在 Google 撤销这次登录，并丢弃它等你确认的 2 封信')).toBeTruthy()
    fireEvent.click(confirm.getByRole('button', { name: '确认断开' }))
    expect(act).toHaveBeenCalledWith({ action: 'remove', account: 'work' })
    fireEvent.click(confirm.getByRole('button', { name: '取消' }))
    expect(work.queryByRole('group')).toBeNull()
    fireEvent.click(card('bot').getByRole('button', { name: '断开' }))
    expect(card('bot').getByText('断开 bot 会在 Google 撤销这次登录，之后要用得重新连接')).toBeTruthy()
  })

  it('shows a disconnect in flight on its button', () => {
    const { store } = mount({ view: VIEW })
    fireEvent.click(card('work').getByRole('button', { name: '断开' }))
    flush(() => { store.update((draft) => { draft.busy = 'remove:work' }) })
    expect(card('work').getByRole<HTMLButtonElement>('button', { name: '正在断开…' }).disabled).toBe(true)
    expect(card('work').getByRole<HTMLButtonElement>('button', { name: '取消' }).disabled).toBe(true)
  })
})

describe('add-account form', () => {
  it('says before connecting what Google will show, and checks the id as it is typed', () => {
    const { act } = mount({ view: VIEW })
    const form = addForm()
    for (const key of ['add.beforeTab', 'add.beforeUnverified', 'add.beforeScope', 'add.beforeReturn'] as const) expect(form.getByText(t(key))).toBeTruthy()
    const id = form.getByRole<HTMLInputElement>('textbox', { name: '账号名' })
    expect(form.getByText(t('add.idHint'))).toBeTruthy()
    fireEvent.change(id, { target: { value: ' Work ' } })
    expect(id.value).toBe('work')
    fireEvent.change(id, { target: { value: '2nd' } })
    expect(id.getAttribute('aria-invalid')).toBe('true')
    expect(form.getByText(t('add.idInvalid'))).toBeTruthy()
    fireEvent.click(form.getByRole('button', { name: '连接 Google 账号' }))
    expect(act).not.toHaveBeenCalled()
  })

  it('refuses an empty id and an address that is not one, without posting', () => {
    const { act } = mount({ view: VIEW })
    const form = addForm()
    const id = form.getByRole('textbox', { name: '账号名' })
    fireEvent.change(id, { target: { value: 'personal' } })
    const email = form.getByRole('textbox', { name: '邮箱地址（可选）' })
    fireEvent.change(email, { target: { value: 'me at home' } })
    // The address is checked on submit; from then on both fields are checked as they change.
    expect(form.queryByText('这不像一个邮箱地址')).toBeNull()
    fireEvent.click(form.getByRole('button', { name: '连接 Google 账号' }))
    expect(form.getByText('这不像一个邮箱地址')).toBeTruthy()
    expect(email.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(id, { target: { value: '' } })
    expect(form.getByText(t('add.idInvalid'))).toBeTruthy()
    fireEvent.click(form.getByRole('button', { name: '连接 Google 账号' }))
    expect(act).not.toHaveBeenCalled()
  })

  it('starts every new account, a bot too, on the recommended policy until the owner picks another', () => {
    mount({ view: VIEW })
    const form = addForm()
    const id = form.getByRole('textbox', { name: '账号名' })
    const policy = form.getByRole<HTMLSelectElement>('combobox', { name: '发信规则' })
    expect(policy.value).toBe('confirm-untrusted')
    fireEvent.change(id, { target: { value: 'bot' } })
    expect(policy.value).toBe('confirm-untrusted')
    fireEvent.change(policy, { target: { value: 'direct' } })
    expect(policy.value).toBe('direct')
    expect(form.getByText('不等你确认直接发出，只适合机器人账号')).toBeTruthy()
    fireEvent.change(id, { target: { value: 'news-bot' } })
    expect(policy.value).toBe('direct')
  })

  it('starts the sign-in with the id, the policy, and the address hint, and shows it in flight and its refusal', () => {
    const { act, store } = mount({ view: VIEW })
    const form = addForm()
    fireEvent.change(form.getByRole('textbox', { name: '账号名' }), { target: { value: 'bot' } })
    fireEvent.change(form.getByRole('combobox', { name: '发信规则' }), { target: { value: 'direct' } })
    fireEvent.change(form.getByRole('textbox', { name: '邮箱地址（可选）' }), { target: { value: ' bot@example.com ' } })
    fireEvent.click(form.getByRole('button', { name: '连接 Google 账号' }))
    expect(act).toHaveBeenCalledWith({ action: 'sign-in', account: 'bot', policy: 'direct', loginHint: 'bot@example.com' }, 'add')
    fireEvent.change(form.getByRole('textbox', { name: '邮箱地址（可选）' }), { target: { value: '' } })
    fireEvent.click(form.getByRole('button', { name: '连接 Google 账号' }))
    expect(act).toHaveBeenLastCalledWith({ action: 'sign-in', account: 'bot', policy: 'direct', loginHint: undefined }, 'add')
    flush(() => { store.update((draft) => { draft.busy = 'add' }) })
    expect(form.getByRole('button', { name: '正在打开 Google…' }).closest('fieldset')?.disabled).toBe(true)
    flush(() => {
      store.update((draft) => {
        draft.busy = null
        draft.failure = { control: 'add', kind: 'refused', message: 'bot@example.com is already connected as "news"' }
      })
    })
    expect(form.getByRole('alert').textContent).toBe('bot@example.com is already connected as "news"')
  })
})

describe('OAuth client card', () => {
  it('lists the Google Cloud steps with their pages, the redirect URI, and the home and privacy pages of this DSH', () => {
    mount({ view: SETUP })
    const setup = within(screen.getByRole('region', { name: 'Google OAuth 客户端' }))
    expect(setup.getByText(t('client.intro'))).toBeTruthy()
    const links = setup.getAllByRole('link', { name: '打开' })
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      'https://console.cloud.google.com/projectselector2/home/dashboard',
      'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
      'https://console.cloud.google.com/auth/overview',
      'https://console.cloud.google.com/auth/branding',
      'https://console.cloud.google.com/auth/clients/create',
    ])
    expect(links.every(link => link.getAttribute('target') === '_blank' && link.getAttribute('rel') === 'noreferrer')).toBe(true)
    expect(setup.getByText(/状态变成「In production」/u).textContent).toContain(
      'Application home page 填成 https://dsh.example.com/，Application privacy policy link 填成 https://dsh.example.com/fork.gmail.privacy，',
    )
    const uri = setup.getByRole<HTMLInputElement>('textbox', { name: '重定向 URI' })
    expect(uri.value).toBe('https://dsh.example.com/fork.gmail.oauth')
    expect(uri.readOnly).toBe(true)
    expect(setup.queryByText(t('client.redirectRefused'))).toBeNull()
  })

  it('uses the configured redirect URI, and warns when Google would refuse the address', () => {
    mount({ view: { ...SETUP, redirectUri: 'https://mail.example.com/fork.gmail.oauth' } })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '重定向 URI' }).value).toBe('https://mail.example.com/fork.gmail.oauth')
    cleanup()
    mount({ view: SETUP }, { origin: 'http://192.168.1.20:8080' })
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '重定向 URI' }).value).toBe('http://192.168.1.20:8080/fork.gmail.oauth')
    expect(screen.getByText(t('client.redirectRefused'))).toBeTruthy()
  })

  it('copies the redirect URI, and selects it for a manual copy where the clipboard is withheld', async () => {
    let allowed = true
    const { copy } = mount({ view: SETUP }, { copy: async () => { if (!allowed) throw new TypeError('clipboard unavailable') } })
    const uri = screen.getByRole<HTMLInputElement>('textbox', { name: '重定向 URI' })
    await flush(async () => { fireEvent.click(screen.getByRole('button', { name: '复制' })) })
    expect(copy).toHaveBeenCalledWith('https://dsh.example.com/fork.gmail.oauth')
    expect(screen.getByRole('button', { name: '已复制' })).toBeTruthy()
    allowed = false
    await flush(async () => { fireEvent.click(screen.getByRole('button', { name: '已复制' })) })
    expect(screen.getByText(t('client.copyFailed'))).toBeTruthy()
    expect(document.activeElement).toBe(uri)
    expect(uri.selectionStart).toBe(0)
    expect(uri.selectionEnd).toBe(uri.value.length)
  })

  it('keeps the pasted client secret away from autofill and spelling help, and checks it is JSON before posting', () => {
    const { act } = mount({ view: SETUP })
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '客户端 JSON' })
    expect(box.getAttribute('autocomplete')).toBe('off')
    expect(box.getAttribute('spellcheck')).toBe('false')
    expect(box.getAttribute('data-gramm')).toBe('false')
    const save = screen.getByRole<HTMLButtonElement>('button', { name: '保存' })
    expect(save.disabled).toBe(true)
    fireEvent.change(box, { target: { value: '{"web":{"client_secret":"GOCSPX-x"' } })
    fireEvent.click(save)
    expect(act).not.toHaveBeenCalled()
    expect(box.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(t('client.jsonInvalid'))).toBeTruthy()
    fireEvent.change(box, { target: { value: '{"web":{"client_secret":"GOCSPX-x"}}' } })
    expect(screen.getByText(t('client.jsonHint'))).toBeTruthy()
  })

  it('saves the pasted JSON and empties the box after a save the Host accepted, keeping it after one it refused', async () => {
    const answers = [false, true]
    const { act, store } = mount({ view: SETUP }, { act: async () => answers.shift() ?? true })
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '客户端 JSON' })
    const json = '{"web":{"client_id":"abc.apps.googleusercontent.com","client_secret":"GOCSPX-x"}}'
    fireEvent.change(box, { target: { value: `  ${json}\n` } })
    await flush(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(act).toHaveBeenCalledWith({ action: 'client', json })
    expect(box.value).toBe(`  ${json}\n`)
    await flush(async () => { fireEvent.click(screen.getByRole('button', { name: '保存' })) })
    expect(box.value).toBe('')
    flush(() => { store.update((draft) => { draft.busy = 'client' }) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '正在保存…' }).disabled).toBe(true)
    expect(box.disabled).toBe(true)
    flush(() => {
      store.update((draft) => {
        draft.busy = null
        draft.failure = { control: 'client', kind: 'refused', message: 'the JSON has no client_id and client_secret' }
      })
    })
    expect(screen.getByRole('alert').textContent).toBe('the JSON has no client_id and client_secret')
  })

  it('collapses a configured client to its id and a stored secret, never the secret itself, and offers to replace it', async () => {
    const { act } = mount({ view: VIEW })
    const summary = screen.getByText('Google OAuth 客户端')
    const details = summary.closest('details')!
    expect(details.open).toBe(false)
    const client = within(details)
    expect(client.getByText('abc.apps.googleusercontent.com')).toBeTruthy()
    expect(client.getByText('已保存（不在这里显示）')).toBeTruthy()
    expect(client.getByRole<HTMLInputElement>('textbox', { name: '重定向 URI' }).value).toBe('https://dsh.example.com/fork.gmail.oauth')
    expect(client.queryByRole('textbox', { name: '客户端 JSON' })).toBeNull()
    fireEvent.click(client.getByRole('button', { name: '更换客户端' }))
    fireEvent.click(client.getByRole('button', { name: '取消更换' }))
    expect(client.queryByRole('textbox', { name: '客户端 JSON' })).toBeNull()
    fireEvent.click(client.getByRole('button', { name: '更换客户端' }))
    fireEvent.change(client.getByRole('textbox', { name: '客户端 JSON' }), { target: { value: '{"web":{}}' } })
    await flush(async () => { fireEvent.click(client.getByRole('button', { name: '保存' })) })
    expect(act).toHaveBeenCalledWith({ action: 'client', json: '{"web":{}}' })
    expect(client.queryByRole('textbox', { name: '客户端 JSON' })).toBeNull()
    expect(client.getByRole('button', { name: '更换客户端' })).toBeTruthy()
  })

  it('says a configured client without a stored secret needs replacing, and selects the redirect URI on focus', () => {
    mount({ view: { ...VIEW, client: { configured: true, clientId: null, secretConfigured: false } } })
    expect(screen.getByText('没有保存，请更换客户端')).toBeTruthy()
    const uri = screen.getByRole<HTMLInputElement>('textbox', { name: '重定向 URI' })
    fireEvent.focus(uri)
    expect(uri.selectionEnd).toBe(uri.value.length)
  })
})
