# fork 事件服务（fork 本地）

[English](fork.md) | 中文

事件驱动 agent 背后的 fork 本地服务：[`@deepseek-ai/dsh-event-bus`](../../packages/fork/event-bus/README.zh.md) 把传感器事件路由成通知或无人值守的 Session，[`@deepseek-ai/dsh-github-sensor`](../../packages/fork/github-sensor/README.zh.md) 轮询 GitHub，[`@deepseek-ai/dsh-wechat`](../../packages/fork/wechat/README.zh.md) 通过微信提供 `ownerNotifier` 契约，[`@deepseek-ai/dsh-qq`](../../packages/fork/qq/README.zh.md) 潜伏在主人列出的 QQ 群里并做摘要，消息由 `qq-recorder` 服务提供（它是独占 QQ 唯一连接的 AMS 服务，所以重启 DSH 不会让 QQ 重连；它的设置 → QQ 页面 [`@deepseek-ai/dsh-qq-login`](../../packages/fork/qq-login/README.zh.md) 显示连接状态，以及被踢下线后用来扫码的登录二维码），[`@deepseek-ai/dsh-speaking-style`](../../packages/fork/speaking-style/README.zh.md) 保存各 agent 共享的人格层，学自 QQ 群和 B站公开文本（它的设置 → 人格与风格 页面是 [`@deepseek-ai/dsh-speaking-style-settings`](../../packages/fork/speaking-style-settings/README.zh.md)），[`@deepseek-ai/dsh-bili`](../../packages/fork/bili/README.zh.md) 是 agent 自己的 B站账号，[`@deepseek-ai/dsh-courses`](../../packages/fork/courses/README.zh.md) 按 courses 服务里的记录、用固定规则提醒主人课程 DDL（它的设置 → 课程 DDL 页是 [`@deepseek-ai/dsh-courses-settings`](../../packages/fork/courses-settings/README.zh.md)），[`@deepseek-ai/dsh-gmail`](../../packages/fork/gmail/README.zh.md) 管理主人的 Gmail 账号，以及把主人没确认的信留成草稿的发信关卡（它的设置 → 邮箱 页是 [`@deepseek-ai/dsh-gmail-settings`](../../packages/fork/gmail-settings/README.zh.md)），[`@deepseek-ai/dsh-subagent-activity`](../../packages/fork/subagent-activity/README.zh.md) 在顶栏打开的右侧栏页面里列出一个会话的子智能体和它们此刻在做什么。行为、配置与限制见各包 README；[上游账本](../../packages/fork/UPSTREAM.md)记录 fork 如何跟踪上游。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * What the Settings section shows: every account bili-svc lists, its gate, brake, and ledger, QR
 * sign-ins in progress, and the owner's main account. With the manage token the status comes from
 * the management read; without it, from the agent's own token, read-only. bili-svc's answers carry
 * no cookie or token, and the QR keys stay on the Host.
 * @param result - what the action that led to this view did; null for a plain read.
 * @param ledgerRows - ledger rows to read.
 * @returns the view.
 */
async view(result: ActionResult | null = null, ledgerRows: number = LEDGER_ROWS): Promise<BiliView>
```

Source: [`packages/fork/bili/src/index.ts`](../../packages/fork/bili/src/index.ts)

<a id="ctxbilievidence--bilievidence"></a>

### `ctx.biliEvidence` — `BiliEvidence`

`ctx.biliEvidence`: the Bilibili evidence verifier, provided by `@deepseek-ai/dsh-tool-up` inside the `up` preset's isolated group, so only rows in that group see it.

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

Source: [`packages/fork/tool-up/src/evidence.ts`](../../packages/fork/tool-up/src/evidence.ts)

<a id="ctxbilihot--bilihot"></a>

### `ctx.biliHot` — `BiliHot`

`ctx.biliHot`: the hot comments and hot-search words recent public reads showed.

```ts cordis-catalog
/**
 * Hot comments (at least {@link HOT_MIN_LIKES} likes) read since a time.
 * @param options - `since` in Unix epoch milliseconds; omitted, every kept comment.
 * @returns comments, newest read first; expired rows are never returned.
 */
