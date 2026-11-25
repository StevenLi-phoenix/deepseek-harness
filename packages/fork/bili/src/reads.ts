/**
 * The account's reads through bili-svc's door: feeds, search, the leaderboard, hot searches, a
 * video with its subtitles and comments, danmaku, the inbox, and the account card. Feeds leave out
 * the owner's own uploads and posts, a read that shows hot comments or hot-search words feeds
 * `ctx.biliHot`, and a video whose subtitles were read is reported as watched.
 */
import {
  bvidOf, comments, dailyRewards, danmaku, folders, followingFeed, homeFeed, hotSearches, inboxItems, navInfo, ownerMessages,
  popular, ranking, relationStat, search, subtitles, thread, unreadCounts, videoInfo, VIDEO_AREA,
  type CommentView, type DailyRewards, type DanmakuLine, type FeedPost, type Folder, type HotSearch, type InboxItem,
  type OwnerMessage, type SearchOrder, type SubtitleView, type VideoCard, type VideoDetail,
} from './api.ts'
import { BiliApiError, BiliSessionError, type BiliCaller } from './client.ts'
import type { HotStore } from './hot.ts'
import type { AccountRead } from './status.ts'

/** Hot-search keywords read at once. */
const HOT_SEARCHES = 30
/** Danmaku lines one read returns. */
const DANMAKU_LINES = 40

/** The account card the `bili_me` tool shows. */
export interface MeView {
  signedIn: boolean
  mid?: number
  uname?: string
  level?: number
  following?: number
  followers?: number
  folders?: Folder[]
  /** EXP: the current total, the level's floor, and the next level's threshold (null at LV6). */
  exp?: { current: number; min: number; next: number | null }
  /** Coin balance. */
  coins?: number
  /** Today's daily rewards (5 EXP each for login, watch, share; up to 50 EXP from coins). */
  rewards?: DailyRewards
  /** Who keeps the limits: bili-svc, which caps, spaces, and ledgers every action. */
  limits: string
  /** Present while bili-svc holds every action (read-only mode or its brake). */
  pause?: string
}

/** The inbox the `bili_inbox` tool shows. */
export interface InboxView {
  unread: { replies: number; mentions: number; messages: number }
  replies: Omit<InboxItem, 'type' | 'oid' | 'root'>[]
  mentions: Omit<InboxItem, 'type' | 'oid' | 'root'>[]
  ownerMessages: OwnerMessage[]
}

/** What the reads need of the account. */
export interface BiliReadsHost {
  readonly client: BiliCaller
  /** IANA time zone of the read cards' times. */
  readonly timeZone: string
  /** The owner's main account, or undefined while unset. */
  ownerMid(): number | undefined
  /** Keep background work alive until the account's teardown drains it; its failure is logged. */
  track(work: Promise<void>): void
  /** The store of hot comments and hot-search words (`ctx.biliHot`). */
  readonly hot: Pick<HotStore, 'noteComments' | 'noteWords'>
  /** Report a watch of a video whose subtitles were read up to second `reached`. */
  reportWatch(video: VideoDetail, cid: number, reached: number): Promise<void>
  /** Record the owner's messages a read showed as handed over. */
  markSeen(items: readonly OwnerMessage[]): Promise<void>
  /**
   * The agent's account as bili-svc lists it.
   * @returns the account card and bili-svc's gate.
   */
  accountView(): Promise<Pick<AccountRead, 'view' | 'gate'>>
}

/** The account's reads, each with a model-readable error when the session or the service is not usable. */
export class BiliReads {
  /** The home-feed batch last read; each read asks for the next one. */
  private feedIndex = 0

  /** @param host - the client, the time zone, the owner account, `ctx.biliHot`, and the watch report and inbox hand-over. */
  constructor(private readonly host: BiliReadsHost) {}

  /**
   * The next batch of the home feed.
   * @returns bounded video cards.
   */
  async homeFeed(): Promise<VideoCard[]> {
    this.feedIndex += 1
    return this.notOwners(await this.reading(() => homeFeed(this.host.client, this.feedIndex, this.host.timeZone)))
  }

  /**
   * The site leaderboard across all zones.
   * @returns bounded video cards, top first.
   */
  async ranking(): Promise<VideoCard[]> {
    return this.notOwners(await this.reading(() => ranking(this.host.client, this.host.timeZone)))
  }

