/** The typed Bilibili operations over a caller double: how each reads answers that are partial, odd, or hostile. */
import { describe, expect, it, vi } from 'vitest'
import {
  addWatchLater, clockText, coinsGiven, commentRows, comments, dailyRewards, danmaku, dealFavorite, folders, followingFeed,
  giveCoin, hasLiked, homeFeed, hotSearches, inboxItems, likeVideo, modifyRelation, navInfo, ownerMessages, popular, ranking,
  relationStat, relationTo, removeWatchLater, reportWatch, search, subtitles, thread, threadRows, tripleLike, unreadCounts,
  unreadMessages, videoInfo, watchLaterAids,
} from '../src/api.ts'
import { BiliApiError, BiliSessionError, BiliTransportError, type CallOptions } from '../src/client.ts'
import type { EndpointName } from '../src/endpoints.ts'

const TZ = 'Asia/Shanghai'
const BV = 'BV1aa4y1X7aa'

/** Matchers typed as `unknown`, so they can sit inside an expected object. */
const contains = (fields: Record<string, unknown>): unknown => expect.objectContaining(fields)
const text = (part: string): unknown => expect.stringContaining(part)

/** A caller whose endpoints answer `answers[name]` (a function gets the options; an Error is thrown). */
function caller(answers: Partial<Record<EndpointName, unknown>>) {
  const call = vi.fn((name: EndpointName, options?: CallOptions) => {
    const answer = answers[name]
    const data = typeof answer === 'function' ? (answer as (options?: CallOptions) => unknown)(options) : answer
    if (data instanceof Error) return Promise.reject(data)
    return Promise.resolve({ data, body: {} })
  })
  return { call }
}

describe('clockText', () => {
  it('writes minutes and seconds, adds hours, and has no text for a missing or negative length', () => {
    expect(clockText(65.9)).toBe('1:05')
    expect(clockText(3723)).toBe('1:02:03')
    expect(clockText(undefined)).toBeUndefined()
    expect(clockText(-1)).toBeUndefined()
  })
})

describe('navInfo', () => {
  it('reads the account facts, with no experience when Bilibili sends none and 0 coins when it omits them', async () => {
    expect(await navInfo(caller({ nav: { isLogin: true, mid: 5, uname: '猫', money: 3, level_info: { current_level: 2, current_exp: 100, current_min: 50, next_exp: 200 } } }))).toEqual({
      isLogin: true, mid: 5, uname: '猫', level: 2, exp: { current: 100, min: 50, next: 200 }, coins: 3,
    })
    const bare = await navInfo(caller({ nav: { isLogin: true, mid: 5, level_info: { current_exp: 7 } } }))
    expect(bare).toMatchObject({ exp: { current: 7, min: 0, next: null }, coins: 0 })
    expect(await navInfo(caller({ nav: { isLogin: true } }))).toEqual({ isLogin: true, uname: '', coins: 0 })
  })

  it('answers signed out when Bilibili says so, by data, by code -101, or by an ended session; any other failure is the caller\'s', async () => {
    expect(await navInfo(caller({ nav: { isLogin: false } }))).toEqual({ isLogin: false })
    expect(await navInfo(caller({ nav: new BiliApiError('nav', -101, '账号未登录') }))).toEqual({ isLogin: false })
    expect(await navInfo(caller({ nav: new BiliSessionError('nav', 'session_expired', '') }))).toEqual({ isLogin: false })
    await expect(navInfo(caller({ nav: new BiliApiError('nav', -412, '') }))).rejects.toThrow('code -412')
    await expect(navInfo(caller({ nav: new Error('boom') }))).rejects.toThrow('boom')
  })
})

