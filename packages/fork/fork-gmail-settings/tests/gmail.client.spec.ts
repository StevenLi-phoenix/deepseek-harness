import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import {
  ADD_CONTROL, GmailLoader, RouteError, activityKind, activityWarns, ago, appPagesOf, controlOf, createGmailStore, doneLine, expiresAt,
  expiresSoon, failureLine, heldRows, looksLikeAddress, parseAnswer, parseView, parsesAsJson, redirectAccepted, redirectUriOf, relative,
  resolvedRows, timeFormatter, type Translate,
} from '../src/client/gmail.ts'
import * as dictionaries from '../src/client/locales.ts'
import { startPolling } from '../src/client/polling.ts'
import { ACCOUNT_ID_PATTERN, type GmailAction, type GmailAnswer, type GmailView, type PendingRow } from '../src/view.ts'

const t = makeTranslate(dictionaries.zh) as Translate
const AT = Date.parse('2026-11-12T14:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const HELD: PendingRow = {
  code: 'K7Q2MX', account: 'work', from: 'owner@example.com', to: ['ann@example.com'], cc: [], bcc: [], subject: 'Quarterly numbers',
  preview: 'Hi Ann', attachments: [], createdAt: AT - HOUR, origin: 'owner', reason: 'r', status: 'held', resolvedAt: null, resolvedBy: null,
  noticeSent: true,
}
const SENT: PendingRow = { ...HELD, code: 'SENT22', status: 'sent', resolvedAt: AT, resolvedBy: 'settings' }

