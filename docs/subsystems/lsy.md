# lsy event service (fork-local)

English | [中文](lsy.zh.md)

The fork-local services behind the event-driven agent: [`@deepseek-ai/dsh-lsy-event-bus`](../../packages/lsy/lsy-event-bus/README.md) routes sensor events to notifications or unattended Sessions, [`@deepseek-ai/dsh-lsy-github-sensor`](../../packages/lsy/lsy-github-sensor/README.md) polls GitHub, [`@deepseek-ai/dsh-lsy-wechat`](../../packages/lsy/lsy-wechat/README.md) provides the `lsyNotifier` contract over WeChat, and [`@deepseek-ai/dsh-bili`](../../packages/lsy/bili/README.md) is the agent's own Bilibili account. Behavior, configuration, and limitations are on each package README; the [upstream ledger](../../packages/lsy/UPSTREAM.md) records how the fork tracks upstream.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbili--biliaccount"></a>

### `ctx.bili` — `BiliAccount`

The agent's own Bilibili account: sign-in, cookie refresh, guarded writes, the body clock, the inbox poll, the DM channel of the owner relay, and the Settings route.

```ts cordis-catalog
/**
 * Whether this plugin created a Session; each one is claimed by the DM channel.
 * @param sessionId - Session to check.
 * @returns true for every Session this plugin created.
 */
ownsSession(sessionId: string): boolean

/**
 * Give a video coins, never with a like. Bilibili takes at most 2 coins per
 * video from one account for an original and 1 otherwise; `count` defaults to
 * that most. One coin write per video ever, and no daily cap: the balance
 * limits it. A refusal code from Bilibili is reported, never retried.
 * @param bvid - BV id.
 * @param count - 1 or 2; default the most the video takes.
 * @returns the write guard's outcome.
 */
async coin(bvid: string, count?: number): Promise<WriteOutcome>

/**
 * 一键三连: like, coins (2 for an original, 1 otherwise), and a favorite in the
 * default folder, in one request. One per video ever, with the normal write
 * gap. Parts already done are reported and not counted; the like and favorite
 * it adds count against those daily caps, and it is refused when either cap
 * it would need is used up, or when the coins it would give exceed the balance.
 * @param bvid - BV id.
 * @returns the write guard's outcome.
 */
async triple(bvid: string): Promise<WriteOutcome>

/**
 * Follow an account.
 * @param mid - its user id.
 * @returns the write guard's outcome.
 */
async follow(mid: number): Promise<WriteOutcome>

/**
 * Unfollow an account; the owner's account stays followed.
 * @param mid - its user id.
 * @returns the write guard's outcome.
 */
async unfollow(mid: number): Promise<WriteOutcome>

/**
 * Add a video to a favorite folder (the default one unless named), or remove it.
 * @param bvid - BV id.
 * @param options - `remove`, and a folder id from `me()`.
 * @returns the write guard's outcome.
 */
async favorite(bvid: string, options: { remove?: boolean; folderId?: number } = {}): Promise<WriteOutcome>

/**
 * Like a video.
 * @param bvid - BV id.
 * @returns the write guard's outcome.
 */
async like(bvid: string): Promise<WriteOutcome>

/**
 * Add a video to watch later, or remove it.
 * @param bvid - BV id.
 * @param remove - remove instead of add.
 * @returns the write guard's outcome.
 */
async watchLater(bvid: string, remove: boolean = false): Promise<WriteOutcome>

/**
 * Post one top-level comment on a video; one per video ever.
 * @param bvid - BV id.
 * @param text - at most 500 characters.
 * @returns the write guard's outcome; a sent comment carries its id as `receipt`.
 */
async comment(bvid: string, text: string): Promise<WriteOutcome>

/**
 * Reply to a comment that replied to or mentioned this account (from its inbox); one reply per comment ever.
 * @param rpid - the comment's id as the inbox shows it.
 * @param text - at most 500 characters.
 * @returns the write guard's outcome; a sent reply carries its id as `receipt`.
 */
async reply(rpid: string, text: string): Promise<WriteOutcome>

/**
 * Post a text-only dynamic.
 * @param text - at most 1000 characters.
 * @returns the write guard's outcome; a sent dynamic carries its id as `receipt`.
 */
async dynamic(text: string): Promise<WriteOutcome>

/**
 * Message the owner's main account; nobody else can be messaged.
 * @param text - at most 500 characters.
 * @returns the write guard's outcome; a sent message carries its key as `receipt`.
 */
async dmOwner(text: string): Promise<WriteOutcome>

/**
 * The next batch of the home feed.
 * @returns about 12 bounded video cards.
 */
async homeFeed(): Promise<VideoCard[]>

/**
 * The site leaderboard (排行榜) across all zones.
 * @returns up to 30 bounded video cards, top first.
 */
async ranking(): Promise<VideoCard[]>

/**
 * A sample of a video's danmaku: the jokes and reactions of its own viewers.
 * @param bvid - BV id.
 * @param part - part number of a multi-part video.
 * @returns up to 40 lines across the video, each with its second.
 */
async danmaku(bvid: string, part?: number): Promise<{ bvid: string; lines: DanmakuLine[] }>

/**
 * What followed accounts posted, without the owner's own posts.
 * @param offset - `next` of the previous page.
 * @returns bounded posts, newest first, and the `next` offset when there are more.
 */
async followingFeed(offset?: string): Promise<{ items: FeedPost[]; next?: string }>

/**
 * Popular videos.
 * @param page - from 1.
 * @returns bounded video cards.
 */
async popular(page: number = 1): Promise<VideoCard[]>

/**
 * Search videos.
 * @param keyword - search words.
 * @param page - from 1.
 * @param order - `relevance` (default) or `newest` first.
 * @returns bounded video cards.
 */
async search(keyword: string, page: number = 1, order: SearchOrder = 'relevance'): Promise<VideoCard[]>

/**
 * A video: facts, one page of subtitles (with coverage notes), and top comments.
 * @param bvid - BV id.
 * @param options - subtitle page and part.
 * @returns the facts, one subtitle page or the reason there is none, and up to five top comments.
 */
async video( bvid: string, options: { subtitlePage?: number; part?: number } = {}, ): Promise<{ video: VideoDetail; subtitle: SubtitleView; topComments: CommentView[] }>

/**
 * Comments of a video, or one thread when `root` is given.
 * @param bvid - BV id.
 * @param options - order, `next` offset, root comment id, and thread page.
 * @returns bounded comments and the `next` offset, or a thread with its root.
 */
async comments(bvid: string, options: { order?: 'hot' | 'new'; offset?: string; root?: string; page?: number } = {}): Promise<{ comments: CommentView[]; next?: string; root?: CommentView }>

/**
 * Unread counts, the newest replies and mentions, and the owner's latest messages; what it shows counts as seen.
 * @returns unread counts, up to ten replies and mentions, and the owner's latest messages.
 */
async inbox(): Promise<InboxView>

/**
 * The account, its folders, and today's budget.
 * @returns the account facts, or `signedIn: false`, with today's budget and any pause.
 */
async me(): Promise<MeView>

/**
 * Keep one dated journal entry.
 * @param text - at most 600 characters; at most 8 entries a day.
 * @returns the stored entry's number and what is left today, or why it was refused.
 */
async journalWrite(text: string): Promise<{ saved: true; seq: number; leftToday: number } | { refused: string }>

/**
 * Recent journal entries, newest first.
 * @param page - from 1.
 * @returns up to ten entries and the page count.
 */
async journalRead(page: number = 1): Promise<{ entries: { seq: number; day: string; text: string }[]; page: number; pages: number }>

/**
 * Send one message to the owner's main agent (`bili_tell_main_agent`): the WeChat channel queues it
 * in the owner's chat Session as untrusted data, and that Session's answer goes to the owner on
 * WeChat. Bounded per day by `mainAgentPerDay`; only messages that were queued count.
 * @param text - at most {@link MAIN_AGENT_MAX_CHARS} characters.
 * @returns `sent` with what is left today, or `refused` with the reason.
 */
async tellMainAgent(text: string): Promise<WriteOutcome>

/**
 * Keep one note about the owner's taste (`bili_taste_write`): what a reaction to a find taught,
 * or what the owner said they want more or less of.
 * @param text - at most 200 characters, one line.
 * @param replaces - number of one of the Session's own notes to rewrite instead of adding one.
 * @returns the note's number and how many notes there are, or why it was refused.
 */
async tasteWrite(text: string, replaces?: number): Promise<{ saved: true; seq: number; notes: number } | { refused: string }>

/**
 * Grade a watched video (`bili_verdict`): `must` 值得看, `ok` 可以看, or `skip` 不值当, and why.
 * `must` needs evidence: the account read the video's subtitles with `video()` first; a grade from
 * the title alone is at most `ok`. Grading again replaces the grade.
 * @param bvid - BV id.
 * @param grade - the grade.
 * @param reason - why, at most 120 characters.
 * @returns the grade kept, or why it was refused.
 */
async verdict(bvid: string, grade: Grade, reason: string): Promise<{ saved: true; grade: Grade } | { refused: string }>

/**
 * The seen list: what the account graded, newest first, or one video's grade.
 * @param bvid - one video to look up.
 * @param limit - entries, at most 50.
 * @returns the grades.
 */
async seen(bvid?: string, limit: number = 30): Promise<{ entries: Omit<SeenRecord, 'at'>[] }>

/**
 * The hot-search list (热搜): what the whole site searches for right now.
 * @returns up to 30 keywords, each with the label the search box shows when it differs.
 */
async hotSearches(): Promise<HotSearch[]>

/**
 * Note one meme, event, or phrase the account met (`bili_trend_write`): what it is, where it
 * comes from, and which community it lives in, so later wakes understand it and can tell the owner.
 * A term already noted is rewritten in place.
 * @param term - the meme itself, at most 30 characters.
 * @param note - at most 200 characters.
 * @param replaces - number of an entry to rewrite instead.
 * @returns the entry's number, or why it was refused.
 */
async trendWrite(term: string, note: string, replaces?: number): Promise<{ saved: true; seq: number } | { refused: string }>

/**
 * What the Settings section shows. Built from storage only, so no cookie or token can reach it.
 * @returns the view.
 */
async view(): Promise<BiliView>
```

