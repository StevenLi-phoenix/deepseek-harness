# fork event service (fork-local)

English | [中文](fork.zh.md)

The fork-local services behind the event-driven agent: [`@deepseek-ai/dsh-fork-event-bus`](../../packages/fork/fork-event-bus/README.md) routes sensor events to notifications or unattended Sessions, [`@deepseek-ai/dsh-fork-github-sensor`](../../packages/fork/fork-github-sensor/README.md) polls GitHub, [`@deepseek-ai/dsh-fork-wechat`](../../packages/fork/fork-wechat/README.md) provides the `forkNotifier` contract over WeChat, [`@deepseek-ai/dsh-fork-qq`](../../packages/fork/fork-qq/README.md) lurks in the QQ groups the owner lists and digests them (its Settings → QQ page, [`@deepseek-ai/dsh-fork-qq-login`](../../packages/fork/fork-qq-login/README.md), shows the connection and the login QR code to scan after a sign-out), [`@deepseek-ai/dsh-fork-style`](../../packages/fork/fork-style/README.md) keeps short QQ and Bilibili exchanges that tune the main agent's voice (its Settings → 说话风格 page is [`@deepseek-ai/dsh-fork-style-settings`](../../packages/fork/fork-style-settings/README.md)), and [`@deepseek-ai/dsh-bili`](../../packages/fork/bili/README.md) is the agent's own Bilibili account. Behavior, configuration, and limitations are on each package README; the [upstream ledger](../../packages/fork/UPSTREAM.md) records how the fork tracks upstream.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbili--biliaccount"></a>

### `ctx.bili` — `BiliAccount`

The agent's own Bilibili account, through bili-svc: reads, actions, the owner-message check, the DM channel of the owner relay, the journal, messages to the main agent, and the Settings route.

```ts cordis-catalog
/**
 * Whether this plugin created a Session; each one is claimed by the DM channel.
 * @param sessionId - Session to check.
 * @returns true for every Session this plugin created.
 */
ownsSession(sessionId: string): boolean

/**
 * Give a video coins, never with a like. Bilibili takes at most 2 coins per video from one
 * account for an original and 1 otherwise; `count` defaults to that most. bili-svc allows one
 * coin write per video ever; the balance limits the rest.
 * @param bvid - BV id.
 * @param count - 1 or 2; default the most the video takes.
 * @returns the outcome.
 */
async coin(bvid: string, count?: number): Promise<WriteOutcome>

/**
 * 一键三连: like, coins (2 for an original, 1 otherwise), and a favorite in the default folder,
 * in one request. Parts already done are reported; all three done answers `already` without a
 * call. bili-svc allows one triple per video ever and counts it against its caps.
 * @param bvid - BV id.
 * @returns the outcome.
 */
async triple(bvid: string): Promise<WriteOutcome>

/**
 * Follow an account.
 * @param mid - its user id.
 * @returns the outcome.
 */
async follow(mid: number): Promise<WriteOutcome>

/**
 * Unfollow an account; the owner's account stays followed.
 * @param mid - its user id.
 * @returns the outcome.
 */
async unfollow(mid: number): Promise<WriteOutcome>

/**
 * Add a video to a favorite folder (the default one unless named), or remove it.
 * @param bvid - BV id.
 * @param options - `remove`, and a folder id from `me()`.
 * @returns the outcome.
 */
async favorite(bvid: string, options: { remove?: boolean; folderId?: number } = {}): Promise<WriteOutcome>

/**
 * Like a video.
 * @param bvid - BV id.
 * @returns the outcome.
 */
async like(bvid: string): Promise<WriteOutcome>

/**
 * Add a video to watch later, or remove it.
 * @param bvid - BV id.
 * @param remove - remove instead of add.
 * @returns the outcome.
 */
async watchLater(bvid: string, remove: boolean = false): Promise<WriteOutcome>

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
 * The hot-search list (热搜): what the whole site searches for right now.
 * @returns up to 30 keywords, each with the label the search box shows when it differs.
 */
async hotSearches(): Promise<HotSearch[]>

/**
 * A video: facts, one page of subtitles (with coverage notes), and top comments. A video whose
 * subtitles were read is reported as watched that far (bili-svc keeps it to once a day).
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
 * Unread counts, the newest replies and mentions, and the owner's latest messages; the owner's
 * messages it shows count as handed over.
 * @returns unread counts, up to ten replies and mentions, and the owner's latest messages.
 */
async inbox(): Promise<InboxView>

/**
 * The account, its folders, its level and coins, and whether bili-svc holds actions.
 * @returns the account facts, or `signedIn: false`.
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
 * What the Settings section shows: the account as bili-svc lists it, read-only, and the owner's
 * main account. bili-svc's status names accounts and session states only, so no cookie or token
 * can reach it.
 * @returns the view.
 */
async view(): Promise<BiliView>
```