const VIEW: GmailView = {
  client: { configured: true, clientId: 'abc.apps.googleusercontent.com', secretConfigured: true },
  redirectUri: null, accounts: [], pending: [HELD, SENT], activity: [], maxSendsPerDay: 50, confirmTtlHours: 72, trustedRecipients: [],
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Gmail section text', () => {
  it('words a distance in minutes, hours, and days, either way, and under a minute as now', () => {
    expect(relative(AT + 30_000, AT, t)).toBe('刚刚')
    expect(relative(AT + 5 * MINUTE, AT, t)).toBe('5 分钟后')
    expect(relative(AT - 5 * MINUTE, AT, t)).toBe('5 分钟前')
    expect(relative(AT + 3 * HOUR, AT, t)).toBe('3 小时后')
    expect(relative(AT - 47 * HOUR, AT, t)).toBe('47 小时前')
    expect(relative(AT + 71 * HOUR, AT, t)).toBe('2 天后')
    expect(relative(AT - 72 * HOUR, AT, t)).toBe('3 天前')
  })

  it('reads a Host time ahead of the browser as now', () => {
    expect(ago(AT + 10 * MINUTE, AT, t)).toBe('刚刚')
    expect(ago(AT - 10 * MINUTE, AT, t)).toBe('10 分钟前')
  })

  it('formats instants with the browser locale and zone', () => {
    expect(timeFormatter()(AT)).toBe(new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(AT))
  })

  it('expires a held message confirmTtlHours after it was written, and warns within six hours', () => {
    expect(expiresAt(HELD, 72)).toBe(AT + 71 * HOUR)
    expect(expiresSoon(6 * HOUR - 1)).toBe(true)
    expect(expiresSoon(6 * HOUR)).toBe(false)
  })

  it('splits the held messages from the resolved ones', () => {
    expect(heldRows(VIEW)).toEqual([HELD])
    expect(resolvedRows(VIEW)).toEqual([SENT])
  })


  it('accepts the account ids the service accepts', () => {
    for (const ok of ['work', 'personal', 'bot', 'a', 'w0rk-2', 'a'.repeat(24)]) expect(ACCOUNT_ID_PATTERN.test(ok)).toBe(true)
    for (const bad of ['', 'Work', '2work', '-a', 'work bot', 'a'.repeat(25), 'wörk']) expect(ACCOUNT_ID_PATTERN.test(bad)).toBe(false)
  })

  it('checks an address hint loosely and a pasted client file for JSON only', () => {
    expect(looksLikeAddress('me@example.com')).toBe(true)
    expect(looksLikeAddress('me example.com')).toBe(false)
    expect(looksLikeAddress('@example.com')).toBe(false)
    expect(parsesAsJson('{"web":{}}')).toBe(true)
    expect(parsesAsJson('{"web":')).toBe(false)
  })

  it('uses the configured redirect URI, else this page\'s origin with the OAuth path', () => {
    expect(redirectUriOf(VIEW, 'https://dsh.example.com')).toBe('https://dsh.example.com/fork.gmail.oauth')
    expect(redirectUriOf({ ...VIEW, redirectUri: 'https://mail.example.com/cb' }, 'https://dsh.example.com')).toBe('https://mail.example.com/cb')
  })

  it('puts the home page and privacy statement on the redirect URI\'s origin, else on this page\'s', () => {
    expect(appPagesOf('https://dsh.example.ts.net/fork.gmail.oauth', 'http://localhost:5173')).toEqual({
      home: 'https://dsh.example.ts.net/', privacy: 'https://dsh.example.ts.net/fork.gmail.privacy',
    })
    expect(appPagesOf('not a url', 'https://dsh.example.com')).toEqual({ home: 'https://dsh.example.com/', privacy: 'https://dsh.example.com/fork.gmail.privacy' })
  })

  it('accepts the redirect URIs Google accepts: https on a domain, or http on localhost', () => {
    for (const ok of ['https://dsh.example.com/fork.gmail.oauth', 'http://localhost:5173/fork.gmail.oauth', 'http://127.0.0.1:8080/x']) {
      expect(redirectAccepted(ok)).toBe(true)
    }
    for (const bad of ['http://192.168.1.5:8080/x', 'http://mini.example.com/x', 'https://100.64.0.1/x', 'https://mini/x', 'ftp://example.com/x', 'not a url']) {
      expect(redirectAccepted(bad)).toBe(false)
    }
  })

  it('names the activity kinds the service writes and keeps an unknown one as written', () => {
    expect(activityKind('confirmed', t)).toBe('确认发送')
    expect(activityKind('archived', t)).toBe('archived')
    expect(activityWarns('refused')).toBe(true)
    expect(activityWarns('sent')).toBe(false)
  })

  it('words what each action did', () => {
    const line = (action: GmailAction['action'], target: string) => doneLine({ control: 'c', action, target }, t)
    expect(line('client', '')).toBe('Google OAuth 客户端已保存')
    expect(line('sign-in', 'work')).toBe('正在打开 Google 登录页（work）…')
    expect(line('policy', 'work')).toBe('work 的发信规则已保存')
    expect(line('remove', 'work')).toBe('已断开 work')
    expect(line('confirm', 'Hello')).toBe('已发送「Hello」')
    expect(line('discard', 'Hello')).toBe('已丢弃「Hello」，不会发出，Gmail 里的草稿也会删掉')
  })

  it('shows the Host\'s words for a refusal and generic copy for the other failures', () => {
    expect(failureLine({ control: 'c', kind: 'refused', message: 'the draft changed' }, t)).toBe('the draft changed')
    expect(failureLine({ control: 'c', kind: 'failed' }, t)).toBe(t('error.generic'))
    expect(failureLine({ control: 'c', kind: 'offline' }, t)).toBe(t('error.offline'))
  })

  it('names the control of each action', () => {
    expect(controlOf({ action: 'client', json: '{}' })).toBe('client')
    expect(controlOf({ action: 'sign-in', account: 'work' })).toBe('sign-in:work')
    expect(controlOf({ action: 'policy', account: 'work', policy: 'direct' })).toBe('policy:work')
    expect(controlOf({ action: 'remove', account: 'work' })).toBe('remove:work')
    expect(controlOf({ action: 'confirm', code: 'K7Q2MX' })).toBe('confirm:K7Q2MX')
    expect(controlOf({ action: 'discard', code: 'K7Q2MX' })).toBe('discard:K7Q2MX')
  })

  it('has the same keys and the same placeholders in every dictionary', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort()
    const { zh, ...others } = dictionaries
    for (const [name, dictionary] of Object.entries(others)) {
      expect(Object.keys(dictionary).sort(), name).toEqual(Object.keys(zh).sort())
      for (const [key, text] of Object.entries(zh)) expect(placeholders(dictionary[key as keyof typeof zh]), `${name} ${key}`).toEqual(placeholders(text))
    }
  })
})

