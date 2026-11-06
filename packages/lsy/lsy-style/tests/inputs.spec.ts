import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QqMessage, QqSource } from '../src/collect.ts'
import { gatherInputs, WebInbox, webLines, webResultText, type HotSource } from '../src/inputs.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

const NOW = 1_000_000_000
const message = (text: string, over: Partial<QqMessage> = {}): QqMessage => ({
  messageId: 'm', userId: 'u', at: NOW - 3_600_000, text, replyTo: null, kinds: 'text', card: '', nickname: '', ...over,
})
const qqOf = (
  messages: QqMessage[], recentMessages: QqSource['recentMessages'] = async () => messages,
  groups = [{ groupId: 'g1', recorded: true }, { groupId: 'g2', recorded: false }],
): QqSource => ({ groupOverview: async () => groups, recentMessages })
const window = { hours: 24, limit: 100, settleMs: 120_000 }
const base = { window, sinceMs: 5, now: NOW }

describe('gatherInputs', () => {
  it('reads recorded QQ groups, leaving out unsettled messages, media, and blank text', async () => {
    const rows = [message('可以读的话'), message('太新了', { at: NOW - 1000 }), message('图片', { kinds: 'image' }), message('   ')]
    const recentMessages = vi.fn<QqSource['recentMessages']>(async () => rows)
    const out = await gatherInputs({ ...base, qq: qqOf(rows, recentMessages), warn: vi.fn() })
    expect(out).toEqual([{ kind: 'qq', text: '可以读的话', likes: 0 }])
    expect(recentMessages.mock.calls).toEqual([['g1', { hours: 24, limit: 100 }]])
  })

  it('warns and goes on when QQ cannot be read, whether the failure is an Error or not', async () => {
    const warn = vi.fn<(message: string) => void>()
    const down: QqSource = { groupOverview: async () => { throw new Error('recorder down') }, recentMessages: async () => [] }
    const odd: QqSource = { groupOverview: async () => { throw 'closed' }, recentMessages: async () => [] }
    expect(await gatherInputs({ ...base, qq: down, web: ['网页上的一句话。'], warn })).toEqual([{ kind: 'web', text: '网页上的一句话。', likes: 0 }])
    await gatherInputs({ ...base, qq: odd, warn })
    expect(warn.mock.calls.map(call => call[0])).toEqual([
      'lsy-style: miner could not read QQ: recorder down', 'lsy-style: miner could not read QQ: closed',
    ])
  })

  it('reads Bilibili hot comments and words, as words or plain strings, with the earliest row', async () => {
    const comments = vi.fn<HotSource['comments']>(() => [{ text: '热评内容', likes: 7 }])
    const words = vi.fn<HotSource['words']>(async () => ['热搜词', { word: '另一个词' }])
    const out = await gatherInputs({ ...base, hot: { comments, words }, warn: vi.fn() })
    expect(out).toEqual([
      { kind: 'comment', text: '热评内容', likes: 7 }, { kind: 'hot', text: '热搜词', likes: 0 }, { kind: 'hot', text: '另一个词', likes: 0 },
    ])
    expect(comments.mock.calls).toEqual([[{ since: 5 }]])
    expect(words.mock.calls).toEqual([[{ since: 5 }]])
  })

  it('warns and goes on when the hot source fails, whether the failure is an Error or not', async () => {
    const warn = vi.fn<(message: string) => void>()
    const failing = (reason: unknown): HotSource => ({ comments: async () => { throw reason }, words: () => [] })
    await gatherInputs({ ...base, hot: failing(new Error('bili down')), warn })
    await gatherInputs({ ...base, hot: failing('closed'), warn })
    expect(warn.mock.calls.map(call => call[0])).toEqual([
      'lsy-style: miner could not read ctx.biliHot: bili down', 'lsy-style: miner could not read ctx.biliHot: closed',
    ])
  })
})