comments(options?: { since?: number }): Promise<BiliHotComment[]>

/**
 * Hot-search keywords seen since a time.
 * @param options - `since` in Unix epoch milliseconds; omitted, every kept word.
 * @returns the words, most recently listed first; expired rows are never returned.
 */
words(options?: { since?: number }): Promise<string[]>
```

Source: [`packages/fork/bili/src/hot.ts`](../../packages/fork/bili/src/hot.ts)

<a id="ctxclaudecodesessions--claudecodeadmin"></a>

### `ctx.claudeCodeSessions` — `ClaudeCodeAdmin`

Service behind `ctx.claudeCodeSessions`.

```ts cordis-catalog
/**
 * How the service account is signed in, from file existence only.
 * @returns the login state.
 */
login(): CcLogin

/**
 * Live sessions and the tmux sessions the bridge started.
 * @returns the view.
 */
async view(): Promise<CcView>

/**
 * Start a session, optionally with a first task.
 * @param name - lower-case letters, digits, and hyphens, at most 31 characters.
 * @param task - the first prompt, at most {@link MAX_TASK_CHARS} characters.
 * @returns the outcome; the limit is a code of its own so a page can word it.
 */
async start(name: string, task: string | undefined): Promise<CcOutcome>

/**
 * Stop a session the bridge started.
 * @param name - the name it was started with.
 * @returns the outcome.
 */
async stop(name: string): Promise<CcOutcome>
```

Source: [`packages/fork/cc-admin/src/index.ts`](../../packages/fork/cc-admin/src/index.ts)

<a id="ctxcontentguard--guardservice"></a>

### `ctx.contentGuard` — `GuardService`

The validator.

```ts cordis-catalog
/**
 * Check a text before it is written where others can read it.
 * @param text - the text as it would be written.
 * @param options - purpose, audience, and the Session that wrote it.
 * @returns `{ ok: true }`, or the rule that refused it and a reason that never repeats the text. Never rejects.
 */
async check(text: string, options: GuardCheckOptions): Promise<GuardVerdict>

/**
 * Counts for the Settings overview, last 24 hours, without any text.
 * @returns checks, refusals by rule, the last layer failure, and the latest check.
 */
health(): GuardHealth
```

Source: [`packages/fork/content-guard/src/service.ts`](../../packages/fork/content-guard/src/service.ts)

<a id="ctxcourses--courses"></a>

### `ctx.courses` — `Courses`

The courses client and the deadline poller.

```ts cordis-catalog
/**
 * Whether reminders wait right now: the daily window, or the owner asleep when `followPresence` is on.
 * @param now - Unix epoch milliseconds.
 * @returns true while quiet.
 */
isQuiet(now: number = Date.now()): boolean

/**
 * Read the report once, send what is due, and record the outcome. Polls run one at a time; a manual poll while
 * one runs waits for it and then runs.
 * @param trigger - the timer or the Settings button.
 * @returns the poll's record.
 */
poll(trigger: 'timer' | 'manual'): Promise<PollRecord>

/**
 * Everything Settings shows: the rules, the last poll, the sync health with the newest run's reason, the
 * outage counter, the next reminders, and the latest messages (newest first).
 * @returns a snapshot.
 */
status(): CoursesStatus
```

Source: [`packages/fork/courses/src/index.ts`](../../packages/fork/courses/src/index.ts)

<a id="ctxeventbus--eventbus"></a>

### `ctx.eventBus` — `EventBus`

Durable event bus. Sensors publish; subscriptions from the configuration or created at run time decide which events reach which actuator; the bus owns dedupe, loop suppression, coalescing, and rate limits so actuators never see raw sensor traffic.

```ts cordis-catalog
/**
 * Publish one sensor observation.
 * @param input - event; `source` + `key` identify it for dedupe.
 * @returns `accepted` (queued for at least one subscription), `duplicate`, `suppressed`, or `unmatched`.
 * @throws when a required field is empty.
 */
