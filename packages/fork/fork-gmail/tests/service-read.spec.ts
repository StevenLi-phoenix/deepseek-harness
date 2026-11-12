import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GmailError, MODIFY_ACTIONS, type ModifyAction, type SendPolicy } from '../src/index.ts'
import {
  apiPath, connect, disposeAll, googleError, HOUR, mount, ownerTurn, rejection, START, type FakeMailbox, type MountOptions, type Mounted,
} from './fixture.ts'

const OWNER = 'owner@example.com'
/** When the access token of a sign-in at START is refreshed (one minute before it expires). */
const TOKEN_STALE = START + HOUR - 60_000

let workdir = ''

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  workdir = await mkdtemp(join(tmpdir(), 'fork-gmail-read-'))
})

afterEach(async () => {
  await disposeAll()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await rm(workdir, { recursive: true, force: true })
})

async function account(policy: SendPolicy = 'confirm-untrusted', options: MountOptions = {}): Promise<Mounted & { box: FakeMailbox }> {
  const env = await mount(options)
  await connect(env, 'work', OWNER, policy)
  return { ...env, box: env.google.mailbox(OWNER) }
}

async function gmailFailure(promise: Promise<unknown>): Promise<GmailError> {
  const error = await rejection(promise)
  expect(error).toBeInstanceOf(GmailError)
  return error as GmailError
}

function headers(values: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(values).map(([name, value]) => ({ name, value }))
}

function text(body: string): { mimeType: string; body: { data: string } } {
  return { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } }
}

describe('search', () => {
  it('summarizes each thread from its first and newest messages', async () => {
    const env = await account()
    env.box.threads.set('t1', {
      id: 't1',
      messages: [
        { id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: 'first', internalDate: '1000', payload: { headers: headers({ Subject: 'Plan', From: 'Ada <ada@example.com>' }) } },
        { id: 'm2', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], snippet: 'Tom &amp; Jerry', internalDate: '2000', payload: { headers: headers({ Subject: 'Re: Plan', From: 'Grace <grace@example.com>' }) } },
      ],
    })
    env.box.threads.set('t2', { id: 't2' })
    env.box.threads.set('t3', { id: 't3', messages: [{ id: 'm3', threadId: 't3', internalDate: 'n/a' }] })
    const result = await env.gmail.search('work', 'in:inbox', { max: 5, pageToken: 'p1' })
    expect(result).toEqual({
      threads: [
        { id: 't1', subject: 'Plan', from: 'Grace <grace@example.com>', date: 2000, snippet: 'Tom & Jerry', messages: 2, unread: true, labels: ['INBOX', 'UNREAD'] },
        { id: 't2', subject: '', from: '', date: null, snippet: 'entry t2', messages: 0, unread: false, labels: [] },
        { id: 't3', subject: '', from: '', date: null, snippet: 'entry t3', messages: 1, unread: false, labels: [] },
      ],
      nextPageToken: null,
      estimate: 3,
    })
    const [list] = env.google.callsTo('GET', '/threads')
    expect(Object.fromEntries(list?.url.searchParams ?? [])).toEqual({ q: 'in:inbox', maxResults: '5', pageToken: 'p1' })
    expect(env.google.callsTo('GET', /^\/threads\/t\d$/u).map(call => call.url.searchParams.get('format'))).toEqual(['metadata', 'metadata', 'metadata'])
    expect(env.logs).toContain('info fork-gmail: work search ok in 0 ms: 3 thread(s)')
  })

  it('passes on the next page token and Google\'s estimate, and reads a thread entry without a snippet as empty', async () => {
    const env = await account()
    env.box.threads.set('t1', { id: 't1', messages: [{ id: 'm1', threadId: 't1' }] })
    env.google.intercept = call => (apiPath(call.url) === '/threads'
      ? Response.json({ threads: [{ id: 't1' }], nextPageToken: 'p2', resultSizeEstimate: 42 })
      : undefined)
    expect(await env.gmail.search('work', 'x')).toMatchObject({ threads: [{ id: 't1', snippet: '' }], nextPageToken: 'p2', estimate: 42 })
  })

  it('asks for 10 threads by default, at least 1, and never more than maxSearchResults', async () => {
    const wide = await account()
    await wide.gmail.search('work', 'a')
    const env = await account('confirm-untrusted', { config: { maxSearchResults: 3 } })
    await env.gmail.search('work', 'a', { max: 50 })
    await env.gmail.search('work', 'a', { max: 0 })
    await env.gmail.search('work', 'a')
    expect(wide.google.callsTo('GET', '/threads').map(call => call.url.searchParams.get('maxResults'))).toEqual(['10'])
    expect(env.google.callsTo('GET', '/threads').map(call => call.url.searchParams.get('maxResults'))).toEqual(['3', '1', '3'])
  })

  it('answers a search without matches with no threads', async () => {
    const env = await account()
    expect(await env.gmail.search('work', 'from:nobody')).toEqual({ threads: [], nextPageToken: null, estimate: 0 })
  })
})