Source: [`packages/lsy/bili/src/index.ts`](../../packages/lsy/bili/src/index.ts)

<a id="ctxlsyeventbus--lsyeventbus"></a>

### `ctx.lsyEventBus` — `LsyEventBus`

Durable event bus. Sensors publish; subscriptions from the configuration or created at run time decide which events reach which actuator; the bus owns dedupe, loop suppression, coalescing, and rate limits so actuators never see raw sensor traffic.

```ts cordis-catalog
/**
 * Publish one sensor observation.
 * @param input - event; `source` + `key` identify it for dedupe.
 * @returns `accepted` (queued for at least one subscription), `duplicate`, `suppressed`, or `unmatched`.
 * @throws when a required field is empty.
 */
async publish(input: LsyEventInput): Promise<PublishOutcome>

/**
 * Stored events, oldest first.
 * @returns snapshot of the events table.
 */
events(): LsyEventRecord[]

/**
 * Stored batches, oldest first.
 * @returns snapshot of the batches table.
 */
batches(): BatchRecord[]

/**
 * Number of event/subscription pairs waiting for a batch.
 * @returns pending row count.
 */
pendingCount(): number

/**
 * Add a routing rule at run time. It is stored durably and survives restarts.
 * @param subscription - rule; validated like a configuration row.
 * @param meta - who created the subscription, e.g. the creating Session.
 * @returns the stored subscription with its (empty) status.
 * @throws {LsySubscriptionError} `invalid_subscription` for a rule the bus cannot route, or `duplicate_id`
 * for an id the configuration or another stored subscription already uses.
 */
async subscribe(subscription: Subscription, meta: SubscriptionMeta = {}): Promise<SubscriptionView>

/**
 * Remove a run-time subscription, its pending events, and its flush timer.
 * Batches already created stay in the history.
 * @param id - subscription id.
 * @returns `removed`, `not_found`, or `config_owned` for an id the configuration owns.
 */
async unsubscribe(id: string): Promise<UnsubscribeOutcome>

/**
 * Every subscription, configuration first and then run-time ones by creation time, with live status.
 * @returns snapshot; before the storage domain opens, only configuration rows with empty status.
 */
listSubscriptions(): SubscriptionView[]
```

