/**
 * The account's actions through bili-svc's door: coin, triple, follow, unfollow, favorite, like,
 * watch later, and the watch report. Each action reads first whether it is already done, then makes
 * one call whose outcome bili-svc decides (caps, once-rules, brake, ledger), and is never retried.
 */
import {
  addWatchLater, bvidOf, coinsGiven, dealFavorite, folders, giveCoin, hasLiked, likeVideo, modifyRelation, navInfo,
  relationTo, removeWatchLater, reportWatch, tripleLike, videoInfo, watchLaterAids,
  type Folder, type VideoDetail,
} from './api.ts'
import {
  BiliApiError, BiliOutcomeError, BiliRefused, BiliRiskError, BiliTransportError, BiliVerifyError, errorText, type BiliCaller,
} from './client.ts'

/** What a write tool learns. */
export type WriteOutcome =
  | { readonly outcome: 'sent'; readonly detail: string; readonly receipt?: string }
  | { readonly outcome: 'already'; readonly detail: string }
  /** `verification` carries Bilibili's words when it refused for want of a verified phone number. */
  | { readonly outcome: 'refused'; readonly detail: string; readonly verification?: string }
  | { readonly outcome: 'uncertain'; readonly detail: string }

/** `1 coin`, `2 coins`. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** Why the balance cannot cover a coin write, or nothing. */
function balanceRefusal(balance: number, needed: number): string | undefined {
  return balance < needed ? `the account has ${plural(balance, 'coin')}; this needs ${needed} (about one comes each day from signing in)` : undefined
}

/** Bilibili's coin refusals, explained. */
const COIN_CODES: Readonly<Record<number, string>> = {
  [-104]: 'not enough coins',
  34002: 'an account cannot coin its own video',
  34003: 'that coin count is not allowed for this video',
  34004: 'coins were given too quickly',
  34005: 'this video already has the most coins this account may give',
}

/** Parts of a triple (一键三连). */
const TRIPLE_PARTS = ['like', 'coin', 'favorite'] as const
/** One of {@link TRIPLE_PARTS}. */
type TriplePart = typeof TRIPLE_PARTS[number]

/** What a triple did: the parts it added, and those done before. */
function tripleDetail(added: readonly TriplePart[], before: readonly TriplePart[], coins: number): string {
  const words: Record<TriplePart, string> = { like: 'liked', coin: `gave ${plural(coins, 'coin')}`, favorite: 'saved to the default folder' }
  const head = added.length === 0 ? 'Bilibili applied none of the missing parts' : added.map(part => words[part]).join(', ')
  return before.length === 0 ? head : `${head}; already done before: ${before.join(', ')}`
}

/** One action: what it is about, and the call that does it. */
interface ActSpec {
  action: string
  target: string
  /** Whether it is already done; read before the call, so an idempotent action costs nothing. */
  preRead?: () => Promise<string | undefined>
  /** The one call through bili-svc's door. */
  perform: () => Promise<void>
  /** The `sent` detail; `<action> sent` by default. */
  sentDetail?: () => string
}

/** What the actions need of the account. */
export interface BiliWritesHost {
  readonly client: BiliCaller
  /** IANA time zone of the video facts read before an action. */
  readonly timeZone: string
  /**
   * The account's own mid.
   * @returns the mid; rejects when bili-svc or Bilibili cannot name it.
   */
  selfMid(): Promise<number>
  /** The owner's main account, or undefined while unset. */
  ownerMid(): number | undefined
  logger: { info(message: string): void; warn(message: string): void }
}

/** The account's actions, each one call through bili-svc's door. */
export class BiliWrites {
  /** @param host - the client, the time zone, the account's and the owner's mids, and the logger. */
  constructor(private readonly host: BiliWritesHost) {}

