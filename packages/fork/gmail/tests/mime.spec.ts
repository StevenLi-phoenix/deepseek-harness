import { describe, expect, it } from 'vitest'
import { AddressProblem } from '../src/address.ts'
import { compose, encodeWords, headerText, messageIds, type Composition } from '../src/mime.ts'

const NOW = Date.parse('2026-11-12T15:30:00Z')

function message(extra: Partial<Composition> = {}): Composition {
  return {
    from: { address: 'owner@example.com', name: 'Owner' },
    to: [{ address: 'ada@example.com', name: '' }],
    cc: [],
    bcc: [],
    subject: 'Lunch',
    text: 'See you at noon.',
    attachments: [],
    ...extra,
  }
}

/** The headers of a composed message, by name. */
function headersOf(raw: string): Map<string, string> {
  const head = raw.slice(0, raw.indexOf('\r\n\r\n')).replace(/\r\n /gu, ' ')
  return new Map(head.split('\r\n').map((line) => {
    const colon = line.indexOf(':')
    return [line.slice(0, colon), line.slice(colon + 1).trim()]
  }))
}

/** Decode every RFC 2047 `B` word in a header value. */
function decodeWords(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/gu, (_whole, data: string) => Buffer.from(data, 'base64').toString('utf8'))
}

describe('encoded words', () => {
  it('splits long text into words of at most 45 bytes without cutting a character', () => {
    const text = '会议纪要：'.repeat(10)
    const encoded = encodeWords(text)
    const words = encoded.split('\r\n ')
    expect(words.length).toBeGreaterThan(1)
    for (const word of words) {
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/u)
      expect(Buffer.from(word.slice(10, -2), 'base64').length).toBeLessThanOrEqual(45)
    }
    expect(decodeWords(encoded)).toBe(text)
    expect(encodeWords('')).toBe('')
  })

  it('keeps short printable ASCII as is and encodes non-ASCII or text over 900 characters', () => {
    expect(headerText('Weekly sync')).toBe('Weekly sync')
    expect(decodeWords(headerText('Café notes'))).toBe('Café notes')
    expect(headerText('Café notes')).toMatch(/^=\?UTF-8\?B\?/u)
    const long = 'a'.repeat(901)
    expect(headerText(long)).not.toBe(long)
    expect(decodeWords(headerText(long))).toBe(long)
  })
})

describe('message ids from a received message', () => {
  it('keeps only <id@host> tokens, joined by one space', () => {
    expect(messageIds(undefined)).toBe('')
    expect(messageIds('')).toBe('')
    expect(messageIds('<a1@mail.example>  junk\t<b2@mail.example> <bad id> <c3@x>')).toBe('<a1@mail.example> <b2@mail.example> <c3@x>')
    expect(messageIds('no-angle@mail.example')).toBe('')
  })
})