async publish(input: BusEventInput): Promise<PublishOutcome>

/**
 * Stored events, oldest first.
 * @returns snapshot of the events table.
 */
events(): BusEventRecord[]

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
 * {@link ensureProject} with this Host's Workspace registry, once per path and process.
 * @param path - absolute directory.
 * @param name - title of a new project.
 * @returns resolves once the directory exists and is a project; a registry failure is logged, not thrown.
 */
ensureProject(path: string, name: string): Promise<void>

/**
 * Add a routing rule at run time. It is stored durably and survives restarts.
 * @param subscription - rule; validated like a configuration row.
 * @param meta - who created the subscription, e.g. the creating Session.
 * @returns the stored subscription with its (empty) status.
 * @throws {SubscriptionError} `invalid_subscription` for a rule the bus cannot route, or `duplicate_id`
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
 * Pause or resume a run-time subscription. A paused subscription stops matching new events (they are
 * `unmatched` for it) and holds the events already pending; resuming flushes those after the usual
 * coalesce window. The flag is stored, so it survives restarts.
 * @param id - subscription id.
 * @param paused - true to pause, false to resume.
 * @returns `ok`, `not_found`, or `config_owned` for an id the configuration owns.
 */
async setPaused(id: string, paused: boolean): Promise<PauseOutcome>

/**
 * The whole notification flow: every route with where its answer goes and which routes take it, including a configuration route
 * taken out, so it can be seen and put back.
 * @returns routes in matching order, then the ones taken out.
 */
flowRoutes(): FlowRouteView[]

/**
 * Changes of the flow.
 * @param limit - most entries.
 * @returns the newest first.
 */
flowHistory(limit: number = this.config.flowChangesKept): FlowChange[]

/**
 * Change the notification flow at run time. It is stored, so a restart or a deploy keeps it; a configuration route keeps its bundle
 * row and `reset` puts it back.
 * @param edit - the change.
 * @param meta - who made it and why.
 * @returns the route as it stands, the history entry, and anything worth a second look.
 * @throws {FlowError} when the change would leave a route the bus cannot run, or a loop.
 */
async editFlow(edit: FlowEdit, meta: FlowEditMeta = {}): Promise<FlowEditResult>

/**
 * Keep a plugin's Sessions out of the auto-archive sweep (for example the QQ resident group Sessions or the WeChat chat
 * Session). `check` runs only for Sessions that are otherwise due; return `true` (or a short reason) to keep one. A throw keeps it.
 * Register inside an effect so a reload withdraws the claim:
 * `ctx.inject(['eventBus'], scoped => {
 *   scoped.effect(() => scoped.eventBus.protectSessions('qq', check), 'qq.archiveProtection()')
 * })`.
 * @param label - skip category name shown in the sweep log and Settings, for example `qq`.
 * @param check - the claim.
 * @returns the disposer; the bus drops every claim when it stops.
 */
protectSessions(label: string, check: SessionProtector): ProtectionDisposer

/**
 * Register a mover that runs on every {@link handOverSessions}, for a plugin whose bindings name a Session
 * (what it delivers to it, or records as created by it). Register inside an effect so a reload withdraws it:
 * `ctx.inject(['eventBus'], scoped => { scoped.effect(() => scoped.eventBus.registerHandover('monitor', move)) })`.
 * @param kind - binding kind reported with what the mover moved, for example `monitor`.
 * @param move - the mover.
 * @returns the disposer.
 */
registerHandover(kind: string, move: SessionHandoverMover): () => void

