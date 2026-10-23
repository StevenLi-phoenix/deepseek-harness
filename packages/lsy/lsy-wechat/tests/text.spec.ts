import { describe, expect, it } from 'vitest'
import { buildDigest, contentText, fitText, formatGap, formatStamp, inboundText, relayText, renderNote, sharedNoteText, splitText, timeGapNotice } from '../src/text.ts'

describe('fitText', () => {
  it('keeps short text and cuts long text to the code-point limit', () => {
    expect(fitText('hello', 5)).toBe('hello')
    expect(fitText('hello world', 5)).toBe('hell…')
    expect(fitText('😀😀😀', 2)).toBe('😀…')
  })

  it('cuts to the byte limit', () => {
    // Each 中 is 3 bytes; the ellipsis is 3 bytes too.
    expect(fitText('中中中中', 100, 9)).toBe('中中…')
  })
})

describe('splitText', () => {
  it('returns text that fits unchanged', () => {
    expect(splitText('short', 100, 3)).toEqual(['short'])
  })

  it('splits at line breaks and labels the parts', () => {
    const text = `${'a'.repeat(30)}\n${'b'.repeat(30)}`
    expect(splitText(text, 48, 3)).toEqual([`[1/2]\n${'a'.repeat(30)}`, `[2/2]\n${'b'.repeat(30)}`])
  })

  it('hard-cuts text without usable line breaks and cuts the last allowed part', () => {
    const parts = splitText('x'.repeat(100), 28, 2)
    expect(parts).toEqual([`[1/2]\n${'x'.repeat(20)}`, `[2/2]\n${'x'.repeat(19)}…`])
  })

  it('splits text that fits in characters but not in bytes', () => {
    const parts = splitText('中'.repeat(40), 1000, 5, 100)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(100)
  })
})

describe('renderNote', () => {
  it('joins title, body, and link with blank lines and skips empty parts', () => {
    expect(renderNote({ title: 'T', body: 'B', url: 'https://x' })).toBe('T\n\nB\n\nhttps://x')
    expect(renderNote({ title: 'T', body: '  ' })).toBe('T')
  })
})

describe('inboundText', () => {
  it('renders text, voice transcripts, media placeholders, and quotes', () => {
    expect(inboundText({
      item_list: [
        { type: 1, text_item: { text: 'look' }, ref_msg: { title: 'old  title', message_item: { type: 1, text_item: { text: 'quoted\ntext' } } } },
        { type: 3, voice_item: { text: ' 你好 ' } },
        { type: 3, voice_item: null },
        { type: 2 },
        { type: 4, file_item: { file_name: 'report.pdf' } },
        { type: 4 },
        { type: 5 },
        { type: 99 },
        { type: 1, text_item: null, ref_msg: { title: 'Only a title' } },
        { type: 1, text_item: { text: 'x' }, ref_msg: { message_item: { type: 2 } } },
        { type: 1, text_item: { text: 'y' }, ref_msg: { title: '   ' } },
        { type: 1, text_item: { text: 'z' }, ref_msg: {} },
      ],
    })).toBe([
      '[引用] quoted text',
      'look',
      '[语音] 你好',
      '[语音]',
      '[图片]',
      '[文件 report.pdf]',
      '[文件]',
      '[视频]',
      '[引用] Only a title',
      '[引用] [图片]',
      'x',
      'y',
      'z',
    ].join('\n'))
  })

  it('is empty for a message without usable items', () => {
    expect(inboundText({})).toBe('')
    expect(inboundText({ item_list: [{ type: 99 }] })).toBe('')
  })

  it('bounds long quotes', () => {
    const text = inboundText({ item_list: [{ type: 1, text_item: { text: 'q' }, ref_msg: { title: 'z'.repeat(500) } }] })
    expect(text.split('\n')[0]).toBe(`[引用] ${'z'.repeat(199)}…`)
  })
})

describe('contentText', () => {
  it('joins text parts and ignores everything else', () => {
    expect(contentText([{ type: 'thinking', thinking: 'x' }, null, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'text' }])).toBe('a\nb')
    expect(contentText([{ type: 'text', text: '  ' }])).toBeUndefined()
  })
})

describe('relayText', () => {
  it.each([
    ['answer', 'completed', 'answer'],
    ['NO_REPLY', 'completed', undefined],
    [' NO_REPLY ', 'error', undefined],
    [undefined, 'completed', undefined],
    [undefined, 'error', '⚠️ 本轮未完成（error）'],
    [undefined, 'aborted', '⚠️ 本轮未完成（aborted）'],
    ['partial', 'max-tokens', 'partial\n\n⚠️ 本轮未完成（max-tokens）'],
  ] as const)('relays %j after %s as %j', (text, outcome, expected) => {
    expect(relayText(text, outcome)).toBe(expected)
  })

  it('adds the failure reason under the warning', () => {
    expect(relayText(undefined, 'error', 'AUTH: 401 User not found.')).toBe('⚠️ 本轮未完成（error）\n原因：AUTH: 401 User not found.')
    expect(relayText('partial', 'error', 'QUOTA: no credits')).toBe('partial\n\n⚠️ 本轮未完成（error）\n原因：QUOTA: no credits')
    expect(relayText('done', 'completed', 'ignored')).toBe('done')
  })
})

