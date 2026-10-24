/**
 * Typed Bilibili operations over the allowlisted client: each read returns
 * compact, bounded values (titles, names, and texts cut to fixed lengths), and
 * each write sends exactly one request and returns its receipt. Response
 * shapes follow the community reference SocialSisterYi/bilibili-API-collect
 * and field observations in dsh-bili-pod, dsh-bili-humanism, and
 * dsh-bili-scroll (MIT).
 */
import { BiliApiError, BiliTransportError, allowedEndpoint, type BiliClient } from './client.ts'
import { clean } from './text.ts'
import { dayKey, formatStamp } from './time.ts'

/** Field limits, in code points. */
export const LIMITS = { title: 120, name: 40, desc: 600, comment: 400, post: 400, reason: 80, subtitlePage: 4000 } as const

/** Comment area type of videos. */
export const VIDEO_AREA = 1

/** A loosely typed JSON object. */
type Json = Record<string, unknown>

/** `value` as an object, or an empty one. */
function obj(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : {}
}

/** `value` as an array of objects, or an empty array. */
function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(obj) : []
}

/** `value` if it is a string, else an empty string. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A finite number, or undefined. */
function num(value: unknown): number | undefined {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined
}

/** An id as a string: numbers, lossless big-integer strings, and `*_str` twins. */
function id(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}

/** `T` with every field that may be undefined made optional instead. */
type Compact<T> =
  & { [K in keyof T as undefined extends T[K] ? never : K]: T[K] }
  & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> }

/** Drop undefined fields so a value stays lossless JSON. */
function compact<T extends Record<string, unknown>>(value: T): Compact<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Compact<T>
}