/**
 * Move every binding of some Sessions to another Session, for a conversation that continues in a new Session
 * (WeChat `/new`): the run-time subscriptions they created now name `to` as their creator, then each registered
 * mover moves its own. A failing mover is logged and reported, and the others still run; a repeat moves nothing
 * the first call moved.
 * @param from - Sessions whose bindings move; `to` itself is ignored.
 * @param to - Session that takes them over.
 * @returns what moved, by kind (kinds that moved nothing are left out), and which movers failed.
 */
async handOverSessions(from: readonly string[], to: string): Promise<SessionHandoverReport>

/**
 * The auto-archive schedule, protectors, last sweep, and recently archived Sessions, for health and Settings.
 * @returns snapshot.
 */
archiveStatus(): ArchiveStatus

/**
 * Run an auto-archive sweep now (Settings "sweep now"); joins a sweep already running.
 * @param options - `dryRun: true` lists what a sweep would archive without archiving.
 * @returns the sweep report.
 */
sweepArchive(options: { dryRun?: boolean } = {}): Promise<SweepReport>

/**
 * Counters for the last rolling hour and the current queue, for status pages.
 * @returns snapshot; before the storage domain opens, only the configuration rows are counted.
 */
stats(): BusStats

/**
 * Every subscription, configuration first and then run-time ones by creation time, with live status.
 * @returns snapshot; before the storage domain opens, only configuration rows with empty status.
 */
listSubscriptions(): SubscriptionView[]
```

Source: [`packages/fork/event-bus/src/index.ts`](../../packages/fork/event-bus/src/index.ts)

<a id="ctxgithubsensor--githubsensor"></a>

### `ctx.githubSensor` — `GithubSensor`

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

Source: [`packages/fork/github-sensor/src/index.ts`](../../packages/fork/github-sensor/src/index.ts)

<a id="ctxgmail--gmail"></a>

### `ctx.gmail` — `Gmail`

The owner's Gmail accounts.

```ts cordis-catalog
/**
 * Every connected account, in id order.
 * @returns the accounts without tokens.
 */
accounts(): AccountView[]

/**
 * Search an account's mail.
 * @param account - account id.
 * @param query - Gmail search syntax.
 * @param options - threads wanted (capped by config) and the page token of a previous page.
 * @returns one summary per thread.
 */
search(account: string, query: string, options: SearchOptions = {}): Promise<SearchResult>

/**
 * Read one thread: its newest messages in full.
 * @param account - account id.
 * @param threadId - thread id.
 * @param keepQuotes - keep the quoted history of each reply.
 * @returns the thread.
 */
thread(account: string, threadId: string, keepQuotes: boolean = false): Promise<ThreadView>

/**
 * Read one message.
 * @param account - account id.
 * @param messageId - message id.
 * @param keepQuotes - keep the quoted history.
 * @returns the message.
 */
message(account: string, messageId: string, keepQuotes: boolean = false): Promise<MessageView>

/**
 * Save one attachment of a received message under `<cwd>/.gmail-inbox/`.
 * @param account - account id.
 * @param messageId - message id.
 * @param part - the attachment's part id.
 * @param cwd - the Session's working directory.
 * @returns where it was saved.
 */
download(account: string, messageId: string, part: string, cwd: string): Promise<SavedAttachment>

/**
 * Write a draft, or replace one.
 * @param account - account id.
 * @param message - the message.
 * @param draftId - the draft to replace; a held one cannot be changed.
 * @returns the draft.
 */
draft(account: string, message: Outgoing, draftId?: string): Promise<DraftOutcome>

/**
 * Send a message or a draft, or hold it for the owner, by the account's policy and the turn.
 * @param account - account id.
 * @param request - a new message, or a draft id.
 * @param turn - the turn's facts, read from the Session log.
 * @returns sent, or held with its reason.
 * @throws GmailError `refused` on a read-only account, `limit` over the daily cap.
 */
send(account: string, request: SendRequest, turn: TurnFacts): Promise<SendOutcome>

/**
 * Send a held message the owner confirmed.
 * @param code - the held message's code, in any case.
 * @param how - from Settings, or from the owner's own turn (whose words must hold the code).
 * @returns the sent message.
 * @throws GmailError when the code is unknown, resolved, or expired, the turn does not confirm, the draft changed, or the cap is reached.
 */