Source: [`packages/fork/bili/src/index.ts`](../../packages/fork/bili/src/index.ts)

<a id="ctxbilievidence--bilievidence"></a>

### `ctx.biliEvidence` — `BiliEvidence`

`ctx.biliEvidence`: the Bilibili evidence verifier, provided by `@deepseek-ai/dsh-fork-tool-up` inside the `up` preset's isolated group, so only rows in that group see it.

```ts cordis-catalog
/**
 * Look up the comments a proposal cites.
 * @param ids - comment rpids as decimal strings; duplicates and malformed ids are ignored.
 * @param caller - the calling Session.
 * @returns the comments found, in the order asked; an id that cannot be verified is left out, never invented.
 * @throws {BiliEvidenceRefusedError} when the caller is not the persistent `bili-digest` Session, or its turn
 * already used its calls.
 */
evidenceOf(ids: readonly string[], caller: BiliEvidenceCaller): Promise<BiliEvidenceItem[]>
```

Source: [`packages/fork/fork-tool-up/src/evidence.ts`](../../packages/fork/fork-tool-up/src/evidence.ts)

<a id="ctxlsyeventbus--forkeventbus"></a>

### `ctx.forkEventBus` — `ForkEventBus`

Durable event bus. Sensors publish; subscriptions from the configuration or created at run time decide which events reach which actuator; the bus owns dedupe, loop suppression, coalescing, and rate limits so actuators never see raw sensor traffic.

```ts cordis-catalog
/**
 * Publish one sensor observation.
 * @param input - event; `source` + `key` identify it for dedupe.
 * @returns `accepted` (queued for at least one subscription), `duplicate`, `suppressed`, or `unmatched`.
 * @throws when a required field is empty.
 */
async publish(input: ForkEventInput): Promise<PublishOutcome>

/**
 * Stored events, oldest first.
 * @returns snapshot of the events table.
 */
events(): ForkEventRecord[]

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
 * The persistent Sessions of subscriptions with `session.persistent.enabled`.
 * @returns one row per subscription that has one; empty before the storage domain opens.
 */
persistentSessions(): PersistentSessionView[]

/**
 * The subscription whose current persistent Session this is. Tools that may run only in that Session
 * (for example the `up` preset's note tool) ask this.
 * @param sessionId - Session to check.
 * @returns the subscription id, or undefined when the Session is no subscription's current persistent Session.
 */
persistentSubscriptionOf(sessionId: string): string | undefined

/**
 * Add a routing rule at run time. It is stored durably and survives restarts.
 * @param subscription - rule; validated like a configuration row.
 * @param meta - who created the subscription, e.g. the creating Session.
 * @returns the stored subscription with its (empty) status.
 * @throws {ForkSubscriptionError} `invalid_subscription` for a rule the bus cannot route, or `duplicate_id`
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

Source: [`packages/fork/fork-event-bus/src/index.ts`](../../packages/fork/fork-event-bus/src/index.ts)

<a id="ctxlsygithubsensor--githubsensor"></a>

### `ctx.forkGithubSensor` — `GithubSensor`

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

Source: [`packages/fork/fork-github-sensor/src/index.ts`](../../packages/fork/fork-github-sensor/src/index.ts)

<a id="ctxlsynotifier--forknotifier"></a>

### `ctx.forkNotifier` — `ForkNotifier`

Notification actuator contract; a channel plugin provides it as `ctx.forkNotifier`.

```ts cordis-catalog
/**
 * Deliver one message.
 * @param note - title, optional body, optional link, and optional origin.
 * @returns resolves once the channel accepted the message; rejects on failure.
 */
