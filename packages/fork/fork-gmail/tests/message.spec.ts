import { describe, expect, it } from 'vitest'
import {
  attachmentPart, attachmentsOf, bodyText, decodeBody, gmailMessageSchema, header, messageView, trimQuoted,
  type GmailMessage, type GmailPart,
} from '../src/message.ts'

const OPTIONS = { maxChars: 20_000, maxHtmlChars: 100_000, keepQuotes: false }

function data(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

function textPart(text: string, mimeType = 'text/plain', extra: Partial<GmailPart> = {}): GmailPart {
  return { mimeType, body: { data: data(text), size: text.length }, ...extra }
}

describe('headers', () => {
  it('reads the first value of a header by case-insensitive name, and an empty string when absent', () => {
    const part: GmailPart = { headers: [{ name: 'subject', value: 'First' }, { name: 'Subject', value: 'Second' }] }
    expect(header(part, 'SUBJECT')).toBe('First')
    expect(header(part, 'From')).toBe('')
    expect(header({}, 'From')).toBe('')
    expect(header(undefined, 'From')).toBe('')
  })
})

describe('body decoding', () => {
  it('decodes base64url bytes in the declared charset, and as UTF-8 when the runtime does not know the charset', () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xE9]).toString('base64url')
    expect(decodeBody(latin1, 'iso-8859-1')).toBe('café')
    expect(decodeBody(data('naïve 文字'), 'utf-8')).toBe('naïve 文字')
    expect(decodeBody(data('naïve 文字'), 'x-unknown-charset')).toBe('naïve 文字')
  })

  it('takes the text/plain parts of any depth, in their charsets, and leaves out attachments and HTML', () => {
    const latin1 = Buffer.from('Grüße', 'latin1').toString('base64url')
    const payload: GmailPart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            textPart('Hello  there', 'TEXT/PLAIN'),
            textPart('<p>Hello there</p>', 'text/html'),
          ],
        },
        { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset="ISO-8859-1"' }], body: { data: latin1 } },
        textPart('attached notes', 'text/plain', { filename: 'notes.txt', partId: '2' }),
        { mimeType: 'text/plain', body: { size: 0 } },
      ],
    }
    expect(bodyText(payload, 100_000)).toBe('Hello there\n\nGrüße')
  })

  it('converts the HTML parts when there is no plain text, and reads nothing from a body without text', () => {
    expect(bodyText({ mimeType: 'text/html', body: { data: data('<p>Only <b>HTML</b></p><script>x</script>') } }, 100_000)).toBe('Only HTML')
    expect(bodyText({ mimeType: 'multipart/mixed', parts: [{ body: { data: data('untyped') } }, textPart('png bytes', 'image/png')] }, 100_000)).toBe('')
    expect(bodyText(undefined, 100_000)).toBe('')
  })
})

describe('quoted history', () => {
  const cut = (text: string): { text: string; trimmed: boolean } => trimQuoted(text)

  it('cuts at an English attribution line, also when it wraps onto a second line', () => {
    expect(cut('Thanks, see you then.\n\nOn Mon, Nov 9, 2026 at 10:00 AM Ada <ada@example.com> wrote:\n> Are we on?'))
      .toEqual({ text: 'Thanks, see you then.', trimmed: true })
    expect(cut('Sounds good.\n\nOn Mon, Nov 9, 2026 at 10:00 AM Ada Lovelace <ada@example.com>\nwrote:\n> hi'))
      .toEqual({ text: 'Sounds good.', trimmed: true })
  })

  it('cuts at a Chinese attribution line in either word order', () => {
    expect(cut('好的。\n\n在 2026年11月9日 周一 10:00，Ada <ada@example.com> 写道：\n> 开会吗')).toEqual({ text: '好的。', trimmed: true })
    expect(cut('收到\n\nAda <ada@example.com> 于2026年11月9日周一 10:00写道:\n> 明天见')).toEqual({ text: '收到', trimmed: true })
  })

  it('cuts at an original-message or forwarded-message rule and at an Outlook underscore line', () => {
    expect(cut('See below.\n-----Original Message-----\nFrom: Ada')).toEqual({ text: 'See below.', trimmed: true })
    expect(cut('FYI\n---------- Forwarded message ---------\nFrom: Ada')).toEqual({ text: 'FYI', trimmed: true })
    expect(cut('Noted\n________________________________\nFrom: Ada')).toEqual({ text: 'Noted', trimmed: true })
  })

  it('cuts at an Outlook header block: a From line with a date line soon after, in English or Chinese', () => {
    expect(cut('Will do.\n\nFrom: Ada Lovelace <ada@example.com>\nSent: Monday, November 9, 2026 10:00 AM\nTo: Owner'))
      .toEqual({ text: 'Will do.', trimmed: true })
    expect(cut('可以\n发件人：Ada\n收件人：Owner\n时间：2026年11月9日')).toEqual({ text: '可以', trimmed: true })
  })

  it('keeps a From line that opens no header block', () => {
    const text = 'Notes\nFrom: the team\nWe agreed on Friday.\nMore notes\nAnd more'
    expect(cut(text)).toEqual({ text, trimmed: false })
  })

  it('cuts trailing > lines and the blank lines among them', () => {
    expect(cut('Agreed.\n\n> Can we move it?\n> Thanks\n\n')).toEqual({ text: 'Agreed.', trimmed: true })
  })

  it('keeps a message that is only a quote, or whose attribution line comes first', () => {
    expect(cut('> a\n> b')).toEqual({ text: '> a\n> b', trimmed: false })
    const leading = '\nOn Mon, Nov 9, 2026 at 10:00 AM Ada wrote:\nthe forwarded words'
    expect(cut(leading)).toEqual({ text: leading, trimmed: false })
    expect(cut('hello\n\n')).toEqual({ text: 'hello\n\n', trimmed: false })
  })
})