  /**
   * Give a video coins, never with a like.
   * @param bvid - BV id.
   * @param count - 1 or 2; default the most the video takes.
   * @returns the outcome.
   */
  async coin(bvid: string, count?: number): Promise<WriteOutcome> {
    if (count !== undefined && count !== 1 && count !== 2) return { outcome: 'refused', detail: 'count must be 1 or 2' }
    const target = await this.aidOf(bvid)
    if ('refusal' in target) return { outcome: 'refused', detail: target.refusal }
    const most = target.video.original ? 2 : 1
    const coins: 1 | 2 = count === undefined ? most : count
    if (coins > most) return { outcome: 'refused', detail: `${bvid} is not marked original, so Bilibili takes at most 1 coin for it` }
    let short: string | undefined
    const outcome = await this.act({
      action: 'coin', target: bvid,
      preRead: async () => {
        const given = await coinsGiven(this.host.client, bvid)
        if (given > 0) return `this account already gave this video ${plural(given, 'coin')}; one coin write per video`
        short = balanceRefusal((await navInfo(this.host.client)).coins ?? 0, coins)
        return undefined
      },
      perform: async () => {
        if (short !== undefined) throw new BiliRefused(short)
        await giveCoin(this.host.client, target.aid, bvid, coins)
      },
      sentDetail: () => `gave ${plural(coins, 'coin')}`,
    })
    return outcome
  }

  /**
   * 一键三连: like, coins, and a favorite in the default folder, in one request.
   * @param bvid - BV id.
   * @returns the outcome.
   */
  async triple(bvid: string): Promise<WriteOutcome> {
    const target = await this.aidOf(bvid)
    if ('refusal' in target) return { outcome: 'refused', detail: target.refusal }
    const most = target.video.original ? 2 : 1
    let adds: TriplePart[] = []
    let done: TriplePart[] = []
    let coins = most
    let short: string | undefined
    return this.act({
      action: 'triple', target: bvid,
      preRead: async () => {
        const mid = await this.host.selfMid()
        const liked = await hasLiked(this.host.client, bvid)
        const given = await coinsGiven(this.host.client, bvid)
        const saved = (await folders(this.host.client, mid, target.aid)).some(folder => folder.contains)
        const state: Record<TriplePart, boolean> = { like: liked, coin: given > 0, favorite: saved }
        done = TRIPLE_PARTS.filter(part => state[part])
        adds = TRIPLE_PARTS.filter(part => !state[part])
        if (adds.length === 0) return 'this account already liked, coined, and saved this video'
        if (adds.includes('coin')) short = balanceRefusal((await navInfo(this.host.client)).coins ?? 0, most)
        return undefined
      },
      perform: async () => {
        if (short !== undefined) throw new BiliRefused(short)
        const result = await tripleLike(this.host.client, target.aid, bvid)
        if (result.coin && result.coins > 0) coins = result.coins
        // Only what Bilibili applied counts; a part it skipped stays undone.
        adds = adds.filter(part => result[part])
      },
      sentDetail: () => tripleDetail(adds, done, coins),
    })
  }

  /**
   * Report a watch of a video whose subtitles the account read, as far as it read; bili-svc keeps it to once a day.
   * @param video - the video's facts.
   * @param cid - the part whose subtitles were read.
   * @param reached - the second the read subtitles reach.
   */
  async reportWatch(video: VideoDetail, cid: number, reached: number): Promise<void> {
    let mid: number
    try {
      mid = await this.host.selfMid()
    } catch (error: unknown) {
      this.host.logger.info(`bili: no watch report for ${video.bvid}: ${errorText(error)}`)
      return
    }
    const seconds = Math.max(1, Math.min(reached, video.seconds ?? reached))
    const outcome = await this.act({
      action: 'watch', target: video.bvid,
      perform: () => {
        const watched = { aid: video.aid, bvid: video.bvid, cid, mid, duration: video.seconds ?? seconds }
        return reportWatch(this.host.client, watched, seconds)
      },
    })
    if (outcome.outcome === 'uncertain') this.host.logger.warn(`bili: the watch report of ${video.bvid} has an unknown outcome; not sent again`)
  }

