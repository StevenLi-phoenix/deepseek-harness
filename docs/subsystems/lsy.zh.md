# lsy 事件服务（fork 本地）

[English](lsy.md) | 中文

事件驱动 agent 背后的 fork 本地服务：[`@deepseek-ai/dsh-lsy-event-bus`](../../packages/lsy/lsy-event-bus/README.zh.md) 把传感器事件路由成通知或无人值守的 Session，[`@deepseek-ai/dsh-lsy-github-sensor`](../../packages/lsy/lsy-github-sensor/README.zh.md) 轮询 GitHub，[`@deepseek-ai/dsh-lsy-wechat`](../../packages/lsy/lsy-wechat/README.zh.md) 通过微信提供 `lsyNotifier` 契约。行为、配置与限制见各包 README；[上游账本](../../packages/lsy/UPSTREAM.md)记录 fork 如何跟踪上游。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * @param meta - provenance, e.g. the creating Session.
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