describe('buildDigest', () => {
  const at = Date.parse('2026-10-21T18:05:00Z')

  it('packs every queued text when they fit', () => {
    const digest = buildDigest([{ text: 'one', queuedAt: at }, { text: 'two', queuedAt: at + 60_000 }], 1000, 'America/New_York')
    expect(digest).toEqual({ count: 2, text: '📬 未送达的 2 条消息\n\n──────── 10/21 14:05\none\n\n──────── 10/21 14:06\ntwo' })
  })

  it('stops at the size limit and says more follow', () => {
    const queued = [{ text: 'a'.repeat(60), queuedAt: at }, { text: 'b'.repeat(60), queuedAt: at }, { text: 'c', queuedAt: at }]
    const digest = buildDigest(queued, 120, 'UTC')
    expect(digest.count).toBe(1)
    expect(digest.text.startsWith('📬 未送达的消息 1/3（其余稍后送达）')).toBe(true)
    expect(Array.from(digest.text).length).toBeLessThanOrEqual(120)
  })

  it('cuts a first text that does not fit on its own', () => {
    const digest = buildDigest([{ text: 'x'.repeat(500), queuedAt: at }], 200, 'UTC')
    expect(digest.count).toBe(1)
    expect(Array.from(digest.text).length).toBeLessThanOrEqual(200)
    expect(digest.text.endsWith('…')).toBe(true)
  })

  it('stops at the byte limit', () => {
    const digest = buildDigest([{ text: '中'.repeat(30), queuedAt: at }, { text: '中'.repeat(30), queuedAt: at }], 1000, 'UTC', 200)
    expect(digest.count).toBe(1)
    expect(Buffer.byteLength(digest.text, 'utf8')).toBeLessThanOrEqual(200)
  })
})

describe('formatStamp and formatGap', () => {
  it('prints weekday, date, and 24-hour time in the zone', () => {
    expect(formatStamp(Date.parse('2026-10-22T12:49:00Z'), 'America/New_York')).toBe('Thu 2026-10-22 08:49')
    expect(formatStamp(Date.parse('2026-10-22T04:05:00Z'), 'America/New_York')).toBe('Thu 2026-10-22 00:05')
  })

  it('rounds gaps down to minutes, hours, and days', () => {
    expect(formatGap(59_000)).toBe('under a minute')
    expect(formatGap(12 * 60_000 + 59_000)).toBe('12 min')
    expect(formatGap(5 * 3_600_000)).toBe('5 h')
    expect(formatGap(5 * 3_600_000 + 39 * 60_000)).toBe('5 h 39 min')
    expect(formatGap(2 * 86_400_000 + 3 * 3_600_000 + 7 * 60_000)).toBe('2 d 3 h')
    expect(formatGap(-5)).toBe('under a minute')
  })
})

describe('timeGapNotice', () => {
  const zone = 'America/New_York'
  const now = Date.parse('2026-10-22T12:49:00Z')
  const minGap = 30 * 60_000

  it('names the gap, the last message, and the owner\'s previous message after a quiet spell', () => {
    const text = timeGapNotice(now, { ownerAt: Date.parse('2026-10-21T18:00:00Z'), sentAt: Date.parse('2026-10-22T07:10:00Z'), sent: 'note' }, minGap, zone)
    expect(text).toBe(
      'Time check: the owner sent the message below at Thu 2026-10-22 08:49 (America/New_York), after 5 h 39 min of silence in this WeChat chat.'
      + ' The last message before it was a note another session (an event, reminder, monitor, or operator task) sent the owner, at Thu 2026-10-22 03:10;'
      + ' the owner last wrote at Wed 2026-10-21 14:00 (18 h 49 min ago).'
      + ' Read the new message on its own terms: it starts a new exchange unless it clearly refers back to something earlier.',
    )
  })

  it('says when the owner\'s own message was the last one', () => {
    const text = timeGapNotice(now, { ownerAt: Date.parse('2026-10-22T10:00:00Z'), sentAt: Date.parse('2026-10-22T09:00:00Z'), sent: 'reply' }, minGap, zone)
    expect(text).toContain('after 2 h 49 min of silence')
    expect(text).toContain('The last message before it was the owner\'s own, at Thu 2026-10-22 06:00.')
    expect(text).not.toContain('last wrote')
  })

  it('names a reply as the agent\'s own', () => {
    const text = timeGapNotice(now, { sentAt: Date.parse('2026-10-22T11:00:00Z'), sent: 'reply' }, minGap, zone)
    expect(text).toContain('The last message before it was your reply, at Thu 2026-10-22 07:00.')
  })

  it('stays silent while the chat is active, before any history, and when turned off', () => {
    expect(timeGapNotice(now, { ownerAt: now - minGap + 1 }, minGap, zone)).toBeUndefined()
    expect(timeGapNotice(now, { ownerAt: now - 60 * 60_000, sentAt: now - 60_000, sent: 'reply' }, minGap, zone)).toBeUndefined()
    expect(timeGapNotice(now, undefined, minGap, zone)).toBeUndefined()
    expect(timeGapNotice(now, {}, minGap, zone)).toBeUndefined()
    expect(timeGapNotice(now, { ownerAt: now - 86_400_000 }, 0, zone)).toBeUndefined()
  })
})

describe('sharedNoteText', () => {
  it('dates the note instead of calling it new', () => {
    const text = sharedNoteText('host-alerts: 1 event(s)', Date.parse('2026-10-22T07:10:00Z'), 'America/New_York')
    expect(text).toBe(
      'At Thu 2026-10-22 03:10 (America/New_York), another session (an event, reminder, monitor, or operator task) sent the owner this message on WeChat.'
      + ' It is context, not the owner speaking: the owner may reply to it in this chat.\nhost-alerts: 1 event(s)',
    )
  })
})