describe('route answers', () => {
  it('refuses a status whose outer fields are the wrong type', () => {
    expect(parseView(VIEW)).toBe(VIEW)
    expect(() => parseView(null)).toThrow(RouteError)
    for (const bad of [
      { ...VIEW, client: null }, { ...VIEW, client: 'x' }, { ...VIEW, accounts: {} }, { ...VIEW, pending: null }, { ...VIEW, activity: 1 },
      { ...VIEW, trustedRecipients: 'a' }, { ...VIEW, maxSendsPerDay: '50' }, { ...VIEW, confirmTtlHours: null },
    ]) {
      expect(() => parseView(bad)).toThrow('unexpected Gmail answer')
    }
  })

  it('takes an action answer with its status, and a sign-in page only over https', () => {
    expect(parseAnswer({ status: VIEW })).toEqual({ status: VIEW })
    expect(parseAnswer({ status: VIEW, signInUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }))
      .toEqual({ status: VIEW, signInUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' })
    expect(() => parseAnswer(null)).toThrow('unexpected Gmail answer')
    expect(() => parseAnswer({ status: VIEW, signInUrl: 'javascript:alert(1)' })).toThrow('unexpected sign-in page')
    expect(() => parseAnswer({ status: VIEW, signInUrl: 5 })).toThrow(RouteError)
  })
})

function loader(post: (action: GmailAction) => Promise<GmailAnswer>, read: () => Promise<GmailView> = async () => VIEW) {
  const store = createGmailStore()
  const navigate = vi.fn()
  let now = AT
  const instance = new GmailLoader(store, read, post, navigate, () => now)
  return { store, navigate, loader: instance, tick: (ms: number) => { now += ms } }
}

describe('loader', () => {
  it('shares one read among concurrent refreshes and keeps the last status through a failed one, warning once', async () => {
    let fail = false
    const read = vi.fn(async () => { if (fail) throw new Error('down'); return VIEW })
    const { store, loader: gmail, tick } = loader(async () => ({ status: VIEW }), read)
    await Promise.all([gmail.refresh(), gmail.refresh()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, at: AT, stale: false })
    fail = true
    tick(15_000)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await gmail.refresh()
    await gmail.refresh()
    expect(store.getSnapshot()).toMatchObject({ view: VIEW, at: AT + 15_000, stale: true })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[fork-gmail-settings] Gmail status read failed')
  })

  it('marks the clicked control busy, then shows the answered status and what the action did', async () => {
    const after: GmailView = { ...VIEW, pending: [{ ...HELD, status: 'discarded', resolvedAt: AT, resolvedBy: 'settings' }] }
    const gate = Promise.withResolvers<GmailAnswer>()
    const post = vi.fn(() => gate.promise)
    const { store, loader: gmail } = loader(post)
    await gmail.refresh()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const running = gmail.act({ action: 'discard', code: 'K7Q2MX' })
    expect(store.getSnapshot()).toMatchObject({ busy: 'discard:K7Q2MX', failure: null, done: null })
    expect(await gmail.act({ action: 'confirm', code: 'K7Q2MX' })).toBe(false)
    expect(post).toHaveBeenCalledTimes(1)
    gate.resolve({ status: after })
    expect(await running).toBe(true)
    expect(store.getSnapshot()).toMatchObject({
      view: after, busy: null, failure: null, done: { control: 'discard:K7Q2MX', action: 'discard', target: 'Quarterly numbers' },
    })
  })

  it('names a message without a subject, or one the page never read, by its code', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { store, loader: gmail } = loader(async () => ({ status: VIEW }))
    await gmail.act({ action: 'confirm', code: 'NOSUCH' })
    expect(store.getSnapshot().done?.target).toBe('NOSUCH')
    await gmail.refresh()
    store.update((draft) => { draft.view = { ...VIEW, pending: [{ ...HELD, subject: '' }] } })
    await gmail.act({ action: 'confirm', code: 'K7Q2MX' })
    expect(store.getSnapshot().done).toEqual({ control: 'confirm:K7Q2MX', action: 'confirm', target: 'K7Q2MX' })
    await gmail.act({ action: 'client', json: '{}' }, 'custom')
    expect(store.getSnapshot().done).toEqual({ control: 'custom', action: 'client', target: '' })
  })

  it('opens the sign-in page an answer carries, and calls a sign-in without one a failure', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    let url: string | undefined = 'https://accounts.google.com/auth'
    const { store, navigate, loader: gmail } = loader(async () => (url === undefined ? { status: VIEW } : { status: VIEW, signInUrl: url }))
    expect(await gmail.act({ action: 'sign-in', account: 'bot', policy: 'direct' }, ADD_CONTROL)).toBe(true)
    expect(navigate).toHaveBeenCalledWith('https://accounts.google.com/auth')
    expect(store.getSnapshot()).toMatchObject({ busy: null, done: { control: 'add', action: 'sign-in', target: 'bot' } })
    url = undefined
    expect(await gmail.act({ action: 'sign-in', account: 'work' })).toBe(false)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toMatchObject({ busy: null, done: null, failure: { control: 'sign-in:work', kind: 'failed' } })
  })

  it('keeps a refusal\'s words, calls other answered failures and a lost connection generic, and never logs the action body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let error: unknown = new RouteError('refused', 'the client id must end in .apps.googleusercontent.com')
    const { store, loader: gmail } = loader(async () => { throw error })
    expect(await gmail.act({ action: 'client', json: '{"web":{"client_secret":"GOCSPX-hidden"}}' })).toBe(false)
    expect(store.getSnapshot()).toMatchObject({
      busy: null, failure: { control: 'client', kind: 'refused', message: 'the client id must end in .apps.googleusercontent.com' },
    })
    error = new RouteError('failed', 'HTTP 500')
    await gmail.act({ action: 'remove', account: 'work' })
    expect(store.getSnapshot().failure).toEqual({ control: 'remove:work', kind: 'failed' })
    error = new TypeError('Failed to fetch')
    await gmail.act({ action: 'policy', account: 'work', policy: 'direct' })
    expect(store.getSnapshot().failure).toEqual({ control: 'policy:work', kind: 'offline' })
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
      '[fork-gmail-settings] client refused after 0 ms',
      '[fork-gmail-settings] remove failed after 0 ms',
      '[fork-gmail-settings] policy offline after 0 ms',
    ])
  })

  it('drops a read that started before an action answered, so the newer status stays', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const older = Promise.withResolvers<GmailView>()
    const newer: GmailView = { ...VIEW, maxSendsPerDay: 7 }
    const { store, loader: gmail } = loader(async () => ({ status: newer }), () => older.promise)
    const reading = gmail.refresh()
    await gmail.act({ action: 'policy', account: 'work', policy: 'direct' })
    older.resolve(VIEW)
    await reading
    expect(store.getSnapshot()).toMatchObject({ view: newer, stale: false })
  })
})