  /**
   * Follow an account.
   * @param mid - its user id.
   * @returns the outcome.
   */
  async follow(mid: number): Promise<WriteOutcome> {
    if (!Number.isSafeInteger(mid) || mid <= 0) return { outcome: 'refused', detail: 'mid must be a positive user id' }
    return this.act({
      action: 'follow', target: `mid:${mid}`,
      preRead: async () => {
        if (mid === await this.host.selfMid()) throw new BiliRefused('this is the account itself')
        return [2, 6].includes(await relationTo(this.host.client, mid)) ? 'already following' : undefined
      },
      perform: () => modifyRelation(this.host.client, mid, 1),
    })
  }

  /**
   * Unfollow an account; the owner's account stays followed.
   * @param mid - its user id.
   * @returns the outcome.
   */
  async unfollow(mid: number): Promise<WriteOutcome> {
    if (!Number.isSafeInteger(mid) || mid <= 0) return { outcome: 'refused', detail: 'mid must be a positive user id' }
    if (mid === this.host.ownerMid()) return { outcome: 'refused', detail: 'the owner\'s account stays followed' }
    return this.act({
      action: 'unfollow', target: `mid:${mid}`,
      preRead: async () => ([2, 6].includes(await relationTo(this.host.client, mid)) ? undefined : 'not following'),
      perform: () => modifyRelation(this.host.client, mid, 2),
    })
  }

  /**
   * Add a video to a favorite folder (the default one unless named), or remove it.
   * @param bvid - BV id.
   * @param options - `remove`, and a folder id.
   * @returns the outcome.
   */
  async favorite(bvid: string, options: { remove?: boolean; folderId?: number }): Promise<WriteOutcome> {
    const video = await this.aidOf(bvid)
    if ('refusal' in video) return { outcome: 'refused', detail: video.refusal }
    let folder: Folder | undefined
    return this.act({
      action: 'favorite', target: bvid,
      preRead: async () => {
        const list = await folders(this.host.client, await this.host.selfMid(), video.aid)
        folder = options.folderId === undefined
          ? list.find(entry => entry.isDefault) ?? list[0]
          : list.find(entry => entry.id === options.folderId)
        if (folder === undefined) throw new BiliRefused(`no favorite folder ${options.folderId === undefined ? 'exists' : `with id ${options.folderId}`}`)
        if (options.remove === true) return folder.contains === true ? undefined : `not in folder ${folder.title}`
        return folder.contains === true ? `already in folder ${folder.title}` : undefined
      },
      perform: async () => {
        /* v8 ignore next -- perform runs only after preRead, which throws when no folder was chosen, so `folder` is always set here. */
        const ids = folder === undefined ? [] : [folder.id]
        await dealFavorite(this.host.client, video.aid, options.remove === true ? { add: [], remove: ids } : { add: ids, remove: [] }, bvid)
      },
    })
  }

  /**
   * Like a video.
   * @param bvid - BV id.
   * @returns the outcome.
   */
  async like(bvid: string): Promise<WriteOutcome> {
    const video = await this.aidOf(bvid)
    if ('refusal' in video) return { outcome: 'refused', detail: video.refusal }
    return this.act({
      action: 'like', target: bvid,
      preRead: async () => ((await hasLiked(this.host.client, bvid)) ? 'already liked' : undefined),
      perform: () => likeVideo(this.host.client, video.aid, bvid),
    })
  }

  /**
   * Add a video to watch later, or remove it.
   * @param bvid - BV id.
   * @param remove - remove instead of add.
   * @returns the outcome.
   */
  async watchLater(bvid: string, remove: boolean): Promise<WriteOutcome> {
    const video = await this.aidOf(bvid)
    if ('refusal' in video) return { outcome: 'refused', detail: video.refusal }
    return this.act({
      action: 'watchlater', target: bvid,
      preRead: async () => {
        const listed = (await watchLaterAids(this.host.client)).has(video.aid)
        if (remove) return listed ? undefined : 'not on watch later'
        return listed ? 'already on watch later' : undefined
      },
      perform: () => (remove ? removeWatchLater(this.host.client, video.aid) : addWatchLater(this.host.client, video.aid)),
    })
  }