/** `12:34` or `1:02:03` from seconds. */
export function clockText(seconds: number | undefined): string | undefined {
  if (seconds === undefined || seconds < 0) return undefined
  const whole = Math.floor(seconds)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = String(whole % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** A BV id, or undefined. */
export function bvidOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^BV[0-9A-Za-z]{10}$/.test(value) ? value : undefined
}

/** One video in a list. */
export interface VideoCard {
  bvid: string
  title: string
  author: string
  authorMid?: number
  duration?: string
  views?: number
  likes?: number
  /** Local day it was published. */
  published?: string
  desc?: string
  /** Why Bilibili recommends it, when it says. */
  reason?: string
  /** The account's own grade, when it graded this video before (`must`, `ok`, `skip`). */
  graded?: string
}

/** A card from a feed, search, or popular item. */
function card(item: Json, timeZone: string, extra: Partial<VideoCard> = {}): VideoCard | undefined {
  const bvid = bvidOf(item['bvid'])
  if (bvid === undefined) return undefined
  const owner = obj(item['owner'])
  const stat = obj(item['stat'])
  const published = num(item['pubdate'])
  return compact({
    bvid,
    title: clean(item['title'], LIMITS.title),
    author: clean(owner['name'] ?? item['author'], LIMITS.name),
    authorMid: num(owner['mid'] ?? item['mid']),
    duration: typeof item['duration'] === 'string' ? clean(item['duration'], 12) : clockText(num(item['duration'])),
    views: num(stat['view'] ?? item['play']),
    likes: num(stat['like']),
    published: published === undefined || published <= 0 ? undefined : dayKey(published * 1000, timeZone),
    ...extra,
  })
}

/** What `nav` says about the session. */
export interface NavInfo {
  isLogin: boolean
  mid?: number
  uname?: string
  level?: number
  /** Experience: the current total, the current level's floor, and the next level's threshold (null at LV6). */
  exp?: { current: number; min: number; next: number | null }
  /** Coin balance. */
  coins?: number
}

/**
 * The signed-in account, as Bilibili sees the stored cookies.
 * @param client - Bilibili client.
 */
export async function navInfo(client: BiliClient): Promise<NavInfo> {
  let data: Json
  try {
    data = obj((await client.call('nav')).data)
  } catch (error: unknown) {
    if (error instanceof BiliApiError && error.code === -101) return { isLogin: false }
    throw error
  }
  if (data['isLogin'] !== true) return { isLogin: false }
  const level = obj(data['level_info'])
  const current = num(level['current_exp'])
  const exp = current === undefined ? undefined : { current, min: num(level['current_min']) ?? 0, next: num(level['next_exp']) ?? null }
  return compact({
    isLogin: true, mid: num(data['mid']), uname: clean(data['uname'], LIMITS.name), level: num(level['current_level']), exp, coins: num(data['money']) ?? 0,
  })
}

/**
 * The personalized home feed, one batch.
 * @param client - Bilibili client.
 * @param index - batch number, from 1; each call asks for a fresh batch.
 * @param timeZone - zone for publish days.
 */
export async function homeFeed(client: BiliClient, index: number, timeZone: string): Promise<VideoCard[]> {
  const { data } = await client.call('homeFeed', {
    query: { fresh_type: 4, ps: 12, fresh_idx: index, fresh_idx_1h: index, brush: index, feed_version: 'V8', homepage_ver: 1, web_location: 1430650 },
  })
  return list(obj(data)['item'])
    .filter(item => item['goto'] === 'av')
    .map(item => card(item, timeZone, compact({ reason: clean(obj(item['rcmd_reason'])['content'], LIMITS.reason) || undefined })))
    .filter((item): item is VideoCard => item !== undefined)
}

/** One item of the following feed. */
export interface FeedPost {
  kind: 'video' | 'post' | 'forward' | 'other'
  /** Dynamic id. */
  id: string
  author: string
  authorMid?: number
  at?: string
  text?: string
  video?: VideoCard
  /** What a forward quotes. */
  quoted?: string
}

/** Text of a dynamic's body: its description or its opus summary. */
function postText(dynamic: Json): string {
  const major = obj(dynamic['major'])
  const text = obj(dynamic['desc'])['text'] ?? obj(obj(major['opus'])['summary'])['text']
  return clean(text, LIMITS.post, true)
}

/** A video card from a dynamic's archive. */
function archiveCard(dynamic: Json, author: Json, timeZone: string): VideoCard | undefined {
  const archive = obj(obj(dynamic['major'])['archive'])
  const stat = obj(archive['stat'])
  return card({ ...archive, owner: { name: author['name'], mid: author['mid'] }, duration: archive['duration_text'], stat: { view: stat['play'] } }, timeZone,
    compact({ desc: clean(archive['desc'], LIMITS.desc, true) || undefined }))
}

/** One normalized following-feed item. */
function feedPost(item: Json, timeZone: string): FeedPost | undefined {
  const dynamicId = id(item['id_str'])
  if (dynamicId === undefined) return undefined
  const modules = obj(item['modules'])
  const author = obj(modules['module_author'])
  const dynamic = obj(modules['module_dynamic'])
  const at = num(author['pub_ts'])
  const base = compact({ id: dynamicId, author: clean(author['name'], LIMITS.name), authorMid: num(author['mid']), at: at === undefined ? undefined : formatStamp(at * 1000, timeZone) })
  switch (item['type']) {
    case 'DYNAMIC_TYPE_AV': {
      const video = archiveCard(dynamic, author, timeZone)
      return video === undefined ? undefined : { kind: 'video', ...base, video }
    }
    case 'DYNAMIC_TYPE_WORD':
    case 'DYNAMIC_TYPE_DRAW':
    case 'DYNAMIC_TYPE_OPUS':
      return { kind: 'post', ...base, text: postText(dynamic) }
    case 'DYNAMIC_TYPE_FORWARD': {
      const orig = obj(item['orig'])
      const origModules = obj(orig['modules'])
      const origAuthor = clean(obj(origModules['module_author'])['name'], LIMITS.name)
      const origDynamic = obj(origModules['module_dynamic'])
      const origVideo = archiveCard(origDynamic, obj(origModules['module_author']), timeZone)
      const quoted = origVideo === undefined ? postText(origDynamic) : `${origVideo.title} (${origVideo.bvid})`
      return { kind: 'forward', ...base, text: postText(dynamic), quoted: clean(`${origAuthor}: ${quoted}`, LIMITS.post) }
    }
    default:
      return { kind: 'other', ...base, text: clean(item['type'], 40) }
  }
}

/**
 * What the accounts this account follows posted, newest first.
 * @param client - Bilibili client.
 * @param offset - `next` of the previous page.
 * @param timeZone - zone for times.
 */
export async function followingFeed(
  client: BiliClient, offset: string | undefined, timeZone: string,
): Promise<{ items: FeedPost[]; next?: string }> {
  const { data } = await client.call('followingFeed', {
    query: { type: 'all', platform: 'web', features: 'itemOpusStyle', timezone_offset: -480, ...(offset === undefined ? {} : { offset }) },
  })
  const page = obj(data)
  const items = list(page['items']).map(item => feedPost(item, timeZone)).filter((item): item is FeedPost => item !== undefined)
  const next = page['has_more'] === true && typeof page['offset'] === 'string' && page['offset'] !== '' ? page['offset'] : undefined
  return compact({ items, next })
}

/**
 * The site-wide popular list.
 * @param client - Bilibili client.
 * @param page - from 1.
 * @param timeZone - zone for publish days.
 */
export async function popular(client: BiliClient, page: number, timeZone: string): Promise<VideoCard[]> {
  const { data } = await client.call('popular', { query: { pn: page, ps: 20 } })
  return list(obj(data)['list'])
    .map(item => card(item, timeZone, compact({ reason: clean(obj(item['rcmd_reason'])['content'], LIMITS.reason) || undefined })))
    .filter((item): item is VideoCard => item !== undefined)
}

/**
 * The site leaderboard (排行榜) across all zones.
 * @param client - Bilibili client.
 * @param timeZone - zone for publish days.
 * @returns up to 30 bounded video cards, top first.
 */
export async function ranking(client: BiliClient, timeZone: string): Promise<VideoCard[]> {
  const { data } = await client.call('ranking', { query: { rid: 0, type: 'all' } })
  return list(obj(data)['list'])
    .slice(0, 30)
    .map(item => card(item, timeZone))
    .filter((item): item is VideoCard => item !== undefined)
}

/** One danmaku line: where it flies, in seconds, and what it says. */
export interface DanmakuLine {
  at: number
  text: string
}

/** XML entities a danmaku line may carry. */
const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' }

/**
 * A sample of a video part's danmaku, spread across its length.
 * @param client - Bilibili client.
 * @param cid - the part's cid.
 * @param limit - lines at most.
 * @returns lines in time order.
 */
export async function danmaku(client: BiliClient, cid: number, limit: number): Promise<DanmakuLine[]> {
  const { data } = await client.call('danmaku', { query: { oid: cid } })
  const xml = typeof data === 'string' ? data : ''
  const lines: DanmakuLine[] = []
  for (const match of xml.matchAll(/<d p="([\d.]+)[^"]*">([^<]*)<\/d>/g)) {
    const text = clean((match[2] ?? '').replace(/&(amp|lt|gt|quot|apos);/g, (_all, name: string) => XML_ENTITIES[name] ?? ''), 60)
    if (text !== '') lines.push({ at: Math.floor(Number(match[1])), text })
  }
  lines.sort((a, b) => a.at - b.at)
  if (lines.length <= limit) return lines
  const step = lines.length / limit
  return lines.filter((_line, index) => Math.floor(index / step) !== Math.floor((index - 1) / step))
}

/** Search order: Bilibili's default ranking, or newest first. */
export type SearchOrder = 'relevance' | 'newest'

/**
 * Search videos.
 * @param client - Bilibili client.
 * @param keyword - search words.
 * @param page - from 1.
 * @param timeZone - zone for publish days.
 * @param order - `relevance` (Bilibili's `totalrank`) or `newest` (`pubdate`).
 */
export async function search(client: BiliClient, keyword: string, page: number, timeZone: string, order: SearchOrder = 'relevance'): Promise<VideoCard[]> {
  const sort = order === 'newest' ? { order: 'pubdate' } : {}
  const { data } = await client.call('search', { query: { search_type: 'video', keyword, page, ...sort } })
  return list(obj(data)['result'])
    .filter(item => item['type'] === undefined || item['type'] === 'video')
    .map(item => card(item, timeZone, compact({ desc: clean(item['description'], 200, true) || undefined })))
    .filter((item): item is VideoCard => item !== undefined)
}

/** One entry of the hot-search list. */
export interface HotSearch {
  keyword: string
  /** What the search box shows, when it differs from the keyword. */
  label?: string
}

/**
 * The hot-search list (热搜): what the whole site searches for right now.
 * @param client - Bilibili client.
 * @param limit - entries, at most 50.
 */
export async function hotSearches(client: BiliClient, limit: number): Promise<HotSearch[]> {
  const { data } = await client.call('hotSearch', { query: { limit, platform: 'web' } })
  return list(obj(obj(data)['trending'])['list']).flatMap((item) => {
    const keyword = clean(item['keyword'], LIMITS.title)
    if (keyword === '') return []
    const label = clean(item['show_name'], LIMITS.title)
    return [label === '' || label === keyword ? { keyword } : { keyword, label }]
  })
}

/** One part of a multi-part video. */
export interface VideoPart {
  page: number
  cid: number
  title: string
  duration?: string
}

/** A video's facts. */
export interface VideoDetail extends VideoCard {
  aid: string
  cid: number
  category?: string
  favorites?: number
  coins?: number
  comments?: number
  danmaku?: number
  parts: VideoPart[]
  /** Length in seconds. */
  seconds?: number
  /** The uploader marked it original (`copyright` 1): it takes up to 2 coins from one account; anything else takes 1. */
  original: boolean
}

/**
 * A video's facts.
 * @param client - Bilibili client.
 * @param bvid - BV id.
 * @param timeZone - zone for the publish day.
 */
export async function videoInfo(client: BiliClient, bvid: string, timeZone: string): Promise<VideoDetail> {
  const { data } = await client.call('view', { query: { bvid } })
  const view = obj(data)
  const base = card(view, timeZone, compact({ desc: clean(view['desc'], LIMITS.desc, true) || undefined }))
  const aid = id(view['aid'])
  const cid = num(view['cid'])
  if (base === undefined || aid === undefined || cid === undefined) throw new BiliTransportError('view', 'answer lacks the video ids')
  const stat = obj(view['stat'])
  return compact({
    ...base,
    aid,
    cid,
    seconds: num(view['duration']),
    original: num(view['copyright']) === 1,
    category: clean(view['tname'], 30) || undefined,
    favorites: num(stat['favorite']),
    coins: num(stat['coin']),
    comments: num(stat['reply']),
    danmaku: num(stat['danmaku']),
    parts: list(view['pages']).slice(0, 50).map(part => compact({
      page: num(part['page']) ?? 1, cid: num(part['cid']) ?? 0, title: clean(part['part'], LIMITS.title), duration: clockText(num(part['duration'])),
    })),
  })
}

/** A subtitle page, or why there is none. */
export type SubtitleView =
  | { available: true; language: string; machine: boolean; page: number; pages: number; text: string; coverage: string }
  | { available: false; coverage: string }

/** Coverage notes the model reads with a subtitle answer. */
export const COVERAGE = {
  none: 'No subtitle track is available for this video, so its spoken content is unknown: only the title, description, and comments are known. Do not claim to have watched or heard it.',
  machine: 'Machine (AI) transcription of the speech: it may mishear names and words, and it says nothing about visuals or music.',
  human: 'Uploaded subtitles of the speech: they say nothing about visuals or music.',
} as const

/**
 * The subtitle text of one video part, paginated, and how far into the video the read page reaches.
 * @param client - Bilibili client.
 * @param bvid - BV id.
 * @param cid - part id.
 * @param page - subtitle page, from 1.
 */
export async function subtitles(
  client: BiliClient, bvid: string, cid: number, page: number,
): Promise<{ view: SubtitleView; reached?: number }> {
  const { data } = await client.call('player', { query: { bvid, cid } })
  const tracks = list(obj(obj(data)['subtitle'])['subtitles'])
  const rank = (track: Json): number => {
    const lan = text(track['lan'])
    if (lan.startsWith('zh')) return 0
    if (lan.startsWith('ai-zh')) return 1
    if (lan.startsWith('ai-')) return 3
    return 2
  }
  const track = [...tracks].sort((a, b) => rank(a) - rank(b))[0]
  const raw = typeof track?.['subtitle_url'] === 'string' ? track['subtitle_url'] : ''
  const url = URL.parse(raw.startsWith('//') ? `https:${raw}` : raw)
  const endpoint = url === null ? undefined : allowedEndpoint('GET', url.href)
  const none = { view: { available: false as const, coverage: COVERAGE.none } }
  if (track === undefined || url === null || (endpoint !== 'subtitleAi' && endpoint !== 'subtitleFile')) return none
  const file = await client.call(endpoint, { path: url.pathname, query: Object.fromEntries(url.searchParams) })
  const lines = list(obj(file.data)['body']).map(line => ({
    text: `[${clockText(num(line['from'])) ?? '?'}] ${clean(line['content'], 300)}`,
    to: num(line['to']) ?? num(line['from']) ?? 0,
  }))
  // Each page keeps where its speech ends, so a read page tells how far the video was followed.
  const pages: { text: string; to: number }[] = []
  let current = { text: '', to: 0 }
  for (const line of lines) {
    if (current.text !== '' && current.text.length + line.text.length + 1 > LIMITS.subtitlePage) {
      pages.push(current)
      current = { text: '', to: 0 }
    }
    current = { text: current.text === '' ? line.text : `${current.text}\n${line.text}`, to: Math.max(current.to, line.to) }
  }
  if (current.text !== '') pages.push(current)
  if (pages.length === 0) return none
  const index = Math.min(Math.max(1, page), pages.length)
  const machine = text(track['lan']).startsWith('ai-') || (num(track['ai_type']) ?? 0) > 0
  const read = pages[index - 1]
  return {
    view: {
      available: true,
      language: clean(track['lan_doc'] ?? track['lan'], 30),
      machine,
      page: index,
      pages: pages.length,
      text: read?.text ?? '',
      coverage: machine ? COVERAGE.machine : COVERAGE.human,
    },
    ...(read === undefined ? {} : { reached: Math.ceil(read.to) }),
  }
}

/** One comment. */
export interface CommentView {
  rpid: string
  author: string
  authorMid?: number
  text: string
  likes?: number
  replies?: number
  at?: string
  /** First replies under it, when the list carries them. */
  preview?: CommentView[]
}

/** One normalized comment. */
function comment(item: Json, timeZone: string, depth = 0): CommentView | undefined {
  const rpid = id(item['rpid_str']) ?? id(item['rpid'])
  if (rpid === undefined) return undefined
  const member = obj(item['member'])
  const ctime = num(item['ctime'])
  const preview = depth === 0 ? list(item['replies']).slice(0, 2).map(reply => comment(reply, timeZone, 1)).filter((reply): reply is CommentView => reply !== undefined) : []
  return compact({
    rpid,
    author: clean(member['uname'], LIMITS.name),
    authorMid: num(member['mid']),
    text: clean(obj(item['content'])['message'], LIMITS.comment, true),
    likes: num(item['like']),
    replies: num(item['rcount']),
    at: ctime === undefined ? undefined : formatStamp(ctime * 1000, timeZone),
    preview: preview.length > 0 ? preview : undefined,
  })
}

/** A comment area and the root comment of one thread in it. */
export interface ThreadArea {
  type: number
  oid: string
  root: string
}

/** Raw comment rows, for visibility checks that need `invisible` and `state`. */
export interface CommentRows {
  rows: Json[]
  next?: string
}

/**
 * One page of a comment area's top-level comments.
 * @param client - Bilibili client.
 * @param area - area type and `oid`.
 * @param options - `hot` or `new` order, the `next` offset of the previous page, and anonymity.
 */
export async function commentRows(client: BiliClient, area: { type: number; oid: string }, options: { order: 'hot' | 'new'; offset?: string; anonymous?: boolean }): Promise<CommentRows> {
  const { data } = await client.call('replies', {
    query: { oid: area.oid, type: area.type, mode: options.order === 'hot' ? 3 : 2, pagination_str: JSON.stringify({ offset: options.offset ?? '' }), plat: 1, web_location: 1315875 },
    anonymous: options.anonymous === true,
  })
  const page = obj(data)
  const cursor = obj(page['cursor'])
  const next = obj(cursor['pagination_reply'])['next_offset']
  return compact({ rows: list(page['replies']), next: cursor['is_end'] !== true && typeof next === 'string' && next !== '' ? next : undefined })
}

/**
 * One page of top-level comments, normalized.
 * @param client - Bilibili client.
 * @param aid - video aid.
 * @param options - order and offset.
 * @param timeZone - zone for times.
 */
export async function comments(client: BiliClient, aid: string, options: { order: 'hot' | 'new'; offset?: string }, timeZone: string): Promise<{ comments: CommentView[]; next?: string }> {
  const page = await commentRows(client, { type: VIDEO_AREA, oid: aid }, options)
  const rows = page.rows.map(row => comment(row, timeZone)).filter((row): row is CommentView => row !== undefined)
  return compact({ comments: rows, next: page.next })
}

/**
 * Raw rows of one thread (a root comment and its replies).
 * @param client - Bilibili client.
 * @param area - area type, `oid`, and root comment.
 * @param page - from 1.
 * @param anonymous - read as a signed-out visitor.
 */
export async function threadRows(
  client: BiliClient, area: ThreadArea, page: number, anonymous = false,
): Promise<{ root?: Json; rows: Json[]; count?: number }> {
  const { data } = await client.call('replyThread', { query: { oid: area.oid, type: area.type, root: area.root, ps: 20, pn: page }, anonymous })
  const thread = obj(data)
  return compact({ root: thread['root'] === undefined ? undefined : obj(thread['root']), rows: list(thread['replies']), count: num(obj(thread['page'])['count']) })
}

/**
 * One page of a thread, normalized.
 * @param client - Bilibili client.
 * @param area - area type, `oid`, and root comment.
 * @param page - from 1.
 * @param timeZone - zone for times.
 */
export async function thread(
  client: BiliClient, area: ThreadArea, page: number, timeZone: string,
): Promise<{ root?: CommentView; replies: CommentView[]; count?: number }> {
  const rows = await threadRows(client, area, page)
  return compact({
    root: rows.root === undefined ? undefined : comment(rows.root, timeZone, 1),
    replies: rows.rows.map(row => comment(row, timeZone, 1)).filter((row): row is CommentView => row !== undefined),
    count: rows.count,
  })
}

/** Unread counts. */
export interface UnreadCounts {
  replies: number
  mentions: number
  /** Unread messages from followed and other accounts. */
  messages: number
}

/**
 * Unread replies, mentions, and messages.
 * @param client - Bilibili client.
 */
export async function unreadCounts(client: BiliClient): Promise<UnreadCounts> {
  const feed = obj((await client.call('unread', { query: { build: 0, mobi_app: 'web' } })).data)
  const dm = obj((await client.call('dmUnread', { query: { unread_type: 0, build: 0, mobi_app: 'web' } })).data)
  return {
    replies: num(feed['reply']) ?? 0,
    mentions: num(feed['at']) ?? 0,
    messages: (num(dm['follow_unread']) ?? 0) + (num(dm['unfollow_unread']) ?? 0),
  }
}

/** One reply to or mention of the account. */
export interface InboxItem {
  /** Notification id within its feed. */
  id: string
  at: number
  from: string
  fromMid: number
  /** What they wrote. */
  text: string
  /** What it was under (a video or dynamic title). */
  about: string
  /** Comment area and ids to answer it. */
  type: number
  oid: string
  rpid: string
  root: string
}

/**
 * The newest replies to the account's comments, or mentions of it.
 * @param client - Bilibili client.
 * @param kind - `reply` or `at`.
 */
export async function inboxItems(client: BiliClient, kind: 'reply' | 'at'): Promise<InboxItem[]> {
  const { data } = await client.call(kind === 'reply' ? 'replyFeed' : 'atFeed', { query: { platform: 'web', build: 0, mobi_app: 'web' } })
  const items: InboxItem[] = []
  for (const entry of list(obj(data)['items'])) {
    const item = obj(entry['item'])
    const user = obj(entry['user'])
    const itemId = id(entry['id'])
    const rpid = id(item['source_id'])
    const oid = id(item['subject_id'])
    const type = num(item['business_id'])
    const at = num(entry['reply_time'] ?? entry['at_time'])
    if (itemId === undefined || rpid === undefined || oid === undefined || type === undefined || type <= 0 || at === undefined) continue
    // root_id 0 means their comment is itself a top-level comment.
    const root = id(item['root_id']) ?? rpid
    items.push({
      id: itemId,
      at: at * 1000,
      from: clean(user['nickname'], LIMITS.name),
      fromMid: num(user['mid']) ?? 0,
      text: clean(item['source_content'], LIMITS.comment, true),
      about: clean(item['title'], LIMITS.title),
      type,
      oid,
      rpid,
      root,
    })
  }
  return items
}

/** One message from the owner's account. */
export interface OwnerMessage {
  id: string
  at: number
  text: string
}

/** The text of a DM `content` field. */
function messageText(type: unknown, content: unknown): string {
  let parsed: Json = {}
  try {
    parsed = obj(typeof content === 'string' ? JSON.parse(content) : content)
  } catch {
    return '[message]'
  }
  if (type === 1) return clean(parsed['content'], 1000, true)
  if (type === 2) return '[picture]'
  if (type === 7) return clean(`[shared] ${text(parsed['title'])} ${text(parsed['bvid']) || text(parsed['jump_url'])}`, 300)
  return `[message type ${String(type)}]`
}

/**
 * The newest messages the owner's account sent this account.
 * @param client - Bilibili client.
 * @param ownerMid - the owner's main account.
 */
export async function ownerMessages(client: BiliClient, ownerMid: number): Promise<OwnerMessage[]> {
  const { data } = await client.call('dmMessages', { query: { talker_id: ownerMid, session_type: 1, size: 20, build: 0, mobi_app: 'web' } })
  const messages: OwnerMessage[] = []
  for (const message of list(obj(data)['messages'])) {
    if (num(message['sender_uid']) !== ownerMid) continue
    const key = id(message['msg_key']) ?? id(message['msg_seqno'])
    const at = num(message['timestamp'])
    if (key === undefined || at === undefined || num(message['msg_status']) !== undefined && num(message['msg_status']) !== 0) continue
    messages.push({ id: key, at: at * 1000, text: messageText(message['msg_type'], message['content']) })
  }
  return messages.reverse()
}

/**
 * Follow and fan counts of an account.
 * @param client - Bilibili client.
 * @param mid - the account.
 */
export async function relationStat(client: BiliClient, mid: number): Promise<{ following?: number; followers?: number }> {
  const data = obj((await client.call('relationStat', { query: { vmid: mid } })).data)
  return compact({ following: num(data['following']), followers: num(data['follower']) })
}

/** `attribute` of the account's relation to another: 0 none, 2 following, 6 mutual, 128 blocked. */
export async function relationTo(client: BiliClient, fid: number): Promise<number> {
  return num(obj((await client.call('relation', { query: { fid } })).data)['attribute']) ?? 0
}

/** One favorite folder. */
export interface Folder {
  id: number
  title: string
  count: number
  isDefault: boolean
  /** Whether it holds the video asked about. */
  contains?: boolean
}

/**
 * The account's favorite folders.
 * @param client - Bilibili client.
 * @param mid - the account.
 * @param aid - a video whose membership to report.
 */
export async function folders(client: BiliClient, mid: number, aid?: string): Promise<Folder[]> {
  const { data } = await client.call('favFolders', { query: { up_mid: mid, ...(aid === undefined ? {} : { type: 2, rid: aid }) } })
  return list(obj(data)['list']).flatMap((folder) => {
    const folderId = num(folder['id'])
    if (folderId === undefined) return []
    const attr = num(folder['attr']) ?? 0
    return [compact({
      id: folderId,
      title: clean(folder['title'], 60),
      count: num(folder['media_count']) ?? 0,
      // Bit 1 clear marks the default folder.
      isDefault: (attr & 2) === 0,
      contains: aid === undefined ? undefined : num(folder['fav_state']) === 1,
    })]
  })
}

/**
 * Whether the account liked a video.
 * @param client - Bilibili client.
 * @param bvid - BV id.
 */
export async function hasLiked(client: BiliClient, bvid: string): Promise<boolean> {
  return num((await client.call('hasLike', { query: { bvid } })).data) === 1
}

/**
 * Aids on the watch-later list.
 * @param client - Bilibili client.
 */
export async function watchLaterAids(client: BiliClient): Promise<Set<string>> {
  const data = obj((await client.call('watchLater')).data)
  return new Set(list(data['list']).map(item => id(item['aid'])).filter((aid): aid is string => aid !== undefined))
}

/** Today's daily rewards: each worth 5 EXP, plus up to 50 EXP from coins. */
export interface DailyRewards {
  login: boolean
  watch: boolean
  share: boolean
  /** EXP from coins today (the server updates it with a delay). */
  coinExp: number
}

/**
 * Today's daily reward status.
 * @param client - Bilibili client.
 */
export async function dailyRewards(client: BiliClient): Promise<DailyRewards> {
  const data = obj((await client.call('expReward')).data)
  return { login: data['login'] === true, watch: data['watch'] === true, share: data['share'] === true, coinExp: num(data['coins']) ?? 0 }
}

/**
 * Coins the account already gave a video.
 * @param client - Bilibili client.
 * @param bvid - BV id.
 */
export async function coinsGiven(client: BiliClient, bvid: string): Promise<number> {
  return num(obj((await client.call('coinsGiven', { query: { bvid } })).data)['multiply']) ?? 0
}

/**
 * Report that the account watched a video as far as `seconds` (the web player's heartbeat).
 * @param client - Bilibili client.
 * @param video - aid, BV id, part, the account's mid, and the video length.
 * @param seconds - how far it watched.
 */
export async function reportWatch(
  client: BiliClient, video: { aid: string; bvid: string; cid: number; mid: number; duration: number }, seconds: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await client.call('watchReport', {
    form: {
      aid: video.aid, bvid: video.bvid, cid: video.cid, mid: video.mid, played_time: seconds, realtime: seconds, real_played_time: seconds,
      video_duration: video.duration, start_ts: now - seconds, dt: 2,
    },
    referer: videoPage(video.bvid),
  })
}

/**
 * Report that the account shared a video.
 * @param client - Bilibili client.
 * @param bvid - BV id.
 */
export async function reportShare(client: BiliClient, bvid: string): Promise<void> {
  await client.call('shareReport', { form: { bvid, source: 'web_normal' }, referer: videoPage(bvid) })
}

/**
 * Give a video coins, without a like.
 * @param client - Bilibili client.
 * @param aid - video aid.
 * @param bvid - BV id.
 * @param count - 1, or 2 for an original video.
 */
export async function giveCoin(client: BiliClient, aid: string, bvid: string, count: 1 | 2): Promise<void> {
  await client.call('coin', { form: { aid, multiply: count, select_like: 0 }, referer: videoPage(bvid) })
}

/** What a triple (一键三连) applied, as Bilibili answers it. */
export interface TripleResult {
  like: boolean
  coin: boolean
  favorite: boolean
  /** Coins it gave when `coin` is true. */
  coins: number
}

/**
 * Like, coin, and favorite a video in one request (一键三连): the favorite goes
 * to the default folder, the coins are 2 for an original and 1 otherwise.
 * @param client - Bilibili client.
 * @param aid - video aid.
 * @param bvid - BV id.
 */
export async function tripleLike(client: BiliClient, aid: string, bvid: string): Promise<TripleResult> {
  const data = obj((await client.call('triple', { form: { aid }, referer: videoPage(bvid) })).data)
  return { like: data['like'] === true, coin: data['coin'] === true, favorite: data['fav'] === true, coins: num(data['multiply']) ?? 0 }
}

/** `Referer` of a video page. */
function videoPage(bvid: string | undefined): string {
  return bvid === undefined ? 'https://www.bilibili.com/' : `https://www.bilibili.com/video/${bvid}/`
}

/** Follow (`1`) or unfollow (`2`) an account. */
export async function modifyRelation(client: BiliClient, fid: number, act: 1 | 2): Promise<void> {
  await client.call('relationModify', { form: { fid, act, re_src: 11 }, referer: `https://space.bilibili.com/${fid}/` })
}

/** Add a video to, or remove it from, favorite folders. */
export async function dealFavorite(
  client: BiliClient, aid: string, change: { add: number[]; remove: number[] }, bvid?: string,
): Promise<void> {
  await client.call('favDeal', {
    form: { rid: aid, type: 2, add_media_ids: change.add.join(','), del_media_ids: change.remove.join(','), platform: 'web' },
    referer: videoPage(bvid),
  })
}

/** Like a video. */
export async function likeVideo(client: BiliClient, aid: string, bvid: string): Promise<void> {
  await client.call('like', { form: { aid, like: 1 }, referer: videoPage(bvid) })
}

/** Add a video to watch later. */
export async function addWatchLater(client: BiliClient, aid: string): Promise<void> {
  await client.call('watchLaterAdd', { form: { aid } })
}

/** Remove a video from watch later. */
export async function removeWatchLater(client: BiliClient, aid: string): Promise<void> {
  await client.call('watchLaterDel', { form: { aid } })
}

/**
 * Post a comment, or a reply when `root` is given.
 * @returns the new comment's id.
 * @throws {BiliTransportError} when Bilibili accepted it without an exact id, which leaves the outcome uncertain.
 */
export async function addReply(
  client: BiliClient, area: { type: number; oid: string; root?: string; parent?: string }, message: string, bvid?: string,
): Promise<string> {
  const thread = area.root === undefined ? {} : { root: area.root, parent: area.parent ?? area.root }
  const { data } = await client.call('replyAdd', {
    form: { type: area.type, oid: area.oid, message, plat: 1, ...thread },
    referer: videoPage(bvid),
  })
  const rpid = id(obj(data)['rpid_str']) ?? id(obj(data)['rpid'])
  if (rpid === undefined) throw new BiliTransportError('replyAdd', 'accepted without an exact comment id')
  return rpid
}

/**
 * Post a text-only dynamic.
 * @returns the dynamic id.
 */
export async function createDynamic(client: BiliClient, text: string): Promise<string> {
  const { data } = await client.call('dynamicCreate', {
    json: { dyn_req: { content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] }, scene: 1, meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } } } },
  })
  const dynamicId = id(obj(data)['dyn_id_str']) ?? id(obj(data)['dyn_id'])
  if (dynamicId === undefined) throw new BiliTransportError('dynamicCreate', 'accepted without a dynamic id')
  return dynamicId
}

/**
 * Send one text message.
 * @returns the message key, when Bilibili answers one.
 */
export async function sendMessage(
  client: BiliClient, message: { sender: number; receiver: number; text: string; deviceId: string },
): Promise<string | undefined> {
  const { sender, receiver, deviceId } = message
  const { data } = await client.call('dmSend', {
    query: { w_sender_uid: sender, w_receiver_id: receiver, w_dev_id: deviceId },
    form: {
      'msg[sender_uid]': sender,
      'msg[receiver_id]': receiver,
      'msg[receiver_type]': 1,
      'msg[msg_type]': 1,
      'msg[msg_status]': 0,
      'msg[content]': JSON.stringify({ content: message.text }),
      'msg[dev_id]': deviceId,
      'msg[timestamp]': Math.floor(Date.now() / 1000),
      'msg[new_face_version]': 0,
      build: 0,
      mobi_app: 'web',
    },
  })
  return id(obj(data)['msg_key'])
}