  /**
   * A sample of a video's danmaku.
   * @param bvid - BV id.
   * @param part - part number of a multi-part video.
   * @returns up to {@link DANMAKU_LINES} lines, each with its second.
   */
  async danmaku(bvid: string, part: number | undefined): Promise<{ bvid: string; lines: DanmakuLine[] }> {
    if (bvidOf(bvid) === undefined) throw new Error(`${JSON.stringify(bvid)} is not a BV id`)
    return this.reading(async () => {
      const video = await videoInfo(this.host.client, bvid, this.host.timeZone)
      const cid = video.parts.find(page => page.page === part)?.cid ?? video.cid
      return { bvid: video.bvid, lines: await danmaku(this.host.client, cid, DANMAKU_LINES) }
    })
  }

  /**
   * What followed accounts posted, without the owner's own posts.
   * @param offset - `next` of the previous page.
   * @returns bounded posts and the `next` offset when there are more.
   */
  async followingFeed(offset: string | undefined): Promise<{ items: FeedPost[]; next?: string }> {
    const page = await this.reading(() => followingFeed(this.host.client, offset, this.host.timeZone))
    return { ...page, items: this.notOwners(page.items) }
  }

  /**
   * Popular videos.
   * @param page - from 1.
   * @returns bounded video cards.
   */
  async popular(page: number): Promise<VideoCard[]> {
    return this.notOwners(await this.reading(() => popular(this.host.client, Math.max(1, Math.floor(page)), this.host.timeZone)))
  }

  /**
   * Search videos.
   * @param keyword - search words; at most 100 characters are used.
   * @param page - from 1.
   * @param order - `relevance` or `newest` first.
   * @returns bounded video cards.
   */
  async search(keyword: string, page: number, order: SearchOrder): Promise<VideoCard[]> {
    const words = keyword.trim().slice(0, 100)
    if (words === '') throw new Error('the keyword is empty')
    const pageNumber = Math.max(1, Math.floor(page))
    return this.notOwners(await this.reading(() => search(this.host.client, words, pageNumber, this.host.timeZone, order)))
  }

  /**
   * The hot-search list; its words go to `ctx.biliHot`.
   * @returns up to {@link HOT_SEARCHES} keywords.
   */
  async hotSearches(): Promise<HotSearch[]> {
    return this.reading(async () => {
      const list = await hotSearches(this.host.client, HOT_SEARCHES)
      this.host.track(this.host.hot.noteWords(list))
      return list
    })
  }

  /**
   * A video: facts, one page of subtitles, and top comments; a subtitle read is reported as a watch.
   * @param bvid - BV id.
   * @param options - subtitle page and part.
   * @returns the facts, one subtitle page or the reason there is none, and up to five top comments.
   */
  async video(
    bvid: string, options: { subtitlePage?: number; part?: number },
  ): Promise<{ video: VideoDetail; subtitle: SubtitleView; topComments: CommentView[] }> {
    if (bvidOf(bvid) === undefined) throw new Error(`${JSON.stringify(bvid)} is not a BV id`)
    return this.reading(async () => {
      const video = await videoInfo(this.host.client, bvid, this.host.timeZone)
      const cid = video.parts.find(part => part.page === options.part)?.cid ?? video.cid
      const subtitle = await subtitles(this.host.client, bvid, cid, options.subtitlePage ?? 1)
      const top = await comments(this.host.client, video.aid, { order: 'hot' }, this.host.timeZone)
      if (subtitle.reached !== undefined) this.host.track(this.host.reportWatch(video, cid, subtitle.reached))
      this.host.track(this.host.hot.noteComments(video.bvid, top.comments))
      return { video, subtitle: subtitle.view, topComments: top.comments.slice(0, 5) }
    })
  }