send(note: ForkNote): Promise<void>

/**
 * Pass a message from another of the agent's Sessions to the owner's main agent: the channel's
 * chat Session, which takes it up in a turn of its own once it is idle. That turn's answer reaches
 * the owner like any other chat answer. Channels without a chat Session omit it.
 * @param message - the text and who sent it.
 * @returns the chat Session the message was queued in.
 * @throws when there is no chat to pass it to or the Session refused the prompt.
 */
tellMainAgent?(message: ForkAgentMessage): Promise<string>

/**
 * Whether the channel created this Session (e.g. its chat Session). Kept for callers outside the
 * bus; the bus asks `ctx.ownerRelay.ownerOf()` which Sessions a relay channel delivers itself.
 * @param sessionId - Session to check.
 * @returns true when the channel created this Session.
 */
ownsSession?(sessionId: string): boolean
```

Source: [`packages/fork/fork-event-bus/src/types.ts`](../../packages/fork/fork-event-bus/src/types.ts)

<a id="ctxlsypresence--forkpresence"></a>

### `ctx.forkPresence` — `ForkPresence`

Presence of the owner. Holds the latest Focus signal and Settings button in storage, evaluates the answer on demand and at every moment it can change by itself, and tells listeners when the owner falls asleep or wakes.

```ts cordis-catalog
/**
 * Whether the owner is asleep right now.
 * @returns true while a button, a fresh Focus signal, or the window says so.
 */
isAsleep(): boolean

/**
 * Whether a message must be sent even while the owner sleeps: the sender marked it urgent, or one of the
 * event kinds it reports matches an urgent glob.
 * @param note - the message; only `urgent` and `kinds` are read.
 * @returns true when it must not wait.
 */
isUrgent(note: Pick<ForkNote, 'urgent' | 'kinds'>): boolean

/**
 * Listen for the owner falling asleep and waking, whatever the source.
 * @param listener - called with the new state.
 * @returns a function that stops listening.
 */
onChange(listener: PresenceListener): () => void

/**
 * Register a channel that holds messages back.
 * @param holder - how to count and flush them.
 * @returns a function that unregisters it.
 */
registerHolder(holder: DeferralHolder): () => void

/**
 * Send what the channels hold back, now.
 * @returns how many messages went out.
 */
async flushNow(): Promise<number>

/**
 * Apply a Focus signal pushed by `focus-watch` (the `presence` ingest source). The Host's receipt time is
 * the signal's time; the pusher's clock is ignored, and its key only tells a heartbeat (`sleep-on-hb-<bucket>`) from a
 * change. A signal that repeats the state already held, which every heartbeat does, refreshes how long the
 * state holds and nothing else: no change of `since`, no end to a button, no listener call, no flush. Only a
 * signal that flips the state (or the first one) begins a new state and ends a button.
 * @param event - `presence.sleep.on` or `presence.sleep.off`.
 * @returns `asleep` or `awake`, as the signal says.
 * @throws {Error} for any other kind.
 */
async ingest(event: ForkEventInput): Promise<string>

/**
 * Press "I am going to sleep" or "I am awake", optionally with an end.
 * @param asleep - the state to hold.
 * @param until - when it lapses, in Unix epoch milliseconds; omitted holds for `manualMaxHours` or until the next Focus signal.
 */
async setManual(asleep: boolean, until?: number): Promise<void>

/**
 * Quiet until a clock time: the next time the local clock reads `clock`.
 * @param clock - `HH:MM`, 24-hour.
 * @returns the end, in Unix epoch milliseconds.
 */
