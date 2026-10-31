import { describe, expect, it } from 'vitest'
import { displayName, parseMessage } from '../src/text.ts'

describe('parseMessage', () => {
  it('joins text and renders mentions, faces, and replies', () => {
    const parsed = parseMessage([
      { type: 'reply', data: { id: '1234' } },
      { type: 'at', data: { qq: '10001', name: '小明' } },
      { type: 'text', data: { text: ' 看这个 ' } },
      { type: 'face', data: { id: '14' } },
      { type: 'at', data: { qq: 'all' } },
    ])
    expect(parsed.text).toBe('@小明  看这个 [表情]@全体成员')
    expect(parsed.replyTo).toBe('1234')
    expect(parsed.kinds).toEqual(['reply', 'at', 'text', 'face', 'at'])
  })

  it('collects images, voices, and files as media with their addresses', () => {
    const parsed = parseMessage([
      { type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/a.jpg', file: 'a.jpg', file_size: '2048' } },
      { type: 'record', data: { file: 'v.amr', url: 'https://example.invalid/v' } },
      { type: 'file', data: { file: 'doc.pdf', file_id: '/abc', file_size: 99, name: '周报.pdf' } },
    ])
    expect(parsed.text).toBe('[图片][语音][文件:周报.pdf]')
    expect(parsed.media).toEqual([
      { kind: 'image', url: 'https://multimedia.nt.qq.com.cn/a.jpg', file: 'a.jpg', name: 'a.jpg', bytes: 2048 },
      { kind: 'voice', url: 'https://example.invalid/v', file: 'v.amr', name: 'v.amr', bytes: undefined },
      { kind: 'file', url: undefined, file: '/abc', name: '周报.pdf', bytes: 99 },
    ])
  })

  it('reads a JSON card into its title and link', () => {
    const card = JSON.stringify({ prompt: '[分享]文章', meta: { news: { title: '标题', desc: '摘要', jumpUrl: 'https://example.com/x' } } })
    expect(parseMessage([{ type: 'json', data: { data: card } }]).text).toBe('[卡片:[分享]文章 / 标题 / 摘要 https://example.com/x]')
    expect(parseMessage([{ type: 'json', data: { data: 'not json' } }]).text).toBe('[卡片]')
  })

  it('strips CQ codes from a string-format message and tolerates nothing', () => {
    expect(parseMessage('你好[CQ:image,file=a.jpg]世界').text).toBe('你好世界')
    expect(parseMessage(undefined)).toEqual({ text: '', replyTo: undefined, media: [], kinds: [] })
  })

  it('marks unknown segment types and caps the length', () => {
    expect(parseMessage([{ type: 'weird', data: {} }]).text).toBe('[weird]')
    expect(Array.from(parseMessage([{ type: 'text', data: { text: 'x'.repeat(9000) } }]).text)).toHaveLength(4000)
  })
})

describe('displayName', () => {
  it('prefers the card, then the nickname, then the number', () => {
    expect(displayName({ card: ' 群名片 ', nickname: '昵称' }, '1')).toBe('群名片')
    expect(displayName({ card: '', nickname: '昵称' }, '1')).toBe('昵称')
    expect(displayName({}, '10001')).toBe('10001')
  })
})