describe('reading', () => {
  it('shows the newest maxThreadMessages messages of a thread in full, counting the rest, with quoted history cut unless kept', async () => {
    const env = await account('confirm-untrusted', { config: { maxThreadMessages: 3 } })
    env.box.threads.set('t1', {
      id: 't1',
      messages: Array.from({ length: 5 }, (_, index) => ({
        id: `m${index}`, threadId: 't1', payload: { ...text(`Reply ${index}\n\n> earlier words`), headers: headers({ Subject: 'Plan' }) },
      })),
    })
    env.box.threads.set('empty', { id: 'empty' })
    const thread = await env.gmail.thread('work', 't1')
    expect(thread.omitted).toBe(2)
    expect(thread.messages.map(message => [message.id, message.text, message.quoteTrimmed])).toEqual([
      ['m2', 'Reply 2', true], ['m3', 'Reply 3', true], ['m4', 'Reply 4', true],
    ])
    expect((await env.gmail.thread('work', 't1', true)).messages[0]?.text).toBe('Reply 2\n\n> earlier words')
    expect(env.google.callsTo('GET', '/threads/t1').map(call => call.url.searchParams.get('format'))).toEqual(['full', 'full'])
    expect(await env.gmail.thread('work', 'empty')).toEqual({ id: 'empty', messages: [], omitted: 0 })
    expect(env.logs).toContain('info fork-gmail: work read thread ok in 0 ms: 3 message(s)')
  })

  it('reads one message, cut at maxBodyChars', async () => {
    const env = await account('confirm-untrusted', { config: { maxBodyChars: 500 } })
    env.box.messages.set('m1', { id: 'm1', threadId: 't1', payload: { ...text(`${'a'.repeat(600)}\n\nOn Mon, Nov 9, 2026 Ada wrote:\n> x`), headers: headers({ From: 'Ada <ada@example.com>' }) } })
    const view = await env.gmail.message('work', 'm1')
    expect(view).toMatchObject({ id: 'm1', from: 'Ada <ada@example.com>', text: `${'a'.repeat(500)}…`, textChars: 600, quoteTrimmed: true })
    expect((await env.gmail.message('work', 'm1', true)).quoteTrimmed).toBe(false)
    expect(env.logs).toContain('info fork-gmail: work read message ok in 0 ms')
  })

  it('reports a message that does not exist as not-found and records the failure on the account', async () => {
    const env = await account()
    expect(await gmailFailure(env.gmail.message('work', 'gone'))).toMatchObject({ failure: 'not-found', message: expect.stringContaining('HTTP 404 notFound') as string })
    expect(env.gmail.accounts()[0]?.lastError).toContain('HTTP 404 notFound')
  })
})