confirm(code: string, how: { readonly by: 'settings' } | { readonly by: 'owner-turn'; readonly turn: TurnFacts }): Promise<{ readonly account: string; readonly messageId: string; readonly threadId: string }>

/**
 * Drop a held message: its draft is deleted from Gmail.
 * @param code - the held message's code.
 */
discard(code: string): Promise<void>

/**
 * Change labels on threads: read state, inbox, star, trash, or a label of the account's own.
 * @param account - account id.
 * @param threadIds - threads to change.
 * @param action - the change.
 * @param label - the label name, for `label` and `unlabel`.
 * @returns how many threads changed.
 */
modify(account: string, threadIds: readonly string[], action: ModifyAction, label?: string): Promise<{ readonly changed: number }>

/**
 * Start a Google sign-in for one account.
 * @param request - the account id, its policy when new, an address hint, and the origin Settings runs on.
 * @returns the consent page address.
 */
async beginSignIn(request: SignInRequest): Promise<{ readonly url: string; readonly redirectUri: string }>

/**
 * Finish a sign-in from Google's redirect.
 * @param answer - the redirect's `state`, `code`, and `error` parameters.
 * @returns the connected account.
 */
async completeSignIn(answer: SignInAnswer): Promise<AccountView>

/**
 * Disconnect an account: revoke its token at Google, delete it, and drop its held messages.
 * @param account - account id.
 */
removeAccount(account: string): Promise<void>

/**
 * Change an account's send policy.
 * @param account - account id.
 * @param policy - the new policy.
 */
setPolicy(account: string, policy: SendPolicy): Promise<void>

/**
 * Store the OAuth client from Google's downloaded JSON.
 * @param text - the JSON file's text.
 * @returns the client as Settings shows it.
 */
async setClient(text: string): Promise<ClientInfo>

/**
 * The OAuth client's state.
 * @returns whether it is set, and its id (not secret).
 */
async clientInfo(): Promise<ClientInfo>

/**
 * Everything Settings shows.
 * @returns a snapshot.
 */
async status(): Promise<GmailStatus>

/**
 * The held messages, oldest first.
 * @returns every message waiting for the owner.
 */
async held(): Promise<PendingRecord[]>
```

Types: [AccountView](credentials.zh.md)

Source: [`packages/fork/gmail/src/index.ts`](../../packages/fork/gmail/src/index.ts)

<a id="ctxownernotifier--ownernotifier"></a>

### `ctx.ownerNotifier` — `OwnerNotifier`

Notification actuator contract; a channel plugin provides it as `ctx.ownerNotifier`.

```ts cordis-catalog
/**
 * Deliver one message for the owner. A channel with a chat Session may hand it to the owner's main agent
 * instead, which decides whether and how to tell the owner; a `safety` note always goes to the owner as written.
 * @param note - title, optional body, optional link, and optional origin.
 * @returns resolves once the channel accepted the message; rejects on failure.
 */
send(note: OwnerNote): Promise<void>

/**
 * Pass a message from another of the agent's Sessions to the owner's main agent: the channel's
 * chat Session, which takes it up in a turn of its own once it is idle. That turn's answer reaches
 * the owner like any other chat answer. Channels without a chat Session omit it.
 * @param message - the text and who sent it.
 * @returns the chat Session the message was queued in.
 * @throws when there is no chat to pass it to or the Session refused the prompt.
 */
tellMainAgent?(message: MainAgentMessage): Promise<string>

/**
 * Whether the channel created this Session (e.g. its chat Session). Kept for callers outside the
 * bus; the bus asks `ctx.ownerRelay.ownerOf()` which Sessions a relay channel delivers itself.
 * @param sessionId - Session to check.
 * @returns true when the channel created this Session.
 */
