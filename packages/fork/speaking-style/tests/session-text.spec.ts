import { describe, expect, it } from 'vitest'
import { isPublicTextTool, recentPublicText, WEB_TOOLS, type SessionLog } from '../src/session-text.ts'

type Piece = { type: 'turn/start' } | { type: 'gap' } | { type: 'call'; id: string; name: string } | { type: 'result'; id: string; content: unknown }

/** A Session log made of the given pieces; a `gap` is a sequence number with no event. */
function log(...pieces: Piece[]): SessionLog {
  const events = pieces.map((piece) => {
    if (piece.type === 'turn/start') return { type: 'turn/start', data: {} }
    if (piece.type === 'gap') return undefined
    if (piece.type === 'call') return { type: 'tool/call', data: { callId: piece.id, name: piece.name } }
    return { type: 'tool/result', data: { message: { toolCallId: piece.id, content: piece.content } } }
  })
  return { seq: events.length, eventAt: (seq: number) => events[seq] } as never
}
const text = (value: string) => [{ type: 'text', text: value }]
const read = (id: string, name: string, content: unknown): Piece[] => [{ type: 'call', id, name }, { type: 'result', id, content }]

describe('recentPublicText', () => {
  it('collects the text of public tool results and the string values of a JSON result, skipping other tools', () => {
    const session = log(
      { type: 'turn/start' },
      ...read('a', 'web_search', text('{"title":"某个梗","items":["甲",["乙"]],"n":1}')),
      ...read('b', 'memory_read', text('私人记忆')),
      ...read('c', 'bili_comments', text('不是 JSON 的评论')),
      { type: 'result', id: 'orphan', content: text('没有调用记录') },
    )
    expect(recentPublicText(session)).toEqual(['{"title":"某个梗","items":["甲",["乙"]],"n":1}', '某个梗', '甲', '乙', '不是 JSON 的评论'])
  })

  it('reads only the open turn and the one before it, and skips sequence numbers without an event', () => {
    const session = log(
      ...read('old', 'web_fetch', text('第一轮')),
      { type: 'turn/start' },
      ...read('mid', 'web_fetch', text('第二轮')),
      { type: 'gap' },
      { type: 'turn/start' },
      ...read('new', 'web_fetch', text('第三轮')),
    )
    expect(recentPublicText(session, { leaves: false })).toEqual(['第二轮', '第三轮'])
  })

  it('limits the tools when asked to, and keeps whole results only when leaves is off', () => {
    const session = log(...read('a', 'qq_recent', text('["一"]')), ...read('b', 'web_search', text('["二"]')))
    expect(recentPublicText(session, { tools: WEB_TOOLS })).toEqual(['["二"]', '二'])
    expect(recentPublicText(session, { leaves: false })).toEqual(['["一"]', '["二"]'])
  })

  it('ignores results without text: other content shapes, blocks of other types, and empty text', () => {
    const session = log(
      ...read('a', 'web_fetch', 'plain string'),
      ...read('b', 'web_fetch', [{ type: 'image' }, { type: 'text' }]),
      ...read('c', 'web_fetch', text('')),
      ...read('d', 'web_fetch', [{ type: 'text', text: '有字' }]),
    )
    expect(recentPublicText(session, { leaves: false })).toEqual(['有字'])
  })

  it('stops adding text past the character budget, but still takes a smaller result after it', () => {
    const session = log(
      ...read('big', 'web_fetch', text('字'.repeat(399_999))),
      ...read('over', 'web_fetch', text('溢出')),
      ...read('fits', 'web_fetch', text('好')),
    )
    expect(recentPublicText(session, { leaves: false }).map(item => item.length)).toEqual([399_999, 1])
  })

  it('stops reading after 400 events, so a result older than that is not returned', () => {
    const filler: Piece[] = Array.from({ length: 450 }, () => ({ type: 'call' as const, id: 'x', name: 'shell' }))
    expect(recentPublicText(log(...read('early', 'web_fetch', text('太早了')), ...filler), { leaves: false })).toEqual([])
    expect(recentPublicText(log(...filler, ...read('late', 'web_fetch', text('最近'))), { leaves: false })).toEqual(['最近'])
  })
})

describe('isPublicTextTool', () => {
  it('counts the web, QQ, and Bilibili reads', () => {
    expect([isPublicTextTool('web_search'), isPublicTextTool('qq_digest'), isPublicTextTool('bili_x'), isPublicTextTool('up_comments')]).toEqual([true, true, true, true])
    expect([isPublicTextTool('memory_read'), isPublicTextTool('shell')]).toEqual([false, false])
  })
})