describe('attachment downloads', () => {
  const MESSAGE_ID = 'msg-abcdefgh12345678'

  function withAttachments(box: FakeMailbox): void {
    box.attachments.set('A1', Buffer.from('pdf').toString('base64url'))
    box.messages.set(MESSAGE_ID, {
      id: MESSAGE_ID, threadId: 't1',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          { partId: '0', ...text('see attached') },
          { partId: '1', filename: 'report.pdf', mimeType: 'application/pdf', body: { attachmentId: 'A1', size: 3 } },
          { partId: '2', filename: '../logo.png', mimeType: 'image/png', body: { data: Buffer.from('png!').toString('base64url') } },
          { partId: '3', filename: 'raw.bin', body: { data: Buffer.from('bin').toString('base64url'), size: 3 } },
          { partId: '4', filename: 'huge.iso', mimeType: 'application/x-iso9660-image', body: { attachmentId: 'A2', size: 50 } },
          { partId: '5', filename: 'liar.txt', mimeType: 'text/plain', body: { data: Buffer.from('x'.repeat(40)).toString('base64url'), size: 1 } },
        ],
      },
    })
    box.messages.set('plain', { id: 'plain', threadId: 't2', payload: text('no files') })
  }

  it('saves an attachment by its part id under .gmail-inbox, fetched by id or read inline', async () => {
    const env = await account()
    withAttachments(env.box)
    expect(await env.gmail.download('work', MESSAGE_ID, '1', workdir)).toEqual({
      path: join(workdir, '.gmail-inbox', '12345678-report.pdf'), filename: 'report.pdf', mimeType: 'application/pdf', bytes: 3,
    })
    expect(await readFile(join(workdir, '.gmail-inbox', '12345678-report.pdf'), 'utf8')).toBe('pdf')
    expect(env.google.callsTo('GET', `/messages/${MESSAGE_ID}/attachments/A1`)).toHaveLength(1)
    const inline = await env.gmail.download('work', MESSAGE_ID, '2', workdir)
    expect(inline).toMatchObject({ path: join(workdir, '.gmail-inbox', '12345678-logo.png'), filename: '../logo.png', mimeType: 'image/png', bytes: 4 })
    expect((await env.gmail.download('work', MESSAGE_ID, '3', workdir)).mimeType).toBe('application/octet-stream')
    expect(env.google.callsTo('GET', /\/attachments\//u)).toHaveLength(1)
    expect(env.logs).toContain('info fork-gmail: work attachment ok in 0 ms: 3 bytes')
  })

  it('refuses a part that is not an attachment, listing the attachments the message has', async () => {
    const env = await account()
    withAttachments(env.box)
    expect(await gmailFailure(env.gmail.download('work', MESSAGE_ID, '0', workdir))).toMatchObject({
      failure: 'not-found',
      message: `message ${MESSAGE_ID} has no attachment part "0"; its attachments: 1 (report.pdf), 2 (../logo.png), 3 (raw.bin), 4 (huge.iso), 5 (liar.txt)`,
    })
    expect(await gmailFailure(env.gmail.download('work', 'plain', '1', workdir))).toMatchObject({ message: 'message plain has no attachment part "1"; its attachments: none' })
  })

  it('refuses an attachment over maxDownloadBytes, by its declared size or by the bytes Gmail sends', async () => {
    const env = await account('confirm-untrusted', { config: { maxDownloadBytes: 10 } })
    withAttachments(env.box)
    expect(await gmailFailure(env.gmail.download('work', MESSAGE_ID, '4', workdir))).toMatchObject({
      failure: 'limit', message: 'the attachment holds 50 bytes, over the 10-byte limit',
    })
    expect(env.google.callsTo('GET', /\/attachments\//u)).toHaveLength(0)
    expect(await gmailFailure(env.gmail.download('work', MESSAGE_ID, '5', workdir))).toMatchObject({
      failure: 'limit', message: 'the attachment holds 40 bytes, over the 10-byte limit',
    })
    await expect(readFile(join(workdir, '.gmail-inbox', '.gitignore'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('label changes', () => {
  async function labelled(policy: SendPolicy = 'confirm-untrusted'): Promise<Mounted & { box: FakeMailbox }> {
    const env = await account(policy)
    for (const id of ['t1', 't2']) env.box.threads.set(id, { id })
    env.box.labels = [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'Label_1', name: 'Receipts', type: 'user' }, { id: 'Label_2', name: 'Travel/2026' }]
    return env
  }

  function changes(env: Mounted): unknown[] {
    return env.google.callsTo('POST', /\/modify$/u).map(call => [apiPath(call.url), JSON.parse(call.body) as { addLabelIds: string[]; removeLabelIds: string[] }])
  }

  it('maps each read, inbox, and star change to its system label', async () => {
    const env = await labelled()
    const expected: Record<Exclude<ModifyAction, 'trash' | 'untrash' | 'label' | 'unlabel'>, [string[], string[]]> = {
      read: [[], ['UNREAD']], unread: [['UNREAD'], []], archive: [[], ['INBOX']], inbox: [['INBOX'], []], star: [['STARRED'], []], unstar: [[], ['STARRED']],
    }
    for (const [action, [add, remove]] of Object.entries(expected)) {
      env.google.calls.length = 0
      expect(await env.gmail.modify('work', ['t1', 't2'], action as ModifyAction)).toEqual({ changed: 2 })
      expect(changes(env)).toEqual([
        ['/threads/t1/modify', { addLabelIds: add, removeLabelIds: remove }], ['/threads/t2/modify', { addLabelIds: add, removeLabelIds: remove }],
      ])
    }
    expect((await env.gmail.status()).activity[0]).toMatchObject({ kind: 'modified', detail: 'unstar on 2 thread(s)' })
    expect(MODIFY_ACTIONS).toEqual(['read', 'unread', 'archive', 'inbox', 'star', 'unstar', 'trash', 'untrash', 'label', 'unlabel'])
  })

  it('adds and removes an account label named in any case, or by its id', async () => {
    const env = await labelled()
    await env.gmail.modify('work', ['t1'], 'label', '  receipts ')
    await env.gmail.modify('work', ['t2'], 'unlabel', 'label_2')
    expect(changes(env)).toEqual([
      ['/threads/t1/modify', { addLabelIds: ['Label_1'], removeLabelIds: [] }], ['/threads/t2/modify', { addLabelIds: [], removeLabelIds: ['Label_2'] }],
    ])
    expect((await env.gmail.status()).activity[0]).toMatchObject({ detail: 'unlabel label_2 on 1 thread(s)' })
  })

  it('refuses an unknown label, listing the account\'s own labels, and a missing label name', async () => {
    const env = await labelled()
    expect(await gmailFailure(env.gmail.modify('work', ['t1'], 'label', 'Taxes'))).toMatchObject({
      failure: 'not-found', message: 'no label "Taxes"; the account has: Receipts, Travel/2026',
    })
    env.box.labels = [{ id: 'INBOX', name: 'INBOX', type: 'system' }]
    expect(await gmailFailure(env.gmail.modify('work', ['t1'], 'unlabel', 'Taxes'))).toMatchObject({ message: 'no label "Taxes"; the account has: no labels of its own' })
    for (const label of [undefined, '  ']) {
      expect(await gmailFailure(env.gmail.modify('work', ['t1'], 'label', label))).toMatchObject({ failure: 'invalid', message: 'label and unlabel need the label name' })
    }
    expect(changes(env)).toEqual([])
  })

  it('moves threads to the trash and back through their own endpoints', async () => {
    const env = await labelled()
    expect(await env.gmail.modify('work', ['t1', 't2'], 'trash')).toEqual({ changed: 2 })
    expect(await env.gmail.modify('work', ['t1'], 'untrash')).toEqual({ changed: 1 })
    expect(env.google.callsTo('POST', /\/(trash|untrash)$/u).map(call => apiPath(call.url))).toEqual([
      '/threads/t1/trash', '/threads/t2/trash', '/threads/t1/untrash',
    ])
    expect(changes(env)).toEqual([])
  })

  it('takes between 1 and 50 threads, refuses a read-only account, and reports an unknown thread as not-found', async () => {
    const env = await labelled()
    for (const ids of [[], Array.from({ length: 51 }, (_, index) => `t${index}`)]) {
      expect(await gmailFailure(env.gmail.modify('work', ids, 'read'))).toMatchObject({ failure: 'invalid', message: 'give between 1 and 50 thread ids' })
    }
    expect(await gmailFailure(env.gmail.modify('work', ['nope'], 'star'))).toMatchObject({ failure: 'not-found' })
    await env.gmail.setPolicy('work', 'read-only')
    expect(await gmailFailure(env.gmail.modify('work', ['t1'], 'read'))).toMatchObject({ failure: 'refused' })
  })
})

describe('access tokens', () => {
  it('uses the sign-in\'s access token until a minute before it expires, then refreshes once for concurrent calls', async () => {
    const env = await account()
    env.box.messages.set('m1', { id: 'm1', threadId: 't1' })
    await env.gmail.search('work', 'a')
    vi.setSystemTime(TOKEN_STALE - 1)
    await env.gmail.search('work', 'a')
    expect(env.google.tokenCalls('refresh_token')).toHaveLength(0)
    vi.setSystemTime(TOKEN_STALE)
    await Promise.all([env.gmail.search('work', 'a'), env.gmail.search('work', 'b'), env.gmail.message('work', 'm1')])
    const refreshes = env.google.tokenCalls('refresh_token')
    expect(refreshes).toHaveLength(1)
    expect(refreshes[0]?.get('refresh_token')).toBe(env.credentials.refreshToken('work'))
    await env.gmail.search('work', 'c')
    expect(env.google.tokenCalls('refresh_token')).toHaveLength(1)
  })

  it('retries a call once with a fresh token after Gmail answers 401', async () => {
    const env = await account()
    env.google.accessEmail.clear()
    expect(await env.gmail.search('work', 'a')).toMatchObject({ threads: [] })
    expect(env.google.tokenCalls('refresh_token')).toHaveLength(1)
    expect(env.google.callsTo('GET', '/threads')).toHaveLength(2)
  })

  it('stores a refresh token Google rotates, and leaves one Google repeats', async () => {
    const env = await account()
    const first = env.credentials.refreshToken('work')
    env.google.rotate = true
    vi.setSystemTime(TOKEN_STALE)
    await env.gmail.search('work', 'a')
    const rotated = env.credentials.refreshToken('work')
    expect(rotated).not.toBe(first)
    expect(env.credentials.records.get('fork-gmail/work')).toMatchObject({ kind: 'grant', payload: { email: OWNER, refreshToken: rotated, grantedAt: START } })
    expect(env.logs.filter(line => line === 'info fork-gmail: work: Google rotated the refresh token; stored')).toHaveLength(1)
    env.google.rotate = false
    env.google.echo = true
    vi.setSystemTime(TOKEN_STALE + HOUR)
    await env.gmail.search('work', 'a')
    expect(env.google.tokenCalls('refresh_token')).toHaveLength(2)
    expect(env.credentials.refreshToken('work')).toBe(rotated)
    expect(env.logs.filter(line => line.includes('rotated the refresh token'))).toHaveLength(1)
  })

  it('marks the account for a new sign-in when Google refuses the grant, tells the owner once, and fails later calls at once', async () => {
    const env = await account()
    env.google.refused.add(env.credentials.refreshToken('work') ?? '')
    vi.setSystemTime(TOKEN_STALE)
    expect(await gmailFailure(env.gmail.search('work', 'a'))).toMatchObject({
      failure: 'needs-reconnect', message: 'Google no longer accepts the sign-in of Gmail account "work"; the owner signs in again in Settings → 邮箱',
    })
    expect(env.gmail.accounts()[0]).toMatchObject({
      needsReconnect: true, reconnectNoticeAt: TOKEN_STALE, lastError: 'Google refused the grant (invalid_grant: Token has been expired or revoked.)',
    })
    expect(env.notes).toEqual([{
      title: `⚠️ Gmail work（${OWNER}）要重新登录`,
      body: 'Google 不再接受这个账号的登录（Google refused the grant (invalid_grant: Token has been expired or revoked.)）。在 设置 → 邮箱 里点「重新登录」；在那之前不能读信或发信。',
      kinds: ['gmail.reconnect'],
      origin: expect.stringContaining('fork-gmail') as string,
    }])
    const later = `Gmail account "work" (${OWNER}) must be signed in again by the owner in Settings → 邮箱`
    for (const call of [
      env.gmail.search('work', 'b'),
      env.gmail.send('work', { kind: 'new', message: { to: ['ada@example.com'], cc: [], bcc: [], subject: 's', body: 'b', attachments: [] } }, ownerTurn()),
      env.gmail.modify('work', ['t1'], 'read'),
    ]) {
      expect(await gmailFailure(call)).toMatchObject({ failure: 'needs-reconnect', message: later })
    }
    expect(env.notes).toHaveLength(1)
    expect(env.google.tokenCalls('refresh_token')).toHaveLength(1)
    expect((await env.gmail.status()).activity[0]).toMatchObject({ kind: 'reconnect', account: 'work' })
    expect(env.logs.some(line => line.startsWith('warn fork-gmail: work: needs a new sign-in (Google refused the grant'))).toBe(true)
    expect(await connect(env, 'work', OWNER)).toMatchObject({ needsReconnect: false, reconnectNoticeAt: null })
    expect(await env.gmail.search('work', 'b')).toMatchObject({ threads: [] })
  })

  it('marks the account for a new sign-in without a notice time when the notice cannot go out', async () => {
    const env = await account('confirm-untrusted', { noNotifier: true })
    env.google.refused.add(env.credentials.refreshToken('work') ?? '')
    vi.setSystemTime(TOKEN_STALE)
    expect(await gmailFailure(env.gmail.search('work', 'a'))).toMatchObject({ failure: 'needs-reconnect' })
    expect(env.gmail.accounts()[0]).toMatchObject({ needsReconnect: true, reconnectNoticeAt: null })
    expect(env.logs).toContain(`warn fork-gmail: could not send "⚠️ Gmail work（${OWNER}）要重新登录": no forkNotifier service is mounted`)
  })

  it('tells the owner once when two calls in flight both find the grant refused', async () => {
    const env = await account()
    for (const id of ['t1']) env.box.threads.set(id, { id })
    let release: (response: Response) => void = () => undefined
    const held = new Promise<Response>((resolve) => { release = resolve })
    let once = true
    env.google.intercept = (call) => {
      if (apiPath(call.url) !== '/labels' || !once) return undefined
      once = false
      return held
    }
    const labelling = env.gmail.modify('work', ['t1'], 'label', 'Receipts')
    await vi.waitFor(() => { expect(env.google.callsTo('GET', '/labels')).toHaveLength(1) })
    env.google.accessEmail.clear()
    env.google.refused.add(env.credentials.refreshToken('work') ?? '')
    expect(await gmailFailure(env.gmail.search('work', 'a'))).toMatchObject({ failure: 'needs-reconnect' })
    release(googleError(401, 'Request had invalid authentication credentials.'))
    expect(await gmailFailure(labelling)).toMatchObject({ failure: 'needs-reconnect' })
    expect(env.google.tokenCalls('refresh_token')).toHaveLength(2)
    expect(env.notes).toHaveLength(1)
  })

  it('reports a missing, foreign, or unreadable grant record as needing a new sign-in', async () => {
    const env = await account()
    await connect(env, 'second', 'second@example.com')
    await connect(env, 'third', 'third@example.com')
    await env.credentials.deleteRecord('fork-gmail/work')
    env.credentials.records.set('fork-gmail/second', { kind: 'api-key', key: 'not-a-grant' })
    env.credentials.records.set('fork-gmail/third', { kind: 'grant', payload: { email: 'third@example.com', refreshToken: '' } })
    vi.setSystemTime(TOKEN_STALE)
    for (const id of ['work', 'second', 'third']) {
      expect(await gmailFailure(env.gmail.search(id, 'a'))).toMatchObject({
        failure: 'needs-reconnect', message: `Gmail account "${id}" has no stored sign-in; the owner signs in again in Settings → 邮箱`,
      })
    }
    expect(env.gmail.accounts().map(row => [row.id, row.needsReconnect, row.lastError])).toEqual([
      ['second', true, 'no stored sign-in'], ['third', true, 'no stored sign-in'], ['work', true, 'no stored sign-in'],
    ])
    expect(env.google.tokenCalls('refresh_token')).toHaveLength(0)
  })

  it('reports a failing token endpoint as an api failure on the account, and a missing client as not-configured', async () => {
    const env = await account()
    env.google.intercept = call => (call.url.pathname === '/token' ? new Response('busy', { status: 503 }) : undefined)
    vi.setSystemTime(TOKEN_STALE)
    expect(await gmailFailure(env.gmail.search('work', 'a'))).toMatchObject({ failure: 'api', message: 'Google\'s token endpoint answered HTTP 503' })
    expect(env.gmail.accounts()[0]).toMatchObject({ needsReconnect: false, lastError: 'Google\'s token endpoint answered HTTP 503' })
    env.google.intercept = undefined
    await env.gmail.search('work', 'a')
    expect(env.gmail.accounts()[0]).toMatchObject({ lastError: null, lastOkAt: TOKEN_STALE })
    env.credentials.values.clear()
    vi.setSystemTime(TOKEN_STALE + HOUR)
    expect(await gmailFailure(env.gmail.search('work', 'a'))).toMatchObject({ failure: 'not-configured' })
    expect(env.gmail.accounts()[0]?.lastError).toBeNull()
  })
})

describe('account health', () => {
  it('records a success at most every five minutes, and a failure until the next success', async () => {
    const env = await account()
    vi.setSystemTime(START + 60_000)
    await env.gmail.search('work', 'a')
    expect(env.gmail.accounts()[0]?.lastOkAt).toBe(START)
    vi.setSystemTime(START + 5 * 60_000)
    await env.gmail.search('work', 'a')
    expect(env.gmail.accounts()[0]?.lastOkAt).toBe(START + 5 * 60_000)
    env.google.intercept = call => (apiPath(call.url) === '/threads' ? googleError(400, `Invalid query ${'x'.repeat(400)}`, 'invalidArgument') : undefined)
    vi.setSystemTime(START + 6 * 60_000)
    const failure = await gmailFailure(env.gmail.search('work', 'a'))
    expect(failure).toMatchObject({ failure: 'api', message: expect.stringContaining('Gmail GET /threads failed with HTTP 400 invalidArgument: Invalid query') as string })
    const row = env.gmail.accounts()[0]
    expect(row?.lastError).toBe(failure.message.slice(0, 300))
    expect(row?.lastOkAt).toBe(START + 5 * 60_000)
    expect(env.logs.some(line => line.startsWith('warn fork-gmail: work search failed in 0 ms: Gmail GET /threads failed'))).toBe(true)
    env.google.intercept = undefined
    vi.setSystemTime(START + 7 * 60_000)
    await env.gmail.search('work', 'a')
    expect(env.gmail.accounts()[0]).toMatchObject({ lastError: null, lastOkAt: START + 7 * 60_000 })
  })

  it('writes no row back and sends no notice for an account removed while its calls were running', async () => {
    const env = await account()
    env.box.threads.set('t1', { id: 't1' })
    env.box.messages.set('m1', { id: 'm1', threadId: 't1' })
    env.box.labels = [{ id: 'Label_1', name: 'Receipts' }]
    const releases: Array<() => void> = []
    env.google.intercept = (call) => {
      const path = apiPath(call.url)
      if (path !== '/labels' && path !== '/messages/m1') return undefined
      const answer = path === '/labels' ? Response.json({ labels: env.box.labels }) : Response.json({ id: 'm1', threadId: 't1' })
      return new Promise<Response>((resolve) => { releases.push(() => { resolve(answer) }) })
    }
    const reading = env.gmail.message('work', 'm1')
    const labelling = env.gmail.modify('work', ['t1'], 'label', 'Receipts')
    await vi.waitFor(() => { expect(releases).toHaveLength(2) })
    await env.gmail.removeAccount('work')
    for (const release of releases) release()
    expect(await reading).toMatchObject({ id: 'm1' })
    expect(await gmailFailure(labelling)).toMatchObject({ failure: 'needs-reconnect', message: expect.stringContaining('has no stored sign-in') as string })
    expect(env.gmail.accounts()).toEqual([])
    expect(env.notes).toEqual([])
  })
})