ownsSession?(sessionId: string): boolean
```

Source: [`packages/fork/event-bus/src/types.ts`](../../packages/fork/event-bus/src/types.ts)

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

<a id="ctxpresence--presence"></a>

### `ctx.presence` — `Presence`

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
isUrgent(note: Pick<OwnerNote, 'urgent' | 'kinds'>): boolean

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
async ingest(event: BusEventInput): Promise<string>

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

Source: [`packages/fork/presence/src/index.ts`](../../packages/fork/presence/src/index.ts)

<a id="ctxqq--qqobserver"></a>

### `ctx.qq` — `QqObserver`

The observer. Provides `ctx.qq`, whose read methods the agent tools use. The recorded data lives in the qq-recorder service: every read of it is a request that fails with RecorderUnavailable while the recorder is down.

```ts cordis-catalog
/**
 * Every group the account is in, as the Settings page's group list offers them: the recorded ones first, then the
 * others by how many messages they showed since the recorder started.
 * @returns one entry per group, with the count of dropped messages (a number, nothing of them is kept).
 * @throws {@link RecorderUnavailable} while the recorder is down.
 */
async groupChoices(): Promise<Array<{ groupId: string; name: string; memberCount: number | null; recorded: boolean; seen: number }>>

/**
 * Every group the account is in, with what is recorded of it.
 * @returns recorded groups first, then the others.
 * @throws {@link RecorderUnavailable} while the recorder is down.
 */
async groupOverview(): Promise<GroupOverview[]>

/**
 * Display name of a group, from what the recorder last reported.
 * @param groupId - group number.
 * @returns the name, or the number when none is known yet.
 */
groupName(groupId: string): string

/**
 * A saved picture of a recorded group, for `qq_image` and the digest: the recorder serves the file it downloaded when the
 * message arrived. Nothing is fetched from QQ.
 * @param ref - the `m…` reference in a message's `[图片#ref]` tag.
 * @returns the bytes and their type.
 * @throws {@link RecorderUnavailable} while the recorder is down; {@link ImageNotSaved} when it does not hold the picture
 * (images off, never downloaded, aged out, recalled), and when the recorder is too old to serve pictures.
 */
async image(ref: string): Promise<{ bytes: Uint8Array; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; groupId: string }>

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
async groupNote(sessionId: string | undefined, groupId: string, op: string, text: string): Promise<ToolOutcome>

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
groupNotes(groupId: string): Array<{ id: number; text: string; createdAt: number }>

/**
 * Evidence for a claim about a group's chat, without exposing who said what: for each message id the group still
 * holds, a stable sender key (a salted hash of the member within this group, never the QQ number), its time, and its
 * stored one-line text, so a caller can check a quotation word for word.
 * @param groupId - group number; an unrecorded group yields nothing.
 * @param messageIds - OneBot message ids, at most 200 are looked at.
 * @returns one entry per message found: recorded, not recalled, and still inside the retention window.
 * @throws {@link RecorderUnavailable} while the recorder is down.
 */
async evidenceOf(groupId: string, messageIds: readonly string[]): Promise<Array<{ messageId: string; senderKey: string; at: number; text: string }>>

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
 * @throws {@link RecorderUnavailable} while the recorder is down.
 */
async recentMessages(groupId: string, options: { hours: number; limit: number; userId?: string }): Promise<MessageRow[]>

/**
 * Search the recorded groups' messages, newest first.
 * @param query - words to find.
 * @param options - one group, or all recorded groups, and at most `limit` matches.
 * @returns the matching messages.
 * @throws {@link RecorderUnavailable} while the recorder is down.
 */
async searchMessages(query: string, options: { groupId?: string; limit: number }): Promise<MessageRow[]>

/**
 * Newest digests of the recorded groups.
 * @param options - one group, or all recorded groups, a window in days, and at most `limit` digests.
 * @returns the digests, newest first.
 */
digests(options: { groupId?: string; days: number; limit: number }): DigestRow[]