describe('composing a message', () => {
  it('writes a plain-text message: headers, a UTF-8 base64 body in 76-character lines, and CRLF line ends', () => {
    const text = 'Line one.\nZweite Zeile mit Umlauten: äöü. '.repeat(4)
    const raw = compose(message({ text }), () => 'unused', NOW)
    const headers = headersOf(raw)
    expect(headers.get('From')).toBe('"Owner" <owner@example.com>')
    expect(headers.get('To')).toBe('ada@example.com')
    expect(headers.has('Cc')).toBe(false)
    expect(headers.has('Bcc')).toBe(false)
    expect(headers.get('Subject')).toBe('Lunch')
    expect(headers.get('Date')).toBe('Thu, 12 Nov 2026 15:30:00 GMT')
    expect(headers.get('MIME-Version')).toBe('1.0')
    expect(headers.get('Content-Type')).toBe('text/plain; charset=UTF-8')
    expect(headers.get('Content-Transfer-Encoding')).toBe('base64')
    expect(headers.has('In-Reply-To')).toBe(false)
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4)
    const lines = body.split('\r\n').filter(line => line !== '')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76)
    expect(Buffer.from(lines.join(''), 'base64').toString('utf8')).toBe(text)
    expect(raw.endsWith('\r\n')).toBe(true)
    expect(raw.replace(/\r\n/gu, '')).not.toMatch(/[\r\n]/u)
  })

  it('writes Cc, Bcc, and every recipient, and leaves out the To header when there is none', () => {
    const raw = compose(message({
      to: [],
      cc: [{ address: 'grace@example.com', name: 'Grace' }, { address: 'alan@example.org', name: '' }],
      bcc: [{ address: 'audit@example.com', name: '' }],
    }), undefined, NOW)
    const headers = headersOf(raw)
    expect(headers.has('To')).toBe(false)
    expect(headers.get('Cc')).toBe('"Grace" <grace@example.com>, alan@example.org')
    expect(headers.get('Bcc')).toBe('audit@example.com')
  })

  it('encodes a non-ASCII subject and display names as RFC 2047 words', () => {
    const raw = compose(message({
      from: { address: 'owner@example.com', name: '李雷' },
      to: [{ address: 'han@example.com', name: '韩梅梅' }],
      subject: '周五的会议 — agenda',
    }), undefined, NOW)
    const headers = headersOf(raw)
    expect(headers.get('Subject')).toMatch(/^=\?UTF-8\?B\?/u)
    expect(decodeWords(headers.get('Subject') ?? '')).toBe('周五的会议 — agenda')
    expect(decodeWords(headers.get('From') ?? '')).toBe('李雷<owner@example.com>')
    expect(decodeWords(headers.get('To') ?? '')).toBe('韩梅梅<han@example.com>')
  })

  it('writes In-Reply-To and References of a reply from their message ids only', () => {
    const raw = compose(message({
      inReplyTo: '<m2@mail.example>',
      references: '<m1@mail.example> stray-text <m2@mail.example>',
    }), undefined, NOW)
    const headers = headersOf(raw)
    expect(headers.get('In-Reply-To')).toBe('<m2@mail.example>')
    expect(headers.get('References')).toBe('<m1@mail.example> <m2@mail.example>')
    const junk = headersOf(compose(message({ inReplyTo: 'not-an-id', references: 'nothing here' }), undefined, NOW))
    expect(junk.has('In-Reply-To')).toBe(false)
    expect(junk.has('References')).toBe(false)
  })

  it('refuses a subject or thread header holding a line break, so the model cannot add a header', () => {
    expect(() => compose(message({ subject: 'Hi\r\nBcc: spy@evil.example' }))).toThrow(AddressProblem)
    expect(() => compose(message({ subject: 'Hi\r\nBcc: spy@evil.example' }))).toThrow('the subject holds a line break')
    expect(() => compose(message({ inReplyTo: '<a@b>\r\nBcc: spy@evil.example' }))).toThrow('a thread header holds a line break')
    expect(() => compose(message({ references: '<a@b>\nX-Evil: 1' }))).toThrow('a thread header holds a line break')
  })

  it('writes a multipart/mixed message with the text first and each file as a base64 attachment', () => {
    const pdf = Uint8Array.from({ length: 120 }, (_, index) => index)
    const raw = compose(message({
      attachments: [
        { filename: 'report.pdf', contentType: 'application/pdf', data: pdf },
        { filename: '报告 (final) it\'s *v2*.txt', contentType: 'text/plain', data: Buffer.from('hello') },
        { filename: 'say "hi"\\now.txt', contentType: 'text/plain', data: Buffer.from('') },
      ],
    }), () => 'BOUNDARY-1', NOW)
    expect(headersOf(raw).get('Content-Type')).toBe('multipart/mixed; boundary="BOUNDARY-1"')
    const parts = raw.split('--BOUNDARY-1')
    expect(parts.at(-1)).toBe('--\r\n')
    expect(parts).toHaveLength(6)
    expect(parts[1]).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(parts[2]).toContain('Content-Type: application/pdf; name="report.pdf"')
    expect(parts[2]).toContain('Content-Disposition: attachment; filename="report.pdf"; filename*=UTF-8\'\'report.pdf')
    const pdfBody = (parts[2] ?? '').split('\r\n\r\n')[1] ?? ''
    for (const line of pdfBody.trim().split('\r\n')) expect(line.length).toBeLessThanOrEqual(76)
    expect(Buffer.from(pdfBody.replace(/\r\n/gu, ''), 'base64')).toEqual(Buffer.from(pdf))
    expect(parts[3]).toContain('name="__ (final) it\'s *v2*.txt"')
    expect(parts[3]).toContain('filename*=UTF-8\'\'%E6%8A%A5%E5%91%8A%20%28final%29%20it%27s%20%2Av2%2A.txt')
    expect(parts[4]).toContain('filename="say _hi__now.txt"')
  })

  it('draws a fresh boundary and the current time when none is given', () => {
    const before = Date.now()
    const raw = compose(message({ attachments: [{ filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('a') }] }))
    const boundary = /boundary="(fork-[0-9a-f]{24})"/u.exec(raw)?.[1]
    expect(boundary).toBeDefined()
    expect(raw).toContain(`--${boundary}--`)
    const date = Date.parse(headersOf(raw).get('Date') ?? '')
    expect(date).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000)
    const other = compose(message({ attachments: [{ filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('a') }] }))
    expect(other).not.toContain(`--${boundary}--`)
  })
})