describe('video lists', () => {
  it('keeps the av items of the home feed with their reasons, leaving out other kinds and items without a valid BV id', async () => {
    const feed = caller({
      homeFeed: {
        item: [
          { goto: 'av', bvid: BV, title: '猫', owner: { name: '甲', mid: 7 }, stat: { view: 9, like: 2 }, duration: 75, pubdate: 1_761_955_200, rcmd_reason: { content: '你关注的人赞过' } },
          { goto: 'av', bvid: 'BV1bb4y1X7bb', title: '狗', author: '乙', mid: 8, play: 4, duration: '3:20', pubdate: 0 },
          { goto: 'ad', bvid: 'BV1cc4y1X7cc' },
          { goto: 'av', bvid: 'nope' },
        ],
      },
    })
    expect(await homeFeed(feed, 3, TZ)).toEqual([
      { bvid: BV, title: '猫', author: '甲', authorMid: 7, duration: '1:15', views: 9, likes: 2, published: '2025-11-01', reason: '你关注的人赞过' },
      { bvid: 'BV1bb4y1X7bb', title: '狗', author: '乙', authorMid: 8, duration: '3:20', views: 4 },
    ])
    expect(feed.call).toHaveBeenCalledWith('homeFeed', { query: contains({ fresh_idx: 3, brush: 3 }) })
  })

  it('reads popular, ranking (at most 30), and search results, newest first when asked, leaving out other result types', async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ bvid: `BV1aa4y1X${String(index).padStart(3, '0')}`, title: `t${index}` }))
    expect((await popular(caller({ popular: { list: many } }), 2, TZ))).toHaveLength(40)
    expect((await ranking(caller({ ranking: { list: many } }), TZ))).toHaveLength(30)
    const found = caller({
      search: { result: [{ type: 'video', bvid: BV, title: '猫', description: '很长的\n简介' }, { bvid: 'BV1bb4y1X7bb', title: '无类型' }, { type: 'bili_user', bvid: 'BV1cc4y1X7cc' }] },
    })
    expect((await search(found, '猫', 1, TZ)).map(card => card.bvid)).toEqual([BV, 'BV1bb4y1X7bb'])
    expect(found.call).toHaveBeenLastCalledWith('search', { query: { search_type: 'video', keyword: '猫', page: 1 } })
    expect((await search(found, '猫', 2, TZ, 'newest'))[0]).toMatchObject({ desc: '很长的\n简介' })
    expect(found.call).toHaveBeenLastCalledWith('search', { query: { search_type: 'video', keyword: '猫', page: 2, order: 'pubdate' } })
  })

  it('lists hot searches with a label only when it differs from the keyword, and skips empty ones', async () => {
    const hot = caller({ hotSearch: { trending: { list: [{ keyword: '鱼灾', show_name: 'B站鱼灾' }, { keyword: '猫', show_name: '猫' }, { keyword: '狗' }, { keyword: '  ' }] } } })
    expect(await hotSearches(hot, 30)).toEqual([{ keyword: '鱼灾', label: 'B站鱼灾' }, { keyword: '猫' }, { keyword: '狗' }])
  })
})