async quietUntil(clock: string): Promise<number>

/** Drop the button, so the Focus signal or the window decides again. */
async clearManual(): Promise<void>

/**
 * Replace the daily window; it survives restarts and replaces the configured one.
 * @param window - the new window.
 */
async setWindow(window: QuietWindow): Promise<void>

/**
 * The state with everything Settings shows.
 * @param deferred - messages held back, if the caller counts them.
 * @returns the view.
 */
view(deferred: number = this.deferredCount()): PresenceView

/**
 * Count what the channels hold back.
 * @returns messages the registered channels hold back.
 */
deferredCount(): number
```

Source: [`packages/fork/fork-presence/src/index.ts`](../../packages/fork/fork-presence/src/index.ts)

<a id="ctxlsyqq--qqobserver"></a>

### `ctx.forkQq` — `QqObserver`

The observer. Provides `ctx.forkQq`, whose read methods the agent tools use; its connection to the protocol end and its writes to the database are the only things it does on its own.

```ts cordis-catalog
/**
 * Every group the account is in, as the Settings page's group list offers them: the recorded ones first, then the
 * others by how many messages they showed since the observer started.
 * @returns one entry per group, with the count of dropped messages (a number, nothing of them is kept).
 */
groupChoices(): Array<{ groupId: string; name: string; memberCount: number | null; recorded: boolean; seen: number }>

/**
 * Every group the account is in, with what is recorded of it.
 * @returns recorded groups first, then the others.
 */
groupOverview(): GroupOverview[]

/**
 * How many messages each group that is not recorded has shown since the observer started: a count, nothing else.
 * @returns group number, name, and count, busiest first.
 */
unlistedActivity(): Array<{ groupId: string; name: string; messages: number }>

/**
 * Display name of a group.
 * @param groupId - group number.
 * @returns the name the account last saw, or the number.
 */
groupName(groupId: string): string

/**
 * `qq_digest_write` for the tools of the digest preset: stage the calling Session's digest.
 * @param sessionId - the calling Session.
 * @param groupId - the group the model names; it must be the group the Session is digesting.
 * @param text - the digest.
 * @returns what to tell the model.
 */
digestWrite(sessionId: string | undefined, groupId: string, text: string): ToolOutcome

/**
 * `qq_group_note` for the tools of the digest preset: add or remove a note of the group the calling Session is digesting.
 * @param sessionId - the calling Session.
 * @param groupId - the group the model names; it must be the group the Session is digesting.
 * @param op - `add` or `remove`.
 * @param text - the note, or for `remove` its `#id` or exact text.
 * @returns what to tell the model.
 */
groupNote(sessionId: string | undefined, groupId: string, op: string, text: string): ToolOutcome

/**
 * The group a digest Session is digesting, for a tool that takes the group from the Session.
 * @param sessionId - the calling Session.
 * @returns the group number while the Session's turn runs; otherwise undefined.
 */
groupOfSession(sessionId: string | undefined): string | undefined

/**
 * The text of the messages the calling digest Session was shown this turn, for a tool that checks a quotation word for word.
 * @param sessionId - the calling Session.
 * @returns the stored one-line texts while the turn runs; otherwise undefined.
 */
recentTextOf(sessionId: string | undefined): readonly string[] | undefined

/**
 * The notes of a recorded group: what the QQ channel remembers of its habits.
 * @param groupId - group number; an unrecorded group yields nothing.
 * @returns the notes, oldest first.
 */
groupNotes(groupId: string): GroupNote[]

/**
 * Evidence for a claim about a group's chat, without exposing who said what: for each message id the group still
 * holds, a stable sender key (a salted hash of the member within this group, never the QQ number), its time, and its
 * stored one-line text, so a caller can check a quotation word for word.
 * @param groupId - group number; an unrecorded group yields nothing.
 * @param messageIds - OneBot message ids, at most 200 are looked at.
 * @returns one entry per message found: recorded, not recalled, and still inside the retention window.
 */
evidenceOf(groupId: string, messageIds: readonly string[]): Array<{ messageId: string; senderKey: string; at: number; text: string }>

