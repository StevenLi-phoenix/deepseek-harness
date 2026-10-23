# lsy event service (fork-local)

English | [中文](lsy.zh.md)

The fork-local services behind the event-driven agent: [`@deepseek-ai/dsh-lsy-event-bus`](../../packages/lsy/lsy-event-bus/README.md) routes sensor events to notifications or unattended Sessions, [`@deepseek-ai/dsh-lsy-github-sensor`](../../packages/lsy/lsy-github-sensor/README.md) polls GitHub, [`@deepseek-ai/dsh-lsy-wechat`](../../packages/lsy/lsy-wechat/README.md) provides the `lsyNotifier` contract over WeChat, and [`@deepseek-ai/dsh-bili`](../../packages/lsy/bili/README.md) is the agent's own Bilibili account. Behavior, configuration, and limitations are on each package README; the [upstream ledger](../../packages/lsy/UPSTREAM.md) records how the fork tracks upstream.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbili--biliaccount"></a>

### `ctx.bili` — `BiliAccount`

The agent's own Bilibili account: sign-in, cookie refresh, guarded writes, the body clock, the inbox poll, the final-answer relay, and the Settings route.

```ts cordis-catalog
/**
 * Whether this plugin created a Session (and relays its turns).
 * @param sessionId - Session to check.
 * @returns true for every Session this plugin created.
 */
ownsSession(sessionId: string): boolean

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
 * What followed accounts posted.
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
 * @returns bounded video cards.
 */
async search(keyword: string, page: number = 1): Promise<VideoCard[]>

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
 * @param note - title, optional body, and optional link.
 * @returns resolves once the channel accepted the message; rejects on failure.
 */
send(note: LsyNote): Promise<void>

/**
 * Whether the channel already relays every turn of this Session to the owner
 * (e.g. its chat Session), so the bus must not report those turns again.
 * @param sessionId - Session to check.
 * @returns true when the channel relays this Session's turns itself.
 */
ownsSession?(sessionId: string): boolean
```

Source: [`packages/lsy/lsy-event-bus/src/types.ts`](../../packages/lsy/lsy-event-bus/src/types.ts)
<!-- END GENERATED cordis-surface -->
