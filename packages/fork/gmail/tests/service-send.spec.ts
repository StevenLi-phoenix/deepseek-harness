import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AddressProblem, AttachmentProblem, GmailError, type Outgoing, type PendingRecord, type SendOutcome, type SendPolicy, type TurnFacts,
} from '../src/index.ts'
import {
  connect, disposeAll, googleError, HOUR, mount, ownerTurn, rawHeader, rawText, rejection, START, TAINTED, uploadParts, withDomain,
  type FakeMailbox, type MountOptions, type Mounted,
} from './fixture.ts'

const OWNER = 'owner@example.com'
const SEARCH_ADA = 'in:sent (to:"ada@example.com" OR cc:"ada@example.com" OR bcc:"ada@example.com")'

let workdir = ''

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
  workdir = await mkdtemp(join(tmpdir(), 'gmail-send-'))
})

afterEach(async () => {
  await disposeAll()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await rm(workdir, { recursive: true, force: true })
})

function outgoing(extra: Partial<Outgoing> = {}): Outgoing {
  return { to: ['ada@example.com'], cc: [], bcc: [], subject: 'Plan', body: 'Shall we meet on Friday?', attachments: [], ...extra }
}

async function account(policy: SendPolicy, options: MountOptions = {}): Promise<Mounted & { box: FakeMailbox }> {
  const env = await mount(options)
  await connect(env, 'work', OWNER, policy)
  return { ...env, box: env.google.mailbox(OWNER) }
}

function sendNew(env: Mounted, extra: Partial<Outgoing> = {}, turn: TurnFacts = ownerTurn()): Promise<SendOutcome> {
  return env.gmail.send('work', { kind: 'new', message: outgoing(extra) }, turn)
}

async function gmailFailure(promise: Promise<unknown>): Promise<GmailError> {
  const error = await rejection(promise)
  expect(error).toBeInstanceOf(GmailError)
  return error as GmailError
}

async function heldOne(env: Mounted): Promise<PendingRecord> {
  const [record] = await env.gmail.held()
  if (record === undefined) throw new Error('nothing is held')
  return record
}

function searches(env: Mounted): string[] {
  return env.google.callsTo('GET', '/threads').map(call => call.url.searchParams.get('q') ?? '')
}

describe('send policies', () => {
  it('refuses every send, draft, and label change of a read-only account, and records the refusal', async () => {
    const env = await account('read-only')
    const refusal = 'this account is read-only: the owner allows no drafts, sends, or changes from you'
    expect(await gmailFailure(sendNew(env))).toMatchObject({ failure: 'refused', message: refusal })
    expect(await gmailFailure(env.gmail.draft('work', outgoing()))).toMatchObject({ failure: 'refused', message: refusal })
    expect((await env.gmail.status()).activity[0]).toMatchObject({ kind: 'refused', detail: 'read-only account (owner)' })
    expect(env.google.callsTo('POST', /^\/(messages\/send|drafts)/u)).toHaveLength(0)
  })

  it('sends at once on a direct account, even from a tainted turn to a stranger, and counts the send', async () => {
    const env = await account('direct')
    expect(await sendNew(env, { to: ['Ada <ada@example.com>'] }, TAINTED)).toEqual({
      kind: 'sent', messageId: 'sent-1', threadId: 'thread-sent-1', recipients: ['ada@example.com'],
    })
    const [sent] = env.box.sent
    expect(rawHeader(sent?.raw ?? '', 'From')).toBe(OWNER)
    expect(rawHeader(sent?.raw ?? '', 'To')).toBe('"Ada" <ada@example.com>')
    expect(rawText(sent?.raw ?? '')).toBe('Shall we meet on Friday?')
    expect(env.gmail.accounts()[0]?.sentToday).toBe(1)
    expect((await env.gmail.status()).activity[0]).toMatchObject({ kind: 'sent', detail: 'ada@example.com (owner+gmail_read)' })
    expect(env.logs).toContain('info gmail: work send ok in 0 ms: sent to ada@example.com')
  })

  it('holds every message of a confirm-all account, even to its own address', async () => {
    const env = await account('confirm-all')
    expect(await sendNew(env, { to: [OWNER] })).toMatchObject({ kind: 'held', reason: '这个账号每封信都要你确认' })
    expect(env.box.sent).toHaveLength(0)
  })
})