describe('attachments', () => {
  const payload: GmailPart = {
    mimeType: 'multipart/mixed',
    parts: [
      textPart('body', 'text/plain', { partId: '0' }),
      { partId: '1', filename: 'report.pdf', mimeType: 'application/pdf', body: { attachmentId: 'ANGjdJ_1', size: 2048 } },
      {
        partId: '2',
        mimeType: 'multipart/related',
        parts: [{ partId: '2.1', filename: 'logo.png', body: { data: data('png') } }],
      },
      { partId: '3', filename: 'empty.txt', mimeType: 'text/plain', body: { size: 0 } },
      { filename: 'no-part-id.txt', body: { attachmentId: 'x' } },
      { partId: '4', filename: '', body: { attachmentId: 'y' } },
    ],
  }

  it('lists parts with a part id, a file name, and an attachment id or inline data, with defaults for type and size', () => {
    expect(attachmentsOf(payload)).toEqual([
      { part: '1', filename: 'report.pdf', mimeType: 'application/pdf', size: 2048 },
      { part: '2.1', filename: 'logo.png', mimeType: 'application/octet-stream', size: 0 },
    ])
    expect(attachmentsOf(undefined)).toEqual([])
  })

  it('finds an attachment by its part id at any depth, and nothing for a part that is not an attachment', () => {
    expect(attachmentPart(payload, '2.1')?.body?.data).toBe(data('png'))
    expect(attachmentPart(payload, '1')?.body?.attachmentId).toBe('ANGjdJ_1')
    expect(attachmentPart(payload, '3')).toBeUndefined()
    expect(attachmentPart(payload, '0')).toBeUndefined()
    expect(attachmentPart(payload, '9')).toBeUndefined()
  })
})

describe('message view', () => {
  const message: GmailMessage = {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Are we &quot;on&quot;?',
    internalDate: '1793000000000',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Ada <ada@example.com>' },
        { name: 'To', value: 'owner@example.com' },
        { name: 'Cc', value: 'grace@example.com' },
        { name: 'Reply-To', value: 'list@example.com' },
        { name: 'Subject', value: 'Plan' },
        { name: 'Message-ID', value: '<m1@mail.example>' },
        { name: 'References', value: '<m0@mail.example>' },
      ],
      parts: [
        textPart('Yes.\n\nOn Mon, Nov 9, 2026 at 10:00 AM Owner <owner@example.com> wrote:\n> Are we on?', 'text/plain', { partId: '0' }),
        { partId: '1', filename: 'a.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att', size: 10 } },
      ],
    },
  }

  it('reduces a message to its headers, its body without quoted history, and its attachments', () => {
    expect(messageView(message, OPTIONS)).toEqual({
      id: 'm1', threadId: 't1', labels: ['INBOX', 'UNREAD'], date: 1793000000000,
      from: 'Ada <ada@example.com>', to: 'owner@example.com', cc: 'grace@example.com', replyTo: 'list@example.com',
      subject: 'Plan', messageId: '<m1@mail.example>', references: '<m0@mail.example>',
      text: 'Yes.', textChars: 4, quoteTrimmed: true,
      attachments: [{ part: '1', filename: 'a.pdf', mimeType: 'application/pdf', size: 10 }],
      snippet: 'Are we "on"?',
    })
  })

  it('keeps the quoted history on request', () => {
    const view = messageView(message, { ...OPTIONS, keepQuotes: true })
    expect(view.quoteTrimmed).toBe(false)
    expect(view.text).toContain('> Are we on?')
  })

  it('cuts the text at maxChars characters (not UTF-16 units) and counts the whole text', () => {
    const long: GmailMessage = { id: 'm2', threadId: 't2', payload: textPart('😀'.repeat(12)) }
    const view = messageView(long, { ...OPTIONS, maxChars: 10 })
    expect(view.text).toBe(`${'😀'.repeat(10)}…`)
    expect(view.textChars).toBe(12)
  })

  it('has no date without a numeric internalDate, and empty labels, headers, and snippet when Gmail sends none', () => {
    expect(messageView({ id: 'm3', threadId: 't3' }, OPTIONS)).toMatchObject({
      date: null, labels: [], from: '', subject: '', text: '', snippet: '', attachments: [],
    })
    expect(messageView({ id: 'm4', threadId: 't4', internalDate: 'soon' }, OPTIONS).date).toBeNull()
  })

  it('reads nested parts from the Gmail API answer', () => {
    const parsed = gmailMessageSchema.parse({ id: 'm5', threadId: 't5', payload: { parts: [{ parts: [{ partId: '1.1', filename: 'x.txt', body: { data: 'eA' } }] }] } })
    expect(attachmentsOf(parsed.payload).map(entry => entry.part)).toEqual(['1.1'])
  })
})