  /**
   * Comments of a video, or one thread when `root` is given.
   * @param bvid - BV id.
   * @param options - order, `next` offset, root comment id, and thread page.
   * @returns bounded comments and the `next` offset, or a thread with its root.
   */
  async comments(bvid: string, options: { order?: 'hot' | 'new'; offset?: string; root?: string; page?: number }): Promise<{ comments: CommentView[]; next?: string; root?: CommentView }> {
    if (bvidOf(bvid) === undefined) throw new Error(`${JSON.stringify(bvid)} is not a BV id`)
    return this.reading(async () => {
      const video = await videoInfo(this.host.client, bvid, this.host.timeZone)
      if (options.root !== undefined) {
        if (!/^\d+$/.test(options.root)) throw new Error('root must be a comment id')
        const page = Math.max(1, Math.floor(options.page ?? 1))
        const result = await thread(this.host.client, { type: VIDEO_AREA, oid: video.aid, root: options.root }, page, this.host.timeZone)
        return { comments: result.replies, ...(result.root === undefined ? {} : { root: result.root }) }
      }
      const page = await comments(this.host.client, video.aid, { order: options.order ?? 'hot', ...(options.offset === undefined ? {} : { offset: options.offset }) }, this.host.timeZone)
      this.host.track(this.host.hot.noteComments(video.bvid, page.comments))
      return page
    })
  }

  /**
   * Unread counts, the newest replies and mentions, and the owner's latest messages, which count as handed over.
   * @returns unread counts, up to ten replies and mentions, and the owner's latest messages.
   */
  async inbox(): Promise<InboxView> {
    return this.reading(async () => {
      const unread = await unreadCounts(this.host.client)
      const replies = await inboxItems(this.host.client, 'reply')
      const mentions = await inboxItems(this.host.client, 'at')
      const ownerMid = this.host.ownerMid()
      const owner = ownerMid === undefined ? [] : await ownerMessages(this.host.client, ownerMid)
      await this.host.markSeen(owner)
      const strip = ({ type: _type, oid: _oid, root: _root, ...rest }: InboxItem): Omit<InboxItem, 'type' | 'oid' | 'root'> => rest
      return {
        unread, replies: replies.slice(0, 10).map(strip), mentions: mentions.slice(0, 10).map(strip), ownerMessages: owner.slice(-10),
      }
    })
  }

  /**
   * The account, its folders, its level and coins, and whether bili-svc holds actions.
   * @returns the account facts, or `signedIn: false`.
   */
  async me(): Promise<MeView> {
    const { view, gate } = await this.host.accountView()
    const base: Pick<MeView, 'limits' | 'pause'> = {
      limits: 'bili-svc enforces daily caps, spacing, and once-rules on every action; it answers refused when one is used up',
      ...(gate?.readonly === true ? { pause: `bili-svc holds every action (gate mode ${gate.mode === '' ? 'unknown' : gate.mode}) until the owner lets them through again` } : {}),
    }
    if (view.session !== 'ok') return { signedIn: false, ...view.uname === undefined ? {} : { uname: view.uname }, ...base }
    return this.reading(async () => {
      const nav = await navInfo(this.host.client)
      if (!nav.isLogin) return { signedIn: false, ...base }
      const mid = nav.mid ?? view.mid ?? 0
      const stat = await relationStat(this.host.client, mid)
      const list = await folders(this.host.client, mid)
      const rewards = await dailyRewards(this.host.client)
      /* v8 ignore next 5 -- a signed-in nav answer always has uname, exp, and coins. */
      return {
        signedIn: true, mid,
        ...(nav.uname ?? view.uname) === undefined ? {} : { uname: nav.uname ?? view.uname },
        ...(nav.level === undefined ? {} : { level: nav.level }),
        ...(nav.exp === undefined ? {} : { exp: nav.exp }), ...(nav.coins === undefined ? {} : { coins: nav.coins }), rewards,
        ...stat, folders: list, ...base,
      }
    })
  }

  /** A read through bili-svc, with a model-readable error when the session or the service is not usable. */
  private async reading<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error: unknown) {
      if (error instanceof BiliSessionError) throw new Error(error.message)
      if (error instanceof BiliApiError && error.code === -101) throw new Error('Bilibili says the account is signed out; bili-svc owns the login, and the owner renews it there')
      throw error
    }
  }

  /** Feed entries without the owner's own uploads and posts: the owner has seen them. */
  private notOwners<T extends { authorMid?: number | undefined }>(items: T[]): T[] {
    const owner = this.host.ownerMid()
    return owner === undefined ? items : items.filter(item => item.authorMid !== owner)
  }
}