Source: [`packages/lsy/lsy-event-bus/src/index.ts`](../../packages/lsy/lsy-event-bus/src/index.ts)

<a id="ctxlsygithubsensor--githubsensor"></a>

### `ctx.lsyGithubSensor` — `GithubSensor`

Polls GitHub on a fixed period with conditional requests and publishes what is new since the previous poll. The first successful poll of a stream only records a baseline. Repositories come from the configuration and from watches created at run time; a stream several watches name is polled once.

```ts cordis-catalog
/**
 * Stored cursor of one stream.
 * @param stream - stream id, see {@link streamId}, or `notifications`.
 * @returns cursor, or undefined before the first poll.
 */
cursor(stream: string): StreamCursor | undefined

/**
 * Outcome of the latest poll of one stream in this process.
 * @param stream - stream id, see {@link streamId}, or `notifications`.
 * @returns status, or undefined before the first poll since start or after the stream was forgotten.
 */
pollStatus(stream: string): PollStatus | undefined

/**
 * Watch a repository at run time. The watch is stored durably; a poll starts
 * right away so the existing items become the baseline, and only later
 * items are published. A watch with the same ref is replaced.
 * @param ref - watch id, e.g. the bus subscription that routes its events.
 * @param spec - `owner/name`, a non-empty subset of streams, and an optional commits branch.
 * @returns the stored watch with its stream status.
 * @throws {TypeError} when the ref, repository, streams, or branch is invalid.
 */
async watch(ref: string, spec: RepoWatch): Promise<WatchedRepo>

/**
 * Stop a run-time watch. Cursors of streams nobody polls anymore are
 * deleted, so watching the repository again records a fresh baseline.
 * @param ref - watch id.
 * @returns true when the watch existed.
 */
async unwatch(ref: string): Promise<boolean>

/**
 * Every polled repository, configuration first and then run-time watches by creation time.
 * @returns snapshot with per-stream baseline and latest poll.
 */
watchedRepos(): WatchedRepo[]

/**
 * Check that a repository exists and the repository token can read it. Never throws.
 * @param repo - `owner/name`.
 * @param signal - optional caller cancellation.
 * @returns canonical name, visibility, and default branch, or the HTTP status (0 without a response) and a message.
 */
async probe(repo: string, signal?: AbortSignal): Promise<RepoProbe>

/**
 * Report which tokens resolve. Token values never leave the credential store.
 * @returns per-reference status and whether notification polling is on.
 */
async credentialStatus(): Promise<CredentialStatus>
```