describe('followingFeed', () => {
  it('normalizes videos, posts, forwards, and other items, and gives next only while there is more', async () => {
    const author = { module_author: { name: '甲', mid: 7, pub_ts: 1_761_955_200 } }
    const page = {
      has_more: true,
      offset: 'o-2',
      items: [
        { id_str: '11', type: 'DYNAMIC_TYPE_AV', modules: { ...author, module_dynamic: { major: { archive: { bvid: BV, title: '猫', desc: '简介', duration_text: '1:00', stat: { play: 3 } } } } } },
        { id_str: '12', type: 'DYNAMIC_TYPE_AV', modules: { ...author, module_dynamic: { major: {} } } },
        { id_str: '13', type: 'DYNAMIC_TYPE_WORD', modules: { ...author, module_dynamic: { desc: { text: '今天开播' } } } },
        { id_str: '14', type: 'DYNAMIC_TYPE_OPUS', modules: { ...author, module_dynamic: { major: { opus: { summary: { text: '图文' } } } } } },
        {
          id_str: '15',
          type: 'DYNAMIC_TYPE_FORWARD',
          modules: { ...author, module_dynamic: { desc: { text: '转发' } } },
          orig: { modules: { module_author: { name: '乙' }, module_dynamic: { major: { archive: { bvid: 'BV1bb4y1X7bb', title: '原视频' } } } } },
        },
        {
          id_str: '16',
          type: 'DYNAMIC_TYPE_FORWARD',
          modules: { module_dynamic: {} },
          orig: { modules: { module_author: { name: '丙' }, module_dynamic: { desc: { text: '原动态' } } } },
        },
        { id_str: '17', type: 'DYNAMIC_TYPE_LIVE_RCMD', modules: { module_author: { name: '丁' } } },
        { type: 'DYNAMIC_TYPE_WORD' },
      ],
    }
    const feed = caller({ followingFeed: page })
    const result = await followingFeed(feed, 'o-1', TZ)
    expect(feed.call).toHaveBeenCalledWith('followingFeed', { query: contains({ offset: 'o-1' }) })
    expect(result.next).toBe('o-2')
    expect(result.items.map(item => [item.kind, item.id])).toEqual([['video', '11'], ['post', '13'], ['post', '14'], ['forward', '15'], ['forward', '16'], ['other', '17']])
    expect(result.items[0]).toMatchObject({ author: '甲', authorMid: 7, at: 'Sat 2025-11-01 08:00', video: { bvid: BV, desc: '简介', duration: '1:00', views: 3 } })
    expect(result.items[2]).toMatchObject({ text: '图文' })
    expect(result.items[3]).toMatchObject({ text: '转发', quoted: '乙: 原视频 (BV1bb4y1X7bb)' })
    expect(result.items[4]).toMatchObject({ quoted: '丙: 原动态' })
    expect(result.items[5]).toMatchObject({ text: 'DYNAMIC_TYPE_LIVE_RCMD' })

    const last = caller({ followingFeed: { has_more: false, offset: 'x', items: [] } })
    expect(await followingFeed(last, undefined, TZ)).toEqual({ items: [] })
    expect(last.call).toHaveBeenCalledWith('followingFeed', { query: { type: 'all', platform: 'web', features: 'itemOpusStyle', timezone_offset: -480 } })
    expect(await followingFeed(caller({ followingFeed: { has_more: true, offset: '' } }), undefined, TZ)).toEqual({ items: [] })
  })
})

describe('danmaku', () => {
  it('reads the lines in time order with entities decoded, leaves out empty lines, and thins a long list evenly', async () => {
    const xml = '<i><d p="12.5,1,25">后&amp;前&lt;&gt;&quot;&apos;</d><d p="3,1,25">先</d><d p="4,1,25"></d></i>'
    expect(await danmaku(caller({ danmaku: xml }), 1, 10)).toEqual([{ at: 3, text: '先' }, { at: 12, text: '后&前<>"\'' }])
    expect(await danmaku(caller({ danmaku: { not: 'xml' } }), 1, 10)).toEqual([])
    const long = `<i>${Array.from({ length: 100 }, (_, index) => `<d p="${index},1">行${index}</d>`).join('')}</i>`
    const thinned = await danmaku(caller({ danmaku: long }), 1, 10)
    expect(thinned).toHaveLength(10)
    expect(thinned[0]!.at).toBe(0)
    expect(thinned.at(-1)!.at).toBeGreaterThan(80)
  })
})

describe('videoInfo', () => {
  it('reads the facts and parts of a video, original or not', async () => {
    const view = {
      bvid: BV, aid: 101, cid: 9001, title: '猫', desc: '简介', owner: { name: '甲', mid: 7 }, duration: 125, copyright: 1, tname: '动物',
      stat: { view: 5, like: 1, favorite: 2, coin: 3, reply: 4, danmaku: 6 },
      pages: [{ page: 1, cid: 9001, part: 'P1', duration: 60 }, { part: '无编号' }],
    }
    expect(await videoInfo(caller({ view }), BV, TZ)).toMatchObject({
      aid: '101', cid: 9001, original: true, seconds: 125, category: '动物', favorites: 2, coins: 3, comments: 4, danmaku: 6,
      parts: [{ page: 1, cid: 9001, title: 'P1', duration: '1:00' }, { page: 1, cid: 0, title: '无编号' }],
    })
    const plain = await videoInfo(caller({ view: { ...view, copyright: 2, tname: '' } }), BV, TZ)
    expect(plain).toMatchObject({ original: false })
    expect(plain).not.toHaveProperty('category')
  })

  it('refuses an answer without the ids a read needs', async () => {
    for (const view of [{}, { bvid: BV, cid: 1 }, { bvid: BV, aid: 1 }, { aid: 1, cid: 1 }]) {
      await expect(videoInfo(caller({ view }), BV, TZ)).rejects.toBeInstanceOf(BiliTransportError)
    }
  })
})