/**
 * Whether a group is on the `groups` list.
 * @param groupId - group number.
 * @returns true for a recorded group.
 */
isRecorded(groupId: string): boolean

/**
 * Recent messages of a recorded group, oldest first.
 * @param groupId - group number; an unrecorded group yields nothing.
 * @param options - window in hours, at most `limit` messages, optionally one member's QQ number.
 * @returns the messages.
 */
recentMessages(groupId: string, options: { hours: number; limit: number; userId?: string }): MessageRow[]

/**
 * Search the recorded groups' messages, newest first.
 * @param query - words to find.
 * @param options - one group, or all recorded groups, and at most `limit` matches.
 * @returns the matching messages.
 */
searchMessages(query: string, options: { groupId?: string; limit: number }): MessageRow[]

/**
 * Newest digests of the recorded groups.
 * @param options - one group, or all recorded groups, a window in days, and at most `limit` digests.
 * @returns the digests, newest first.
 */
digests(options: { groupId?: string; days: number; limit: number }): DigestRow[]

/**
 * Send text to a group. Refused unless `send.enabled` is true and the group is in `send.groups`, and held to
 * `send.minIntervalSec` between sends and `send.maxPerDay` a day for that group. Nothing in this package calls it.
 * @param groupId - group number.
 * @param text - what to send.
 * @throws {@link SendRefused} when a rule says no, or the protocol end is not connected.
 */
async sendGroupMessage(groupId: string, text: string): Promise<void>

/**
 * The observer's connection to the protocol end, for the Settings page's QQ section: whether the socket is up,
 * since when, how many attempts have failed in a row, and why the last one did.
 * @returns the connection state; `selfId` is the logged-in account only while connected.
 */
connectionStatus(): QqConnection

/**
 * How many groups the observer records, for the Settings page's QQ section.
 * @returns the size of the configured `groups` list.
 */
recordedGroups(): number

/**
 * NapCat's login as the login door reports it, for the Settings page's QQ section. When NapCat turns out to be
 * logged in while the observer is still backing off, the observer reconnects at once, so a scan on the page ends
 * in "connected" within seconds. Answers are shared for 1.5 s.
 * @param options - `fresh` skips the shared answer.
 * @returns the reading; `door` says why there is no `state` when the door could not answer.
 */
async loginStatus(options: { fresh?: boolean } = {}): Promise<QqLoginReading>

/**
 * Ask NapCat for a fresh login QR code (it renews the code by itself about every two minutes). Refused while QQ is
 * logged in and for ten minutes after the connection came up: a new code then only invites the account to be signed
 * out, so nothing is asked of NapCat.
 * @returns the reading after the request, whether the door passed the request on, and why not when it did not.
 */
async refreshLogin(): Promise<{ login: QqLoginReading; refreshed: boolean; reason: RefreshRefusal | null }>

/**
 * Delete stored digests: the observer's learned knowledge. Raw messages age out by themselves.
 * @param options - one group and/or those made before `beforeMs`; at least one is required.
 * @returns how many digests were deleted.
 */
forgetDigests(options: { groupId?: string; beforeMs?: number }): number
```

Source: [`packages/fork/fork-qq/src/index.ts`](../../packages/fork/fork-qq/src/index.ts)

<a id="ctxlsyqqbot--qqbotchannel"></a>

### `ctx.forkQqBot` — `QqBotChannel`

QQ channel. Connects the official bot to the QQ Open Platform, answers only the openids in `allow`, gives each private chat and each group its own chat Session, and delivers each turn's final answer that `ctx.ownerRelay` hands its `qqbot` channel. QQ lets a bot reply to a message within a window (about an hour in private chats, minutes in groups) and at most five times; later answers go out as proactive messages, and an answer QQ refuses falls back to `ctx.forkNotifier` through the relay.

```ts cordis-catalog
/**
 * Whether this channel created a Session: true for every chat Session it remembers, all of which
 * it claims with `ctx.ownerRelay`.
 * @param sessionId - Session to check.
 * @returns true for the current and earlier chat Sessions of every peer.
 */