Source: [`packages/lsy/lsy-github-sensor/src/index.ts`](../../packages/lsy/lsy-github-sensor/src/index.ts)

<a id="ctxlsynotifier--lsynotifier"></a>

### `ctx.lsyNotifier` — `LsyNotifier`

Notification actuator contract; a channel plugin provides it as `ctx.lsyNotifier`.

```ts cordis-catalog
/**
 * Deliver one message.
 * @param note - title, optional body, optional link, and optional origin.
 * @returns resolves once the channel accepted the message; rejects on failure.
 */
send(note: LsyNote): Promise<void>

/**
 * Pass a message from another of the agent's Sessions to the owner's main agent: the channel's
 * chat Session, which takes it up in a turn of its own once it is idle. That turn's answer reaches
 * the owner like any other chat answer. Channels without a chat Session omit it.
 * @param message - the text and who sent it.
 * @returns the chat Session the message was queued in.
 * @throws when there is no chat to pass it to or the Session refused the prompt.
 */
tellMainAgent?(message: LsyAgentMessage): Promise<string>

/**
 * Whether the channel created this Session (e.g. its chat Session). Kept for callers outside the
 * bus; the bus asks `ctx.ownerRelay.ownerOf()` which Sessions a relay channel delivers itself.
 * @param sessionId - Session to check.
 * @returns true when the channel created this Session.
 */
ownsSession?(sessionId: string): boolean
```

Source: [`packages/lsy/lsy-event-bus/src/types.ts`](../../packages/lsy/lsy-event-bus/src/types.ts)

<a id="ctxownerrelay--ownerrelay"></a>

### `ctx.ownerRelay` — `OwnerRelay`

The relay. Claims live in memory: each channel claims its stored Sessions again when it registers, and unregistering releases them. Every decision is logged at info level with the Session id and the reason, never the text.

```ts cordis-catalog
/**
 * Add a channel.
 * @param channel - name, delivery, hooks, and fallback label.
 * @returns a disposer that removes the channel and releases every Session it claimed.
 * @throws when a channel of the same name is registered.
 */
registerChannel(channel: RelayChannel): () => void

/**
 * Relay a Session's turns through one channel from now on.
 * @param sessionId - Session to claim; a claim by another channel moves to this one.
 * @param channelName - the claiming channel's name.
 */
claim(sessionId: string, channelName: string): void

/**
 * Stop relaying a Session.
 * @param sessionId - Session to release.
 * @returns whether it was claimed.
 */
release(sessionId: string): boolean

/**
 * The channel that relays a Session's turns.
 * @param sessionId - Session to check.
 * @returns the channel name, or undefined when no channel claimed the Session.
 */
ownerOf(sessionId: string): string | undefined
```

Source: [`packages/lsy/owner-relay/src/index.ts`](../../packages/lsy/owner-relay/src/index.ts)
<!-- END GENERATED cordis-surface -->