describe('subtitles', () => {
  const track = (lan: string, extra: Record<string, unknown> = {}) => ({ lan, lan_doc: lan, subtitle_url: `//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${lan}?auth_key=1`, ...extra })
  const lines = (count: number) => ({ body: Array.from({ length: count }, (_, index) => ({ from: index, to: index + 1, content: `第${index}句` })) })

  it('prefers a Chinese track over an AI Chinese one, those over other languages, and reads it as a human or machine transcript', async () => {
    const tracks = [track('ai-en'), track('en'), track('ai-zh'), track('zh-CN')]
    const reads: string[] = []
    const client = caller({
      player: { subtitle: { subtitles: tracks } },
      subtitleAi: (options?: CallOptions) => { reads.push(`ai ${options?.path}`); return lines(3) },
      subtitleFile: (options?: CallOptions) => { reads.push(`file ${options?.path}`); return lines(3) },
    })
    const result = await subtitles(client, BV, 9001, 1)
    expect(result.view).toMatchObject({ available: true, language: 'zh-CN', machine: false, page: 1, pages: 1 })
    expect(result.reached).toBe(3)
    expect(reads).toHaveLength(1)
    const ai = await subtitles(caller({ player: { subtitle: { subtitles: [track('ai-en'), track('ai-zh')] } }, subtitleAi: lines(2) }), BV, 9001, 1)
    expect(ai.view).toMatchObject({ language: 'ai-zh', machine: true })
    const other = await subtitles(caller({ player: { subtitle: { subtitles: [track('ai-en'), track('en')] } }, subtitleFile: lines(2), subtitleAi: lines(2) }), BV, 9001, 1)
    expect(other.view).toMatchObject({ language: 'en', machine: false })
    const named = await subtitles(caller({ player: { subtitle: { subtitles: [{ lan: 'zh-Hans', subtitle_url: track('zh').subtitle_url }] } }, subtitleAi: lines(1), subtitleFile: lines(1) }), BV, 9001, 1)
    expect(named.view).toMatchObject({ language: 'zh-Hans' })
    const flagged = await subtitles(caller({ player: { subtitle: { subtitles: [track('en', { ai_type: 1 })] } }, subtitleAi: lines(1), subtitleFile: lines(1) }), BV, 9001, 1)
    expect(flagged.view).toMatchObject({ machine: true })
  })

  it('answers no subtitles when the player lists none, the URL is not an allowed file, or the file is empty', async () => {
    const none = { view: { available: false, coverage: text('No subtitle track') } }
    expect(await subtitles(caller({ player: {} }), BV, 1, 1)).toMatchObject(none)
    expect(await subtitles(caller({ player: { subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://evil.example/x.json' }] } } }), BV, 1, 1)).toMatchObject(none)
    expect(await subtitles(caller({ player: { subtitle: { subtitles: [{ lan: 'zh' }] } } }), BV, 1, 1)).toMatchObject(none)
    expect(await subtitles(caller({ player: { subtitle: { subtitles: [track('zh')] } }, subtitleAi: { body: [] }, subtitleFile: { body: [] } }), BV, 1, 1)).toMatchObject(none)
  })

  it('pages the text by length, clamps the page asked for, and marks lines without a time', async () => {
    const long = { body: Array.from({ length: 30 }, (_, index) => ({ from: index * 10, to: index * 10 + 9, content: '字'.repeat(290) })) }
    const client = caller({ player: { subtitle: { subtitles: [track('zh')] } }, subtitleAi: long, subtitleFile: long })
    const second = await subtitles(client, BV, 1, 2)
    expect(second.view).toMatchObject({ available: true, page: 2 })
    const pages = (second.view as { pages: number }).pages
    expect(pages).toBeGreaterThan(2)
    expect((await subtitles(client, BV, 1, 99)).view).toMatchObject({ page: pages })
    expect((await subtitles(client, BV, 1, 0)).view).toMatchObject({ page: 1 })
    const odd = caller({ player: { subtitle: { subtitles: [track('zh')] } }, subtitleAi: { body: [{ content: '无时间' }, { from: 5, content: '只有开始' }] }, subtitleFile: { body: [{ content: '无时间' }, { from: 5, content: '只有开始' }] } })
    const result = await subtitles(odd, BV, 1, 1)
    expect((result.view as { text: string }).text).toBe('[?] 无时间\n[0:05] 只有开始')
    expect(result.reached).toBe(5)
  })
})

describe('comments', () => {
  const item = (rpid: number, extra: Record<string, unknown> = {}) => ({ rpid, member: { uname: `u${rpid}`, mid: rpid }, content: { message: `评论${rpid}` }, like: 3, rcount: 2, ctime: 1_761_955_200, ...extra })

  it('asks for the hot or new order and an offset, and gives next only while the area has more', async () => {
    const page = caller({ replies: { replies: [item(1)], cursor: { is_end: false, pagination_reply: { next_offset: 'n2' } } } })
    expect(await commentRows(page, { type: 1, oid: '101' }, { order: 'hot', offset: 'n1' })).toMatchObject({ next: 'n2' })
    expect(page.call).toHaveBeenLastCalledWith('replies', { query: contains({ mode: 3, pagination_str: '{"offset":"n1"}' }) })
    await commentRows(page, { type: 1, oid: '101' }, { order: 'new' })
    expect(page.call).toHaveBeenLastCalledWith('replies', { query: contains({ mode: 2, pagination_str: '{"offset":""}' }) })
    for (const cursor of [{ is_end: true, pagination_reply: { next_offset: 'n2' } }, { pagination_reply: {} }, { pagination_reply: { next_offset: '' } }]) {
      expect((await commentRows(caller({ replies: { replies: [], cursor } }), { type: 1, oid: '101' }, { order: 'hot' })).next).toBeUndefined()
    }
  })

  it('normalizes comments with their first two replies, by string id or number, and drops rows without an id', async () => {
    const page = caller({
      replies: {
        replies: [
          item(1, { rpid_str: '600000000000000001', replies: [item(11), item(12), item(13), { member: {} }] }),
          { rpid: -5, content: { message: 'bad id' } },
          item(2, { ctime: undefined, like: undefined, rcount: undefined, replies: [] }),
        ],
      },
    })
    const result = await comments(page, '101', { order: 'hot' }, TZ)
    expect(result.comments.map(row => row.rpid)).toEqual(['600000000000000001', '2'])
    expect(result.comments[0]!.preview?.map(row => row.rpid)).toEqual(['11', '12'])
    expect(result.comments[0]).toMatchObject({ author: 'u1', likes: 3, replies: 2, at: 'Sat 2025-11-01 08:00' })
    expect(result.comments[1]).toEqual({ rpid: '2', author: 'u2', authorMid: 2, text: '评论2' })
    expect(result).not.toHaveProperty('next')
  })

  it('reads a thread: its root when sent, its replies, and the total', async () => {
    const area = { type: 1, oid: '101', root: '7' }
    const full = caller({ replyThread: { root: item(7), replies: [item(8), { bad: true }], page: { count: 5 } } })
    expect(await threadRows(full, area, 2)).toMatchObject({ root: { rpid: 7 }, count: 5 })
    expect(full.call).toHaveBeenCalledWith('replyThread', { query: contains({ pn: 2, root: '7' }) })
    expect(await thread(full, area, 1, TZ)).toMatchObject({ root: { rpid: '7' }, replies: [{ rpid: '8' }], count: 5 })
    expect(await thread(caller({ replyThread: {} }), area, 1, TZ)).toEqual({ replies: [] })
  })
})

describe('inbox and messages', () => {
  it('counts unread replies, mentions, and messages, taking a count Bilibili omits as 0', async () => {
    const both = caller({ unread: { reply: 2, at: 1 }, dmUnread: { follow_unread: 3, unfollow_unread: 4 } })
    expect(await unreadCounts(both)).toEqual({ replies: 2, mentions: 1, messages: 7 })
    expect(await unreadMessages(both)).toBe(7)
    const none = caller({ unread: {}, dmUnread: {} })
    expect(await unreadCounts(none)).toEqual({ replies: 0, mentions: 0, messages: 0 })
    expect(await unreadMessages(none)).toBe(0)
  })

  it('lists the replies and mentions that name every id a reply needs, and skips the rest', async () => {
    const entry = (extra: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({
      id: 5, reply_time: 1_761_955_200, user: { nickname: '甲', mid: 7 }, item: { source_id: 100, subject_id: 200, business_id: 1, root_id: 0, source_content: '你好', title: '视频', ...item }, ...extra,
    })
    const reply = caller({
      replyFeed: {
        items: [
          entry(), entry({ id: 6 }, { root_id: 90 }), entry({ id: undefined }), entry({}, { source_id: undefined }),
          entry({}, { subject_id: undefined }), entry({}, { business_id: 0 }), entry({ reply_time: undefined }),
        ],
      },
    })
    const items = await inboxItems(reply, 'reply')
    expect(items.map(row => [row.id, row.rpid, row.root])).toEqual([['5', '100', '100'], ['6', '100', '90']])
    expect(items[0]).toMatchObject({ at: 1_761_955_200_000, from: '甲', fromMid: 7, text: '你好', about: '视频', type: 1, oid: '200' })
    const mention = caller({ atFeed: { items: [entry({ reply_time: undefined, at_time: 1_761_955_201, user: {} })] } })
    expect(await inboxItems(mention, 'at')).toMatchObject([{ at: 1_761_955_201_000, from: '', fromMid: 0 }])
    expect(mention.call).toHaveBeenCalledWith('atFeed', expect.anything())
  })

  it('keeps the owner\'s own delivered messages, oldest first, and says what a message that is not text holds', async () => {
    const message = (key: number, type: number, content: unknown, extra: Record<string, unknown> = {}) => ({
      sender_uid: 200000001, msg_key: key, timestamp: 1_761_955_200 + key, msg_type: type, content, ...extra,
    })
    const dm = caller({
      dmMessages: {
        messages: [
          message(5, 1, '{"content":"最新"}'),
          message(4, 2, '{}'),
          message(3, 7, '{"title":"分享视频","bvid":"BV1aa4y1X7aa"}'),
          message(2, 7, { title: '链接', jump_url: 'https://example.invalid/x' }),
          message(1, 9, '{}'),
          message(6, 1, 'not json'),
          message(7, 1, '{"content":"别人"}', { sender_uid: 5 }),
          message(8, 1, '{"content":"撤回"}', { msg_status: 1 }),
          message(9, 1, '{"content":"无序号"}', { msg_key: undefined }),
          message(10, 1, '{"content":"无时间"}', { timestamp: undefined }),
          message(11, 1, '{"content":"状态零"}', { msg_status: 0 }),
        ],
      },
    })
    const result = await ownerMessages(dm, 200000001)
    expect(result.map(row => row.text)).toEqual([
      '状态零', '[message]', '[message type 9]', '[shared] 链接 https://example.invalid/x', '[shared] 分享视频 BV1aa4y1X7aa', '[picture]', '最新',
    ])
  })
})

describe('account state', () => {
  it('reads follow counts, the relation attribute, likes, watch later, rewards, and given coins, with 0 for what is omitted', async () => {
    expect(await relationStat(caller({ relationStat: { following: 3, follower: 9 } }), 5)).toEqual({ following: 3, followers: 9 })
    expect(await relationStat(caller({ relationStat: {} }), 5)).toEqual({})
    expect(await relationTo(caller({ relation: { attribute: 6 } }), 5)).toBe(6)
    expect(await relationTo(caller({ relation: {} }), 5)).toBe(0)
    expect(await hasLiked(caller({ hasLike: 1 }), BV)).toBe(true)
    expect(await hasLiked(caller({ hasLike: 0 }), BV)).toBe(false)
    expect([...await watchLaterAids(caller({ watchLater: { list: [{ aid: 1 }, { aid: 'x' }, {}] } }))]).toEqual(['1'])
    const rewards = await dailyRewards(caller({ expReward: { login: true, coins: 30 } }))
    expect(rewards).toEqual({ login: true, watch: false, share: false, coinExp: 30 })
    expect(await dailyRewards(caller({ expReward: {} }))).toEqual({ login: false, watch: false, share: false, coinExp: 0 })
    expect(await coinsGiven(caller({ coinsGiven: { multiply: 2 } }), BV)).toBe(2)
    expect(await coinsGiven(caller({ coinsGiven: {} }), BV)).toBe(0)
  })

  it('lists favorite folders, marking the default one and, when a video is asked about, whether it is in each', async () => {
    const list = { list: [{ id: 1, title: '默认', attr: 0, media_count: 3, fav_state: 1 }, { id: 2, title: '慢慢看', attr: 2, fav_state: 0 }, { id: 3, title: '无属性' }, { title: '没有编号' }] }
    const plain = caller({ favFolders: list })
    expect(await folders(plain, 5)).toEqual([{ id: 1, title: '默认', count: 3, isDefault: true }, { id: 2, title: '慢慢看', count: 0, isDefault: false }, { id: 3, title: '无属性', count: 0, isDefault: true }])
    expect(plain.call).toHaveBeenCalledWith('favFolders', { query: { up_mid: 5 } })
    const asked = caller({ favFolders: list })
    expect(await folders(asked, 5, '101')).toMatchObject([{ id: 1, contains: true }, { id: 2, contains: false }, { id: 3, contains: false }])
    expect(asked.call).toHaveBeenCalledWith('favFolders', { query: { up_mid: 5, type: 2, rid: '101' } })
  })
})

describe('actions', () => {
  it('sends each action as one call with the form and Referer Bilibili\'s own pages send', async () => {
    const client = caller({})
    await reportWatch(client, { aid: '101', bvid: BV, cid: 9001, mid: 5, duration: 120 }, 30)
    await giveCoin(client, '101', BV, 2)
    await modifyRelation(client, 7, 1)
    await dealFavorite(client, '101', { add: [1, 2], remove: [3] }, BV)
    await dealFavorite(client, '101', { add: [], remove: [] })
    await likeVideo(client, '101', BV)
    await addWatchLater(client, '101')
    await removeWatchLater(client, '101')
    const sent = client.call.mock.calls.map(([name, options]) => [name, options?.referer ?? null])
    expect(sent).toEqual([
      ['watchReport', `https://www.bilibili.com/video/${BV}/`],
      ['coin', `https://www.bilibili.com/en/video/${BV}/`],
      ['relationModify', 'https://space.bilibili.com/7/'],
      ['favDeal', `https://www.bilibili.com/video/${BV}/`],
      ['favDeal', 'https://www.bilibili.com/'],
      ['like', `https://www.bilibili.com/en/video/${BV}/`],
      ['watchLaterAdd', null],
      ['watchLaterDel', null],
    ])
    expect(client.call.mock.calls[3]![1]!.form).toMatchObject({ add_media_ids: '1,2', del_media_ids: '3' })
  })

  it('reads what a triple applied, with 0 coins when Bilibili omits the count', async () => {
    expect(await tripleLike(caller({ triple: { like: true, coin: true, fav: true, multiply: 2 } }), '101', BV)).toEqual({ like: true, coin: true, favorite: true, coins: 2 })
    expect(await tripleLike(caller({ triple: {} }), '101', BV)).toEqual({ like: false, coin: false, favorite: false, coins: 0 })
  })
})
