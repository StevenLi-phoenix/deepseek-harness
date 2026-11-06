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

describe('parseMessage rendering', () => {
  it('writes each kind of segment as its marker', () => {
    const parsed = parseMessage([
      { type: 'at', data: { qq: 'all' } },
      { type: 'at', data: { qq: '10001', name: '小明' } },
      { type: 'at', data: { qq: '10002' } },
      { type: 'at', data: {} },
      { type: 'face', data: { id: 1 } },
      { type: 'mface', data: { summary: '[笑]' } },
      { type: 'mface', data: {} },
      { type: 'video', data: { file: 'v.mp4', url: 'https://x/v' } },
      { type: 'forward', data: {} },
      { type: 'xml', data: {} },
      { type: 'share', data: { title: '标题', url: 'https://x/s' } },
      { type: 'poke', data: {} },
      { type: 'dice', data: {} },
      { type: 'rps', data: {} },
      { type: 'music', data: {} },
    ])
    expect(parsed.text).toBe('@全体成员 @小明 @10002 @ [表情][表情包:[笑]][表情包][视频][合并转发][卡片][分享:标题 https://x/s][戳一戳][骰子][猜拳][music]')
    expect(parsed.media).toEqual([{ kind: 'video', url: 'https://x/v', file: 'v.mp4', name: 'v.mp4' }])
    expect(parsed.kinds).toHaveLength(15)
  })

  it('keeps the id of the message a reply quotes, and marks an animated sticker', () => {
    const parsed = parseMessage([
      { type: 'reply', data: { id: 7788 } },
      { type: 'image', data: { summary: '[动画表情]', file: 'a.gif' } },
      { type: 'text', data: { text: 5 } },
      { type: 'text', data: { text: '' } },
    ])
    expect(parsed.replyTo).toBe('7788')
    expect(parsed.text).toBe('[动画表情]5')
  })

  it('names a file by its file field when it has no name, and leaves the name blank when it has neither', () => {
    const parsed = parseMessage([
      { type: 'file', data: { file: 'doc.pdf' } },
      { type: 'file', data: {} },
      { type: 'image', data: { file_size: 0 } },
      { type: 'image', data: { file_size: 'abc' } },
    ])
    expect(parsed.text).toBe('[文件:doc.pdf][文件:][图片][图片]')
    expect(parsed.media.map(item => [item.file, item.name, item.bytes])).toEqual([
      ['doc.pdf', 'doc.pdf', undefined], [undefined, undefined, undefined], [undefined, undefined, undefined], [undefined, undefined, undefined],
    ])
  })

  it('reads a card that has no meta, only a prompt, or only a link', () => {
    const card = (body: unknown): string => parseMessage([{ type: 'json', data: { data: JSON.stringify(body) } }]).text
    expect(card({})).toBe('[卡片]')
    expect(card({ prompt: '[小程序]' })).toBe('[卡片:[小程序]]')
    expect(card({ prompt: '[小程序]', meta: { a: { title: '[小程序]', qqdocurl: 'https://x/d' } } })).toBe('[卡片:[小程序] https://x/d]')
    expect(card({ meta: { a: { title: 5, desc: 5, jumpUrl: 5, qqdocurl: 5 } } })).toBe('[卡片]')
    expect(parseMessage([{ type: 'json', data: {} }]).text).toBe('[卡片]')
    expect(parseMessage([{ type: 'json', data: { data: 'null' } }]).text).toBe('[卡片]')
  })

  it('reads a share with only a title or only a link', () => {
    expect(parseMessage([{ type: 'share', data: { title: '标题' } }]).text).toBe('[分享:标题]')
    expect(parseMessage([{ type: 'share', data: {} }]).text).toBe('[分享:]')
  })

  it('treats a message that is neither a list nor a string as empty', () => {
    expect(parseMessage({} as never).kinds).toEqual([])
  })
})