  /**
   * Run one action through bili-svc's door: an optional pre-read (so an idempotent action costs
   * nothing), then the one call, whose outcome bili-svc decided (caps, once-rules, brake, ledger).
   * Never retried.
   */
  private async act(spec: ActSpec): Promise<WriteOutcome> {
    const log = (outcome: WriteOutcome): WriteOutcome => {
      this.host.logger.info(`bili: ${spec.action} ${spec.target} ${outcome.outcome}${outcome.outcome === 'sent' ? '' : `: ${outcome.detail}`}`)
      return outcome
    }
    try {
      const already = await spec.preRead?.()
      if (already !== undefined) return log({ outcome: 'already', detail: already })
    } catch (error: unknown) {
      // A refusal of this package's own (the account itself, no such folder) is the answer; anything else is a failed check.
      return log({ outcome: 'refused', detail: error instanceof BiliRefused ? error.message : `could not check before writing: ${errorText(error)}` })
    }
    try {
      await spec.perform()
    } catch (error: unknown) {
      return log(outcomeOf(spec.action, error))
    }
    return log({ outcome: 'sent', detail: spec.sentDetail?.() ?? `${spec.action} sent` })
  }

  /** A video to act on, or why not. */
  private async aidOf(bvid: string): Promise<{ aid: string; video: VideoDetail } | { refusal: string }> {
    if (bvidOf(bvid) === undefined) return { refusal: `${JSON.stringify(bvid)} is not a BV id` }
    let video: VideoDetail
    try {
      video = await videoInfo(this.host.client, bvid, this.host.timeZone)
    } catch (error: unknown) {
      return { refusal: `could not read ${bvid}: ${errorText(error)}` }
    }
    return { aid: video.aid, video }
  }
}

/** What an action's failure means for the model. */
function outcomeOf(action: string, error: unknown): WriteOutcome {
  if (error instanceof BiliOutcomeError) {
    const why = error.reason === '' ? '' : ` (${error.reason})`
    switch (error.outcome) {
      case 'already':
        return { outcome: 'already', detail: `bili-svc says it is already done${why}` }
      case 'uncertain':
        return { outcome: 'uncertain', detail: `the outcome is unknown${why}; bili-svc counts it and never sends it again` }
      case 'held':
        return { outcome: 'refused', detail: `bili-svc held it${why}; actions wait until bili-svc lets them through again` }
      default:
        return { outcome: 'refused', detail: `bili-svc refused it${why}` }
    }
  }
  if (error instanceof BiliTransportError) {
    return { outcome: 'uncertain', detail: `the outcome is unknown (${error.message}); it is never sent again` }
  }
  if (error instanceof BiliVerifyError) {
    const words = error.detail === '' ? `code ${error.code}` : error.detail
    return { outcome: 'refused', detail: `Bilibili refused it until the account verifies a phone number: code ${error.code}${error.detail === '' ? '' : ` (${error.detail})`}`, verification: words }
  }
  if (error instanceof BiliRiskError) {
    return { outcome: 'refused', detail: `Bilibili's risk control stopped it (${error.reason}); bili-svc holds actions until the owner releases its brake` }
  }
  if (error instanceof BiliApiError) {
    const hint = action === 'coin' || action === 'triple' ? COIN_CODES[error.code] : undefined
    return { outcome: 'refused', detail: `Bilibili refused it: code ${error.code}${error.detail === '' ? '' : ` (${error.detail})`}${hint === undefined ? '' : `: ${hint}`}` }
  }
  return { outcome: 'refused', detail: errorText(error) }
}