describe('confirm-untrusted', () => {
  it('sends to the owner\'s own accounts and the trusted list from any turn, without a search', async () => {
    const env = await account('confirm-untrusted', { config: { trustedRecipients: ['Boss <boss@example.com>'] } })
    await connect(env, 'personal', 'me@example.com')
    expect(await sendNew(env, { to: ['me@example.com', 'BOSS@example.com'] }, TAINTED)).toMatchObject({
      kind: 'sent', recipients: ['me@example.com', 'boss@example.com'],
    })
    expect(searches(env)).toEqual([])
  })

  it('holds a message to anyone else from a turn that is not clean, without a search', async () => {
    const env = await account('confirm-untrusted')
    env.box.sentTo.add('ada@example.com')
    expect(await sendNew(env, {}, TAINTED)).toMatchObject({ kind: 'held', reason: '这一轮不是你单独发起的，或读过外来内容（owner+gmail_read）' })
    expect(searches(env)).toEqual([])
  })

  it('sends in a clean turn to a recipient the owner named, in any case, without a search', async () => {
    const env = await account('confirm-untrusted')
    expect(await sendNew(env, {}, ownerTurn('mail ADA@example.com the plan'))).toMatchObject({ kind: 'sent' })
    expect(searches(env)).toEqual([])
  })

  it('sends in a clean turn to a recipient this account wrote to before, found by a sent-mail search', async () => {
    const env = await account('confirm-untrusted')
    env.box.sentTo.add('ada@example.com')
    expect(await sendNew(env, {}, ownerTurn('send the plan'))).toMatchObject({ kind: 'sent' })
    expect(searches(env)).toEqual([SEARCH_ADA])
    expect(env.google.callsTo('GET', '/threads')[0]?.url.searchParams.get('maxResults')).toBe('1')
  })

  it('holds a clean turn\'s message to a stranger, naming only the stranger and searching only for unvouched recipients', async () => {
    const env = await account('confirm-untrusted')
    await connect(env, 'personal', 'me@example.com')
    const result = await sendNew(env, { to: ['me@example.com'], cc: ['grace@example.com'], bcc: ['eve@evil.example'] }, ownerTurn('cc grace@example.com'))
    expect(result).toEqual({
      kind: 'held', reason: 'eve@evil.example 不在你这一轮的话里，这个账号也没给对方发过信', draftId: expect.stringMatching(/^d\d+$/u) as string, noticeSent: true,
      recipients: ['me@example.com', 'grace@example.com', 'eve@evil.example'],
    })
    expect(searches(env)).toEqual(['in:sent (to:"eve@evil.example" OR cc:"eve@evil.example" OR bcc:"eve@evil.example")'])
    expect(env.box.sent).toHaveLength(0)
  })
})

describe('holding a message', () => {
  it('writes a Gmail draft, a held record with a six-character code, and a notice listing the whole message', async () => {
    const env = await account('confirm-all')
    await writeFile(join(workdir, 'report.pdf'), '%PDF-1.4\n')
    const body = `${'Agenda item. '.repeat(40)}end`
    const result = await sendNew(env, { cc: ['grace@example.com'], bcc: ['audit@example.com'], body, attachments: ['report.pdf'], cwd: workdir })
    if (result.kind !== 'held') throw new Error('expected a hold')
    const draft = env.box.drafts.get(result.draftId)
    expect(draft).toBeDefined()
    const record = await heldOne(env)
    const preview = Array.from(body.trim()).slice(0, 400).join('')
    expect(record).toEqual({
      code: expect.stringMatching(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/u) as string, account: 'work', from: OWNER, draftId: result.draftId, threadId: null,
      to: ['ada@example.com'], cc: ['grace@example.com'], bcc: ['audit@example.com'], subject: 'Plan', preview, attachments: ['report.pdf (9 B)'],
      createdAt: START, origin: 'owner', reason: '这个账号每封信都要你确认', sessionId: 'session-1', status: 'held', resolvedAt: null, resolvedBy: null,
      messageId: null, noticeSent: true, fingerprint: createHash('sha256').update(draft?.raw ?? '', 'latin1').digest('hex'),
    })
    expect(env.notes).toHaveLength(1)
    expect(env.notes[0]).toMatchObject({ title: '✉️ 待你确认：work 发给 ada@example.com 等', kinds: ['gmail.send.held'], origin: expect.stringContaining('gmail') as string })
    expect(env.notes[0]?.body).toBe([
      `发件：${OWNER}`, '收件：ada@example.com', '抄送：grace@example.com', '密送：audit@example.com', '主题：Plan', '附件：report.pdf (9 B)',
      '为什么要确认：这个账号每封信都要你确认', '', '正文开头：', `${preview}…`, '',
      `要发就回复「发送 ${record.code}」；不发就不用管，72 小时后作废（草稿留在 Gmail）。也可以在 设置 → 邮箱 里确认或丢弃。`,
    ].join('\n'))
    expect((await env.gmail.status()).activity[0]).toMatchObject({
      kind: 'held', detail: 'ada@example.com, grace@example.com, audit@example.com: 这个账号每封信都要你确认',
    })
    expect(env.box.sent).toHaveLength(0)
  })

  it('names the first Cc or Bcc recipient when there is no To, and keeps a short body whole', async () => {
    const env = await account('confirm-all')
    await sendNew(env, { to: [], cc: ['grace@example.com'] }, { clean: true, origin: 'owner', ownerText: [] })
    vi.setSystemTime(START + 1000)
    await sendNew(env, { to: [], bcc: ['audit@example.com'] })
    expect(env.notes.map(note => note.title)).toEqual(['✉️ 待你确认：work 发给 grace@example.com', '✉️ 待你确认：work 发给 audit@example.com'])
    const lines = (env.notes[0]?.body ?? '').split('\n')
    expect(lines).toContain('收件：（无）')
    expect(lines).toContain('Shall we meet on Friday?')
    expect(lines.some(line => line.startsWith('密送') || line.startsWith('附件'))).toBe(false)
    expect((await env.gmail.held())[0]?.sessionId).toBeNull()
    expect((await env.gmail.status()).pending.map(row => [row.createdAt, row.cc, row.bcc])).toEqual([
      [START, ['grace@example.com'], []], [START + 1000, [], ['audit@example.com']],
    ])
  })

  it('describes the draft Gmail holds, even one that lost its recipients', async () => {
    const env = await account('confirm-all')
    env.google.intercept = (call) => {
      if (call.method !== 'GET' || call.url.searchParams.get('format') !== 'raw') return undefined
      return Response.json({ id: 'any', message: { raw: Buffer.from('Subject: Plan\r\n\r\nSGk=\r\n', 'latin1').toString('base64url') } })
    }
    expect(await sendNew(env)).toMatchObject({ kind: 'held', recipients: ['ada@example.com'] })
    expect(env.notes[0]?.title).toBe('✉️ 待你确认：work 发给 ')
    expect(await heldOne(env)).toMatchObject({ to: [], cc: [], bcc: [] })
  })
})