describe('webLines and webResultText', () => {
  it('splits a page into sentences and lines of a readable length', () => {
    expect(webLines('这个梗很火。他说：好！\n短\n' + '长'.repeat(201))).toEqual(['这个梗很火。', '他说：好！'])
  })

  it('takes the text of a search or fetch result matched to its call by id, once', () => {
    const names = new Map<string, string>()
    const call = (id: string, name: string) => ({ type: 'tool/call', data: { callId: id, name } }) as never
    const result = (id: string, content: unknown) => ({ type: 'tool/result', data: { message: { toolCallId: id, content } } }) as never
    expect(webResultText(names, call('a', 'web_search'))).toBeUndefined()
    expect(webResultText(names, call('b', 'shell'))).toBeUndefined()
    expect(webResultText(names, { type: 'turn/start', data: {} } as never)).toBeUndefined()
    expect(webResultText(names, result('b', [{ type: 'text', text: '别的工具' }]))).toBeUndefined()
    expect(webResultText(names, result('a', [{ type: 'text', text: '第一段' }, { type: 'image' }, { type: 'text' }, { type: 'text', text: '第二段' }]))).toBe('第一段\n\n第二段')
    expect(webResultText(names, result('a', [{ type: 'text', text: '第一段' }]))).toBeUndefined()
    webResultText(names, call('c', 'web_fetch'))
    expect(webResultText(names, result('c', 'plain'))).toBeUndefined()
    webResultText(names, call('d', 'web_fetch'))
    expect(webResultText(names, result('d', [{ type: 'image' }]))).toBeUndefined()
  })
})

describe('WebInbox', () => {
  async function open(over: Partial<{ items: number; chars: number; days: number }> = {}, clock = { at: NOW }) {
    const dir = await mkdtemp(join(tmpdir(), 'lsy-style-inbox-'))
    dirs.push(dir)
    const file = join(dir, 'sub', 'web-inbox.json')
    return { file, clock, inbox: new WebInbox(file, { items: 3, chars: 50, days: 2, ...over }, () => clock.at) }
  }

  it('keeps cut, non-blank, distinct texts, the newest items within the cap, and drops old ones', async () => {
    const { inbox, file, clock } = await open()
    await inbox.add(['  ', '甲'.repeat(80), '甲'.repeat(80), '乙。'])
    clock.at += 1000
    await inbox.add(['丙。', '丁。', '戊。'])
    const stored = JSON.parse(await readFile(file, 'utf8')) as Array<{ text: string }>
    expect(stored).toHaveLength(3)
    expect(stored.map(item => item.text).toSorted()).toEqual(['丁。', '丙。', '戊。'])
    clock.at += 3 * 86_400_000
    expect(await inbox.lines()).toEqual([])
  })

  it('finds the lines that mention a term, cut to the length asked', async () => {
    const { inbox } = await open({ items: 10 })
    await inbox.add(['海水过滤器是个梗。电鳗发电机也是。', '无关的一句话。'])
    expect(await inbox.around('海水过滤器', 100)).toBe('海水过滤器是个梗。')
    expect(await inbox.around('海水过滤器', 3)).toBe('海水过')
    expect(await inbox.around('不存在的词', 100)).toBeUndefined()
    expect(await inbox.around('  ', 100)).toBeUndefined()
  })

  it('starts empty when the file is damaged, ignores rows of the wrong shape, and survives one failed write', async () => {
    const { inbox, file } = await open()
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, '{"not":"a list"}')
    expect(await inbox.lines()).toEqual([])
    await writeFile(file, '{torn')
    expect(await inbox.lines()).toEqual([])
    await writeFile(file, JSON.stringify([{ id: 'x', at: NOW, text: '好的一行。' }, { id: 'y', at: 'now', text: '不要' }, null, { id: 'z', at: NOW }]))
    expect(await inbox.lines()).toEqual(['好的一行。'])
    await rm(file)
    await mkdir(file)
    await expect(inbox.add(['会失败的。'])).rejects.toThrow()
    await rm(file, { recursive: true })
    await inbox.add(['之后成功。'])
    expect(await inbox.lines()).toEqual(['之后成功。'])
  })
})