/**
 * Delete stored digests: the observer's learned knowledge. Raw messages age out by themselves.
 * @param options - one group and/or those made before `beforeMs`; at least one is required.
 * @returns how many digests were deleted.
 */
async forgetDigests(options: { groupId?: string; beforeMs?: number }): Promise<number>

/**
 * Sending is not offered: the recorder has no send endpoint, and the channel is read-only.
 * @param groupId - group number.
 * @param _text - what to send.
 * @throws {@link SendRefused} always.
 */
sendGroupMessage(groupId: string, _text: string): Promise<void>

/**
 * Which optional capabilities of the recorder in front of this DSH are available: a recorder of an older minor version
 * lacks some, and only those features degrade.
 * @returns each feature of the protocol and whether the recorder offers it.
 */
features(): Record<string, boolean>

/**
 * The observer's connection to the protocol end, for the Settings page's QQ section: whether the socket is up,
 * since when, how many attempts have failed in a row, and why the last one did; or that the recorder itself is not there.
 * @returns the connection state; `selfId` is the logged-in account only while connected.
 */
connectionStatus(): QqConnection

/**
 * How many groups the observer records, for the Settings page's QQ section.
 * @returns the size of the configured `groups` list.
 */
recordedGroups(): number

/**
 * NapCat's login as the recorder's login door reports it, for the Settings page's QQ section.
 * @param options - `fresh` skips the recorder's shared answer.
 * @returns the reading; `door` says why there is no `state` when the door could not answer, or `recorder-down`.
 */
async loginStatus(options: { fresh?: boolean } = {}): Promise<QqLoginReading>

/**
 * Ask NapCat for a fresh login QR code through the recorder (it refuses while QQ is logged in and for ten minutes after
 * the connection came up).
 * @returns the reading after the request, whether the door passed the request on, and why not when it did not.
 */
async refreshLogin(): Promise<{ login: QqLoginReading; refreshed: boolean; reason: RefreshRefusal | null }>
```

Source: [`packages/fork/qq/src/index.ts`](../../packages/fork/qq/src/index.ts)

<a id="ctxqqbot--qqbotchannel"></a>

### `ctx.qqBot` — `QqBotChannel`

QQ channel. Connects the official bot to the QQ Open Platform, answers only the openids in `allow`, gives each private chat and each group its own chat Session, and delivers each turn's final answer that `ctx.ownerRelay` hands its `qqbot` channel. QQ lets a bot reply to a message within a window (about an hour in private chats, minutes in groups) and at most five times; later answers go out as proactive messages, and an answer QQ refuses falls back to `ctx.ownerNotifier` through the relay.

```ts cordis-catalog
/**
 * Whether this channel created a Session: true for every chat Session it remembers, all of which
 * it claims with `ctx.ownerRelay`.
 * @param sessionId - Session to check.
 * @returns true for the current and earlier chat Sessions of every peer.
 */
ownsSession(sessionId: string): boolean
```

Source: [`packages/fork/qqbot/src/index.ts`](../../packages/fork/qqbot/src/index.ts)

<a id="ctxspeakingstyle--styleservice"></a>

### `ctx.speakingStyle` — `StyleService`

DSH's speaking style: what the root row provides as `ctx.speakingStyle`.

```ts cordis-catalog
/**
 * Remember the text of a web search or fetch a Session just ran, for the miner (when mining is on).
 * @param text - the tool result's text; the query and URL never reach this.
 */
async feedWeb(text: string): Promise<void>

/** Stop a run in progress (its Bilibili reads end). */
dispose(): void

/**
 * Counts for the Settings overview, without any text; refreshed whenever the panel is read, after each run, and on the
 * schedule check.
 * @returns active and pending tone samples, the review mode, the last run's start, and the stock-line trend.
 */
health(): StyleHealth

/**
 * The block for a day.
 * @param day - `YYYY-MM-DD`, the rotation seed.
 * @param invite - invite the agent to write a card when there is none (its preset mounts `persona_update`).
 * @returns the block, its counts, and the card version it shows, or undefined when it is off or empty.
 */