describe('held messages', () => {
  it('cannot be changed or sent by their draft id', async () => {
    const env = await account('confirm-all')
    const held = await sendNew(env)
    if (held.kind !== 'held') throw new Error('expected a hold')
    const refusal = 'this draft waits for the owner\'s confirmation and cannot be changed or sent by you; write a new one instead'
    expect(await gmailFailure(env.gmail.draft('work', outgoing({ to: ['eve@evil.example'] }), held.draftId))).toMatchObject({ failure: 'refused', message: refusal })
    await env.gmail.setPolicy('work', 'direct')
    expect(await gmailFailure(env.gmail.send('work', { kind: 'draft', draftId: held.draftId }, ownerTurn()))).toMatchObject({ failure: 'refused', message: refusal })
    expect(env.google.callsTo('PUT', /^\/drafts\//u)).toHaveLength(0)
    expect(env.google.callsTo('POST', '/drafts/send')).toHaveLength(0)
  })

  it('are sent through drafts.send when the owner confirms in Settings, once', async () => {
    const env = await account('confirm-all')
    const held = await sendNew(env)
    const record = await heldOne(env)
    vi.setSystemTime(START + HOUR)
    expect(await env.gmail.confirm(` ${record.code.toLowerCase()} `, { by: 'settings' })).toEqual({ account: 'work', messageId: 'sent-1', threadId: 'thread-sent-1' })
    expect(env.google.callsTo('POST', '/drafts/send').map(call => call.body)).toEqual([JSON.stringify({ id: held.kind === 'held' ? held.draftId : '' })])
    expect(env.box.sent[0]?.draftId).toBe(held.kind === 'held' ? held.draftId : '')
    const { pending, activity, accounts } = await env.gmail.status()
    expect(pending[0]).toMatchObject({ status: 'sent', resolvedBy: 'settings', resolvedAt: START + HOUR, messageId: 'sent-1' })
    expect(activity.slice(0, 2).map(row => [row.kind, row.detail])).toEqual([
      ['sent', `ada@example.com (confirmed ${record.code} via settings)`], ['confirmed', `${record.code}: Plan`],
    ])
    expect(accounts[0]?.sentToday).toBe(1)
    expect(await env.gmail.held()).toEqual([])
    expect(await gmailFailure(env.gmail.confirm(record.code, { by: 'settings' }))).toMatchObject({
      failure: 'expired', message: `the message with the code ${record.code} was already sent`,
    })
    expect(await gmailFailure(env.gmail.confirm('ZZZZZZ', { by: 'settings' }))).toMatchObject({ failure: 'not-found', message: 'no held message has the code ZZZZZZ' })
  })

  it('are sent from an owner turn only when the turn is clean and the owner\'s own words hold the code', async () => {
    const env = await account('confirm-all')
    await sendNew(env)
    const { code } = await heldOne(env)
    const refusal = `only the owner confirms a held message: in a turn the owner started alone whose own message holds ${code}, before any mail or web page is read in it, or in Settings → 邮箱`
    for (const turn of [ownerTurn('send it'), ownerTurn(`send X${code}`), { ...TAINTED, ownerText: [`发送 ${code}`] }]) {
      expect(await gmailFailure(env.gmail.confirm(code, { by: 'owner-turn', turn }))).toMatchObject({ failure: 'refused', message: refusal })
    }
    expect(env.google.callsTo('POST', '/drafts/send')).toHaveLength(0)
    expect(await env.gmail.confirm(code, { by: 'owner-turn', turn: ownerTurn(`发送 ${code.toLowerCase()}`) })).toMatchObject({ messageId: 'sent-1' })
    expect((await env.gmail.status()).pending[0]).toMatchObject({ status: 'sent', resolvedBy: 'owner-turn' })
  })

  it('are refused and discarded when the draft changed after the notice', async () => {
    const env = await account('confirm-all')
    const held = await sendNew(env)
    const draft = env.box.drafts.get(held.kind === 'held' ? held.draftId : '')
    if (draft === undefined) throw new Error('no draft')
    draft.raw = draft.raw.replace('To: ada@example.com', 'To: eve@evil.example')
    const { code } = await heldOne(env)
    expect(await gmailFailure(env.gmail.confirm(code, { by: 'settings' }))).toMatchObject({
      failure: 'refused', message: 'the held draft was changed after the owner was asked; nothing was sent, and the hold is discarded',
    })
    expect(env.google.callsTo('POST', '/drafts/send')).toHaveLength(0)
    const { pending, activity } = await env.gmail.status()
    expect(pending[0]).toMatchObject({ status: 'discarded', resolvedBy: 'settings' })
    expect(activity.slice(0, 2).map(row => row.kind)).toEqual(['refused', 'discarded'])
    expect(activity[0]?.detail).toBe(`held draft ${code} changed after the notice`)
  })

  it('are discarded when their draft is gone from Gmail, and stay held on any other read failure', async () => {
    const env = await account('confirm-all')
    const first = await sendNew(env)
    await sendNew(env, { subject: 'Second' })
    const [one, two] = await env.gmail.held()
    env.box.drafts.delete(first.kind === 'held' ? first.draftId : '')
    expect(await gmailFailure(env.gmail.confirm(one?.code ?? '', { by: 'settings' }))).toMatchObject({
      failure: 'not-found', message: 'the held draft is no longer in Gmail; nothing was sent',
    })
    env.google.intercept = call => (call.url.pathname.includes('/drafts/') ? googleError(403, 'Insufficient Permission', 'insufficientPermissions') : undefined)
    expect(await gmailFailure(env.gmail.confirm(two?.code ?? '', { by: 'settings' }))).toMatchObject({ failure: 'api', message: expect.stringContaining('HTTP 403') as string })
    expect((await env.gmail.held()).map(row => row.code)).toEqual([two?.code])
    expect(env.gmail.accounts()[0]?.lastError).toContain('HTTP 403 insufficientPermissions')
    env.google.intercept = undefined
    await env.gmail.setPolicy('work', 'read-only')
    expect(await gmailFailure(env.gmail.confirm(two?.code ?? '', { by: 'settings' }))).toMatchObject({
      failure: 'refused', message: 'the account became read-only; the held message was not sent',
    })
    expect((await env.gmail.held()).map(row => row.code)).toEqual([two?.code])
  })

  it('expire after confirmTtlHours and cannot be confirmed then', async () => {
    const env = await account('confirm-all', { config: { confirmTtlHours: 2 } })
    await sendNew(env)
    const { code } = await heldOne(env)
    vi.setSystemTime(START + 2 * HOUR)
    expect(await env.gmail.held()).toHaveLength(1)
    vi.setSystemTime(START + 2 * HOUR + 1)
    expect(await env.gmail.held()).toEqual([])
    expect((await env.gmail.status()).pending[0]).toMatchObject({ status: 'expired', resolvedBy: 'expiry', resolvedAt: START + 2 * HOUR + 1 })
    expect(await gmailFailure(env.gmail.confirm(code, { by: 'settings' }))).toMatchObject({ failure: 'expired', message: `the message with the code ${code} was already expired` })
    expect(env.notes[0]?.body).toContain('2 小时后作废')
  })

  it('are discarded with their draft deleted, also when Gmail cannot delete it', async () => {
    const env = await account('confirm-all')
    const first = await sendNew(env)
    await sendNew(env, { subject: 'Second' })
    const [one, two] = await env.gmail.held()
    await env.gmail.discard(one?.code.toLowerCase() ?? '')
    expect(env.google.callsTo('DELETE', /^\/drafts\//u).map(call => call.url.pathname.split('/').at(-1))).toEqual([first.kind === 'held' ? first.draftId : ''])
    expect(env.logs).toContain(`info gmail: work: held ${one?.code} discarded`)
    expect(await gmailFailure(env.gmail.discard(one?.code ?? ''))).toMatchObject({ failure: 'not-found', message: `no held message has the code ${one?.code}` })
    expect(await gmailFailure(env.gmail.discard('nope'))).toMatchObject({ failure: 'not-found', message: 'no held message has the code NOPE' })
    env.box.drafts.clear()
    await env.gmail.discard(two?.code ?? '')
    expect(env.logs.some(line => line.startsWith(`info gmail: work: the draft of ${two?.code} could not be deleted (Gmail DELETE`))).toBe(true)
    expect((await env.gmail.status()).pending.map(row => row.status)).toEqual(['discarded', 'discarded'])
  })
})

describe('daily send cap', () => {
  it('refuses the send after maxSendsPerDay in 24 hours and allows it again a day after', async () => {
    const env = await account('direct', { config: { maxSendsPerDay: 2 } })
    await sendNew(env)
    vi.setSystemTime(START + HOUR)
    await sendNew(env)
    vi.setSystemTime(START + 24 * HOUR - 1)
    expect(await gmailFailure(sendNew(env))).toMatchObject({
      failure: 'limit', message: 'this account already sent 2 messages in 24 hours, the owner\'s limit; nothing was sent',
    })
    expect(env.box.sent).toHaveLength(2)
    expect((await env.gmail.status()).activity[0]).toMatchObject({ kind: 'refused', detail: 'daily cap of 2 reached (owner)' })
    vi.setSystemTime(START + 24 * HOUR)
    expect(await sendNew(env)).toMatchObject({ kind: 'sent' })
    expect(env.gmail.accounts()[0]?.sentToday).toBe(2)
  })

  it('applies to confirmed messages too, which stay held', async () => {
    const env = await account('confirm-all', { config: { maxSendsPerDay: 1 } })
    await sendNew(env)
    await sendNew(env, { subject: 'Second' })
    const [one, two] = await env.gmail.held()
    await env.gmail.confirm(one?.code ?? '', { by: 'settings' })
    expect(await gmailFailure(env.gmail.confirm(two?.code ?? '', { by: 'settings' }))).toMatchObject({ failure: 'limit' })
    expect((await env.gmail.held()).map(row => row.code)).toEqual([two?.code])
    expect((await env.gmail.status()).activity[0]).toMatchObject({ kind: 'refused', detail: 'daily cap of 1 reached (settings)' })
  })
})

describe('replies', () => {
  function original(box: FakeMailbox, id: string, headers: Record<string, string>): void {
    box.messages.set(id, { id, threadId: `thread-${id}`, payload: { headers: Object.entries(headers).map(([name, value]) => ({ name, value })) } })
  }

  const reply = (extra: Partial<Outgoing> = {}): Outgoing => outgoing({ to: [], subject: undefined, body: 'Yes.', ...extra })

  it('answers the sender in the thread, with In-Reply-To, References, and a Re: subject', async () => {
    const env = await account('direct')
    original(env.box, 'o1', {
      From: 'Ada <ada@example.com>', To: OWNER, Subject: 'Plan\tfor\u0007Friday', 'Message-ID': '<o1@mail.example>', References: '<root@mail.example> stray',
    })
    expect(await env.gmail.draft('work', reply({ replyTo: 'o1' }))).toEqual({
      draftId: expect.stringMatching(/^d\d+$/u) as string, threadId: 'thread-o1', recipients: ['ada@example.com'], subject: 'Re: Plan for Friday',
    })
    const [call] = env.google.callsTo('POST', '/drafts')
    const { metadata, raw } = uploadParts(call ?? { method: '', url: new URL('https://x'), body: '', token: '' })
    expect(metadata).toEqual({ message: { threadId: 'thread-o1' } })
    expect(rawHeader(raw, 'To')).toBe('ada@example.com')
    expect(rawHeader(raw, 'In-Reply-To')).toBe('<o1@mail.example>')
    expect(rawHeader(raw, 'References')).toBe('<root@mail.example> <o1@mail.example>')
    expect(env.google.callsTo('GET', '/messages/o1')[0]?.url.searchParams.get('format')).toBe('metadata')
  })

  it('answers the Reply-To address, keeps a subject that already starts with Re:, and leaves out headers it cannot check', async () => {
    const env = await account('direct')
    original(env.box, 'o2', { From: 'Ada <ada@example.com>', 'Reply-To': 'List <list@example.com>', Subject: 'RE: Plan', 'Message-ID': 'not an id' })
    const sent = await env.gmail.send('work', { kind: 'new', message: reply({ replyTo: 'o2' }) }, ownerTurn())
    expect(sent).toMatchObject({ kind: 'sent', threadId: 'thread-o2', recipients: ['list@example.com'] })
    const raw = env.box.sent[0]?.raw ?? ''
    expect(rawHeader(raw, 'Subject')).toBe('RE: Plan')
    expect(rawHeader(raw, 'In-Reply-To')).toBe('')
    expect(rawHeader(raw, 'References')).toBe('')
    expect(env.box.sent[0]?.threadId).toBe('thread-o2')
  })

  it('answers everyone on replyAll: the sender, then the other To and Cc recipients without the account and without repeats', async () => {
    const env = await account('direct')
    original(env.box, 'o3', {
      From: 'Ada <ada@example.com>', To: `${OWNER}, Grace <grace@example.com>`, Cc: 'alan@example.org, OWNER@example.com, grace@example.com, ada@example.com', Subject: 'Plan',
    })
    expect((await env.gmail.draft('work', reply({ replyTo: 'o3', replyAll: true }))).recipients).toEqual(['ada@example.com', 'grace@example.com', 'alan@example.org'])
    const raw = [...env.box.drafts.values()][0]?.raw ?? ''
    expect(rawHeader(raw, 'To')).toBe('ada@example.com')
    expect(rawHeader(raw, 'Cc')).toBe('grace@example.com, alan@example.org')
  })

  it('answers a message of the account\'s own to its original recipients, and skips addresses it cannot write', async () => {
    const env = await account('direct')
    original(env.box, 'o4', { From: `Owner <${OWNER}>`, To: 'odd..dots@example.com, Ada <ada@example.com>', Subject: 'Plan' })
    expect((await env.gmail.draft('work', reply({ replyTo: 'o4' }))).recipients).toEqual(['ada@example.com'])
  })

  it('keeps recipients and a subject the model gave, and still threads the reply', async () => {
    const env = await account('direct')
    original(env.box, 'o5', { From: 'Ada <ada@example.com>', Subject: 'Plan' })
    expect(await env.gmail.draft('work', reply({ replyTo: 'o5', cc: ['grace@example.com'], subject: 'Moving to Monday' }))).toMatchObject({
      threadId: 'thread-o5', recipients: ['grace@example.com'], subject: 'Moving to Monday',
    })
    expect(await env.gmail.draft('work', reply({ replyTo: 'o5', bcc: ['audit@example.com'] }))).toMatchObject({ recipients: ['audit@example.com'], subject: 'Re: Plan' })
  })

  it('reports a reply to a message that does not exist as not-found', async () => {
    const env = await account('direct')
    expect(await gmailFailure(env.gmail.draft('work', reply({ replyTo: 'missing' })))).toMatchObject({ failure: 'not-found', message: expect.stringContaining('HTTP 404') as string })
  })
})

describe('composition', () => {
  it('refuses a new message without a subject or without a recipient, and a recipient carrying a header', async () => {
    const env = await account('direct')
    for (const subject of [undefined, '   ']) {
      const error = await rejection(sendNew(env, { subject }))
      expect(error).toBeInstanceOf(AddressProblem)
      expect(error.message).toBe('a new message needs a subject')
    }
    expect((await rejection(sendNew(env, { to: [] }))).message).toBe('the message has no recipient')
    expect(await rejection(sendNew(env, { to: ['ada@example.com\r\nBcc: spy@evil.example'] }))).toBeInstanceOf(AddressProblem)
    expect(env.google.callsTo('POST', /^\/(messages\/send|drafts)/u)).toHaveLength(0)
    expect(env.gmail.accounts()[0]?.lastError).toBeNull()
    expect(env.logs.some(line => line.startsWith('warn gmail: work send failed in 0 ms: a new message needs a subject'))).toBe(true)
  })

  it('attaches files from the Session\'s working directory, and refuses attachments without one or outside it', async () => {
    const env = await account('direct')
    await writeFile(join(workdir, 'notes.txt'), 'notes')
    await sendNew(env, { attachments: ['notes.txt'], cwd: workdir })
    const raw = env.box.sent[0]?.raw ?? ''
    expect(rawHeader(raw, 'Content-Type')).toMatch(/^multipart\/mixed; boundary="fork-[0-9a-f]{24}"$/u)
    expect(raw).toContain('Content-Disposition: attachment; filename="notes.txt"')
    const missing = await rejection(sendNew(env, { attachments: ['notes.txt'] }))
    expect(missing).toBeInstanceOf(AttachmentProblem)
    expect(missing.message).toBe('this Session has no working directory to attach files from')
    await writeFile(join(workdir, 'id_ed25519'), 'key')
    expect(await rejection(sendNew(env, { attachments: ['id_ed25519'], cwd: workdir }))).toBeInstanceOf(AttachmentProblem)
    expect(env.box.sent).toHaveLength(1)
  })
})

describe('drafts', () => {
  it('writes a new draft and replaces one that is not held', async () => {
    const env = await account('confirm-untrusted')
    const created = await env.gmail.draft('work', outgoing())
    expect(created).toEqual({ draftId: expect.stringMatching(/^d\d+$/u) as string, threadId: null, recipients: ['ada@example.com'], subject: 'Plan' })
    expect(env.logs).toContain(`info gmail: work draft ok in 0 ms: ${created.draftId} to 1 recipient(s)`)
    const updated = await env.gmail.draft('work', outgoing({ to: ['grace@example.com'], subject: 'Plan v2' }), created.draftId)
    expect(updated).toMatchObject({ draftId: created.draftId, recipients: ['grace@example.com'], subject: 'Plan v2' })
    expect(env.google.callsTo('PUT', `/drafts/${created.draftId}`)).toHaveLength(1)
    expect(rawHeader(env.box.drafts.get(created.draftId)?.raw ?? '', 'To')).toBe('grace@example.com')
    expect(env.box.sent).toHaveLength(0)
    expect((await env.gmail.status()).activity.slice(0, 2).map(row => row.detail)).toEqual(['grace@example.com: Plan v2', 'ada@example.com: Plan'])
  })

  it('writes a draft without recipients', async () => {
    const env = await account('confirm-all')
    expect((await env.gmail.draft('work', outgoing({ to: [], subject: 'Notes' }))).recipients).toEqual([])
    expect((await env.gmail.status()).activity[0]).toMatchObject({ kind: 'drafted', detail: '(no recipients): Notes' })
  })
})

describe('sending an existing draft', () => {
  it('sends a draft by id through drafts.send, reading its recipients (Bcc included) from its raw text', async () => {
    const env = await account('direct')
    const { draftId } = await env.gmail.draft('work', outgoing({ bcc: ['audit@example.com'] }))
    expect(await env.gmail.send('work', { kind: 'draft', draftId }, ownerTurn())).toMatchObject({
      kind: 'sent', recipients: ['ada@example.com', 'audit@example.com'],
    })
    expect(env.box.sent[0]?.draftId).toBe(draftId)
    expect(env.logs).toContain('info gmail: work send draft ok in 0 ms: sent to ada@example.com, audit@example.com')
  })

  it('holds the existing draft itself, without writing a new one', async () => {
    const env = await account('confirm-all')
    const { draftId } = await env.gmail.draft('work', outgoing())
    const drafts = env.google.callsTo('POST', '/drafts').length
    expect(await env.gmail.send('work', { kind: 'draft', draftId }, ownerTurn())).toMatchObject({ kind: 'held', draftId })
    expect(env.google.callsTo('POST', '/drafts')).toHaveLength(drafts)
    expect((await heldOne(env)).draftId).toBe(draftId)
  })

  it('holds a hand-written draft Gmail returns without its message, falling back to the account address', async () => {
    const env = await account('confirm-all')
    env.box.drafts.set('ext-1', { raw: 'To: Ada <ada@example.com>\r\nCc: grace@example.com', sparse: true })
    expect(await env.gmail.send('work', { kind: 'draft', draftId: 'ext-1' }, ownerTurn())).toMatchObject({ kind: 'held', recipients: ['ada@example.com', 'grace@example.com'] })
    expect(await heldOne(env)).toMatchObject({ draftId: 'ext-1', from: OWNER, subject: '', preview: '', threadId: null, to: ['ada@example.com'], cc: ['grace@example.com'] })
  })

  it('refuses a draft without recipients', async () => {
    const env = await account('direct')
    const { draftId } = await env.gmail.draft('work', outgoing({ to: [], subject: 'Notes' }))
    expect((await rejection(env.gmail.send('work', { kind: 'draft', draftId }, ownerTurn()))).message).toBe('the message has no recipient')
  })
})

describe('notices', () => {
  it('holds the message with noticeSent false and a warning when no notifier is mounted', async () => {
    const env = await account('confirm-all', { noNotifier: true })
    expect(await sendNew(env)).toMatchObject({ kind: 'held', noticeSent: false })
    expect((await heldOne(env)).noticeSent).toBe(false)
    expect(env.logs).toContain('warn gmail: could not send "✉️ 待你确认：work 发给 ada@example.com": no forkNotifier service is mounted')
  })

  it('holds the message with noticeSent false and a warning when the notifier throws', async () => {
    for (const thrown of [new Error('channel down'), 'offline']) {
      const env = await account('confirm-all', { notifierThrows: thrown })
      expect(await sendNew(env)).toMatchObject({ kind: 'held', noticeSent: false })
      expect((await heldOne(env)).noticeSent).toBe(false)
      expect(env.logs).toContain(`warn gmail: could not send "✉️ 待你确认：work 发给 ada@example.com": ${thrown instanceof Error ? thrown.message : thrown}`)
    }
  })
})

describe('pruning', () => {
  /** Store resolved holds without a resolution time, as rows written before resolvedAt was always set would be. */
  async function seedUntimed(env: Mounted, status: 'discarded' | 'expired', ...codes: string[]): Promise<void> {
    await env.fiber.dispose()
    await withDomain(env.pool, async (domain) => {
      for (const code of codes) {
        await domain.table('pending').put(code, {
          code, account: 'work', from: OWNER, draftId: `gone-${code}`, threadId: null, to: [], cc: [], bcc: [], subject: `Old ${code}`, preview: '',
          attachments: [], createdAt: START - HOUR, origin: 'owner', reason: 'r', sessionId: null, status, resolvedAt: null,
          resolvedBy: null, messageId: null, noticeSent: false, fingerprint: 'f',
        })
      }
    })
  }

  it('keeps the latest 50 resolved holds, dropping untimed ones first, and the latest 200 activity lines', async () => {
    const env = await account('confirm-all')
    await seedUntimed(env, 'discarded', 'OLDONE', 'OLDTWO')
    const again = await mount({ pool: env.pool, credentials: env.credentials, google: env.google })
    for (let index = 0; index < 105; index++) {
      vi.setSystemTime(START + index * 1000)
      await sendNew(again)
      await again.gmail.discard((await heldOne(again)).code)
    }
    vi.setSystemTime(START + 105_000)
    await sendNew(again)
    const { pending } = await again.gmail.status()
    expect(pending).toHaveLength(51)
    expect(pending[0]?.status).toBe('held')
    expect(pending.slice(1).map(row => row.resolvedAt)).toEqual(Array.from({ length: 50 }, (_, index) => START + (104 - index) * 1000))
    await again.fiber.dispose()
    const kept = await withDomain(env.pool, domain => ({
      pending: Array.from(domain.table('pending').keys()),
      seqs: Array.from(domain.table('activity').entries(), ([, row]) => row.seq).sort((a, b) => a - b),
    }))
    expect(kept.pending).toHaveLength(51)
    expect(kept.pending).not.toContain('OLDONE')
    expect(kept.pending).not.toContain('OLDTWO')
    expect(kept.seqs).toHaveLength(200)
    expect(kept.seqs.at(-1)).toBe(212)
    expect(kept.seqs[0]).toBe(13)
  })

  it('lists resolved holds without a time after the timed ones', async () => {
    const env = await account('confirm-all')
    await sendNew(env)
    await env.gmail.discard((await heldOne(env)).code)
    await seedUntimed(env, 'expired', 'OLDONE', 'OLDTWO')
    const again = await mount({ pool: env.pool, credentials: env.credentials, google: env.google })
    const subjects = (await again.gmail.status()).pending.map(row => row.subject)
    expect(subjects[0]).toBe('Plan')
    expect(subjects.slice(1).sort()).toEqual(['Old OLDONE', 'Old OLDTWO'])
  })
})

describe('activity', () => {
  it('fails the operation whose activity line cannot be stored, and stores the lines after it', async () => {
    const env = await account('read-only')
    env.pool.failNextWrites = 1
    expect((await rejection(sendNew(env))).message).toBe('injected write failure')
    expect(await gmailFailure(sendNew(env))).toMatchObject({ failure: 'refused' })
    expect((await env.gmail.status()).activity.map(row => row.kind)).toEqual(['refused', 'connected'])
  })
})