describe('polling', () => {
  function page() {
    const listeners: Array<() => void> = []
    const source = {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_: 'visibilitychange', listener: () => void) => { listeners.push(listener) },
      removeEventListener: vi.fn(),
    }
    return { source, fire: () => { for (const listener of listeners) listener() } }
  }

  it('refreshes at once and on the interval while visible, stops while hidden, and refreshes again on return', () => {
    vi.useFakeTimers()
    const { source, fire } = page()
    const refresh = vi.fn()
    const stop = startPolling(refresh, 1000, source)
    vi.advanceTimersByTime(2000)
    expect(refresh).toHaveBeenCalledTimes(3)
    fire()
    expect(refresh).toHaveBeenCalledTimes(3)
    source.visibilityState = 'hidden'
    fire()
    fire()
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(3)
    source.visibilityState = 'visible'
    fire()
    expect(refresh).toHaveBeenCalledTimes(4)
    stop()
    vi.advanceTimersByTime(5000)
    expect(refresh).toHaveBeenCalledTimes(4)
    expect(source.removeEventListener).toHaveBeenCalledTimes(1)
  })

  it('polls without a page, and from the runtime\'s document when none is given', () => {
    vi.useFakeTimers()
    const bare = vi.fn()
    const stopBare = startPolling(bare, 1000, null)
    vi.advanceTimersByTime(1000)
    expect(bare).toHaveBeenCalledTimes(2)
    stopBare()
    const fallback = vi.fn()
    const stop = startPolling(fallback, 1000)
    vi.advanceTimersByTime(1000)
    expect(fallback).toHaveBeenCalledTimes(2)
    stop()
    vi.advanceTimersByTime(3000)
    expect(fallback).toHaveBeenCalledTimes(2)
  })
})