async block(day: string, invite: boolean): Promise<StyleBlock | undefined>

/**
 * When the next scheduled run is due.
 * @returns epoch milliseconds; undefined while collection is off.
 */
async nextRunAt(): Promise<number | undefined>

/**
 * Run a collection and the meme miner when one is due and none is running.
 * @returns the tone collection's report, or undefined when nothing ran.
 */
async runIfDue(): Promise<RunReport | undefined>

/**
 * One meme-mining run over the public text of the last hours: QQ groups, Bilibili hot comments and hot-search words
 * (`ctx.biliHot`, absent until the bili package provides it), and the pages the main agent searched or fetched.
 * Nothing runs while mining is off or another run is going.
 * @returns the run's counts, or undefined when nothing ran.
 */
async mine(): Promise<MineReport | undefined>

/**
 * Everything the Settings section shows.
 * @returns the samples, notes, HotWatch's index, card versions, the last runs, the next run, and the trend.
 */
async panel(): Promise<StylePanel>

/**
 * Apply one edit the owner made on the Settings page. An owner's card edit, rollback, or deletion becomes the new
 * baseline and restarts the agent's revision wait.
 * @param input - `{ op: 'remove' | 'keep', id }`, `{ op: 'block', term }`, `{ op: 'card', card }`,
 * `{ op: 'rollback', version }`, or `{ op: 'deleteVersion', version }`, as the page sent it; validated here.
 * @returns the panel after the edit, or the refusal (`not_found`, `invalid_input`, `current_version`) with the unchanged panel.
 */
async edit(input: unknown): Promise<StyleEditAnswer>

/**
 * Start a tone collection and then a meme-mining run without waiting for them; the panel says `running` until they
 * end. Nothing runs while off.
 * @returns the panel right after the start.
 */
async collect(): Promise<StylePanel>

/**
 * A `style_note` call: the platform comes from the calling Session's preset, the example must appear verbatim in what
 * that Session just read (QQ messages shown to a digest Session, or the results of the public-text tools in its log),
 * every field passes the note filter, and the guard allows the whole note.
 * @param input - the calling Session (and its log) and preset, the kind, the term, the meaning, the example, and related memes.
 * @returns `recorded`, `refreshed`, or `rejected` with a reason code.
 */
async note(input: StyleNoteInput): Promise<WriteAnswer>

/**
 * A `meme_lookup` call: the groups' own memes first, then HotWatch.
 * @param term - the meme as the index lists it (or one of its `related` terms).
 * @returns the meaning and where it came from, or `found: false`.
 */
async lookup(term: string): Promise<LookupAnswer>

/**
 * A `persona_update` call: at most `persona.maxChars` characters, the note filter, the guard, and at least
 * `persona.minIntervalHours` since the last version (the agent's or the owner's; an owner edit on the Settings page
 * is never limited). The owner is told which version it became and how much changed, never the text, through
 * `ctx.ownerNotifier`, whose channel holds the notice while the owner sleeps.
 * @param input - the whole card, a one-line reason, and the writing Session.
 * @returns `recorded`, or `rejected` with a reason code.
 */
async updateCard(input: { readonly card: string; readonly reason: string; readonly sessionId?: string }): Promise<WriteAnswer>
```

Source: [`packages/fork/speaking-style/src/index.ts`](../../packages/fork/speaking-style/src/index.ts)

<a id="ctxvoice--voice"></a>

### `ctx.voice` — `Voice`

Service behind `ctx.voice`.

```ts cordis-catalog
/**
 * The switches and the endpoint of each service, for status pages. Keys and credential references are not included.
 * @returns snapshot of the configuration.
 */
describe(): VoiceSummary

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

Source: [`packages/fork/voice/src/index.ts`](../../packages/fork/voice/src/index.ts)
<!-- END GENERATED cordis-surface -->