ownsSession(sessionId: string): boolean
```

Source: [`packages/fork/fork-qqbot/src/index.ts`](../../packages/fork/fork-qqbot/src/index.ts)

<a id="ctxlsystyle--styleservice"></a>

### `ctx.forkStyle` — `StyleService`

The samples, their collection, and the block: what the root row provides as `ctx.forkStyle`.

```ts cordis-catalog
/**
 * Counts for the Settings overview, without any sample text; refreshed whenever the panel is read, after each run,
 * and on the schedule check.
 * @returns active (`kept`) and pending samples, the review mode, the last run's start, and the stock-line trend.
 */
health(): StyleHealth

/** Stop a run in progress (its Bilibili reads end). */
dispose(): void

/**
 * The block for a day.
 * @param day - `YYYY-MM-DD`, the rotation seed.
 * @returns the block, or undefined when collection is off or nothing is active.
 */
async block(day: string): Promise<{ text: string; shown: number; owner: number } | undefined>

/**
 * When the next scheduled run is due.
 * @returns epoch milliseconds; undefined while collection is off.
 */
async nextRunAt(): Promise<number | undefined>

/**
 * Run a collection when one is due and none is running.
 * @returns the run's report, or undefined when nothing ran.
 */
async runIfDue(): Promise<RunReport | undefined>

/**
 * Everything the Settings section shows.
 * @returns the samples, limits, the last run, the next run, and the trend.
 */
async panel(): Promise<StylePanel>

/**
 * Apply one edit the owner made on the Settings page.
 * @param input - `{ op: 'remove' | 'keep', id }` or `{ op: 'add', reply, prompt? }`, as the page sent it; validated here.
 * @returns the panel after the edit, or the refusal (`not_found`, `invalid_input`) with the unchanged panel.
 */
async edit(input: unknown): Promise<StyleEditAnswer>

/**
 * Start a collection run without waiting for it; the panel says `running` until it ends. Nothing runs while
 * collection is off.
 * @returns the panel right after the start.
 */
async collect(): Promise<StylePanel>
```

Source: [`packages/fork/fork-style/src/index.ts`](../../packages/fork/fork-style/src/index.ts)

<a id="ctxlsyvoice--forkvoice"></a>

### `ctx.forkVoice` — `ForkVoice`

Service behind `ctx.forkVoice`.

```ts cordis-catalog
/**
 * Whether `transcribe` would take this file: transcription is on and the extension is a format the asr-service reads.
 * @param path - file name or path.
 * @returns true when `transcribe` would accept the file.
 */
canTranscribe(path: string): boolean

/**
 * Turn a text into an audio file under the data directory. The provider's answer is written first
 * (`<name>.wav`, plus `<name>.job.json` when the provider has job metadata); the delivered file is
 * that WAV, or its MP3 conversion.
 * @param text - what to say.
 * @param options - `signal` cancels the call.
 * @returns the file and who made it.
 * @throws VoiceError when speech is off, the text is unusable, or every provider failed.
 */
speak(text: string, options: { signal?: AbortSignal } = {}): Promise<SpeakResult>

/**
 * Transcribe an audio file. The service's raw answer is written to `<dataDir>/asr/` before it is parsed.
 * @param path - absolute path of an audio file the asr-service reads (m4a, mp3, wav, flac, ogg, wma, aac, webm).
 * @param options - `signal` cancels the call.
 * @returns the text and where the raw answer lives.
 * @throws VoiceError when transcription is off, the file is unusable, or the service failed.
 */
async transcribe(path: string, options: { signal?: AbortSignal } = {}): Promise<TranscribeResult>
```

Source: [`packages/fork/fork-voice/src/index.ts`](../../packages/fork/fork-voice/src/index.ts)

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

Source: [`packages/fork/owner-relay/src/index.ts`](../../packages/fork/owner-relay/src/index.ts)
<!-- END GENERATED cordis-surface -->
