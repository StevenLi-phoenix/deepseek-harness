---
description: "Durable event bus for event-driven agent runs: dedupe, loop suppression, subscriptions from configuration or created at run time, coalescing, hourly rate limits, dispatch to a notifier, to new webhook Sessions, or to one persistent Session per subscription, and reports of unattended turns."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-event-bus

English | [中文](README.zh.md)

## Summary

Route events from sensors to a phone notification or a new unattended agent Session, through subscriptions written in the configuration or created by the agent with `watch_create`. The bus drops duplicates and events the agent caused itself, batches bursts, and caps batches per hour. State survives restarts. A subscription can keep one persistent Session, per subscription or per subject, renewed monthly from its summary. Session results and unattended reminder turns return as one message, and `NO_REPLY` sends nothing. Chat Sessions idle for a week are archived, never deleted; running, pinned, persistent, and owner-channel Sessions stay.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the bus in a Web profile together with a sensor such as `@deepseek-ai/dsh-fork-github-sensor`, a notifier such as `@deepseek-ai/dsh-fork-wechat`, and, for Session subscriptions, the webhook runtime. Add `@deepseek-ai/dsh-fork-tool-watch` to an agent preset so the agent manages subscriptions itself.

### When to choose it

Choose it when external events should wake an agent or a human without a person watching a dashboard. Avoid it for reminders inside one conversation; the Host schedule service already delivers those, and this bus only reports the result of unattended reminder turns.

### Minimal configuration

```yaml
- insert:
    - id: webhook-runtime
      name: '@deepseek-ai/dsh-webhook'
    - id: fork-event-bus
      name: '@deepseek-ai/dsh-fork-event-bus'
      config:
        webUrl: https://dsh.example.ts.net/
        suppress: { actors: ['my-agent-app[bot]'] }
        subscriptions:
          - id: releases
            kinds: [github.release, github.tag]
            action: notify
          - id: triage
            kinds: [github.notification.*]
            action: session
            coalesceMs: 300000
            maxPerHour: 4
            session:
              workspacePath: /Users/dsh-runtime/work
              agentPreset: unattended
              permissionPreset: danger-full-access
              instructions: Triage these notifications and tell me what needs my attention.
```

`subscriptions` may stay empty when the agent creates them at run time.

| Field | Default | Meaning |
|---|---|---|
| `subscriptions` | `[]` | Routing rules owned by the configuration; the agent adds more at run time |
| `subscriptions[].sources` / `kinds` / `subjects` | `[]` | Case-insensitive `*` globs; an empty list matches everything |
| `subscriptions[].action` | required | `notify` or `session` |
| `subscriptions[].coalesceMs` | `60000` | Window after the first pending event that later events join |
| `subscriptions[].maxPerHour` | `12` | Batches per rolling hour; later ones wait |
| `subscriptions[].session` | required for `session` | Absolute `workspacePath`, `instructions`, presets, prompt bounds |
| `subscriptions[].session.persistent.enabled` | `false` | One Session for every batch of the subscription instead of one per batch (configuration rows only) |
| `subscriptions[].session.persistent.rolloverDays` | `30` | Days after which the next batch starts a new Session seeded with the old one's last compaction summary, and the old one is archived |
| `subscriptions[].session.persistent.maxSeedChars` | `20000` | Characters of the carried-over summary |
| `subscriptions[].session.persistent.key` | `subscription` | `subscription` keeps one Session for the subscription; `subject` keeps one per event subject (a repository, a video), each titled `<titlePrefix>: <subject>`, and splits a batch by subject |
| `subscriptions[].session.project` | unset | Web UI project title of `workspacePath`: before a Session starts there, the bus creates the directory and registers it as a project, unless one exists (an existing project keeps its title) |
| `suppress.actors` / `suppress.markers` | `[]` | Agent identities and output markers whose events are dropped; prefer identities, which the host sets, over markers, which depend on what the model writes; the fork event bundle sets `actors` to the GitHub App login `dsh-events[bot]` |
| `retainEvents` / `retainBatches` | `5000` / `1000` | Stored history; the oldest settled rows are pruned |
| `flowChangesKept` | `200` | Changes of the notification flow kept for `flow_read` and the message flow page |
| `maxTextChars` | `4000` | Stored characters of each event's untrusted text |
| `notifySessionResult` | `true` | Send each bus-started Session's first-turn result to the notifier |
| `reportScheduledTurns` | `true` | Send the final answer of each unattended Host-schedule reminder turn, and of each turn a `fork-tool-monitor` notice wakes (titled 📡 with the monitor), to the notifier |
| `maxNoteEvents` | `10` | Events listed in one notify message; the message also carries the kinds of all the batch's events (`ForkNote.kinds`), which a channel that holds back messages while the owner sleeps matches against its urgent kinds |
| `webUrl` | unset | Web UI link attached to Session results |
| `autoArchive.enabled` | `true` | Archive chat Sessions that nobody touched for a while (see [Auto-archive](#auto-archive)); archive only, never delete |
| `autoArchive.inactiveDays` | `7` | Days since a Session's last prompt before it is due |
| `autoArchive.dryRun` | `false` | Select and log, but archive nothing |
| `autoArchive.maxPerSweep` | `50` | Most Sessions one sweep archives; the rest wait for the next |
| `autoArchive.firstSweepMinutes` / `sweepHours` | `10` / `6` | Minutes from start to the first sweep, then hours between sweeps |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-fork-event-bus) is the exhaustive source for every accepted field.

### Run-time subscriptions

`ctx.forkEventBus` exposes the subscription store that `watch_create`, `watch_list`, and `watch_delete` use:

- `subscribe(subscription, { createdBy? })` — validates the rule exactly like a configuration row, stores it with `createdAt` and the creating Session, and returns its view. It rejects with `ForkSubscriptionError` code `invalid_subscription`, or `duplicate_id` when the configuration or another stored subscription uses the id.
- `unsubscribe(id)` — returns `removed`, `not_found`, or `config_owned`; removal also drops that subscription's pending events and flush timer.
- `setPaused(id, paused)` — pauses or resumes a run-time subscription (`ok`, `not_found`, or `config_owned`). A paused one matches no new events (they are `unmatched` for it) and holds its pending events until it resumes; the view carries `paused: true` and the flag is stored. Settings → Subscriptions and monitors (`fork-console`) uses it.
- `stats()` — subscription, paused, and pending counts, plus events and batches in the last hour and flushes held back by an hourly limit since the bus started.
- `listSubscriptions()` — configuration rows first, then stored ones by creation time, each with `origin` (`config` or `agent`) and `status`: pending events, the armed flush time, batches in the last hour, and the last batch's time, status, Session outcome, and silent flag.

Matching, flushing, restart recovery, and the webhook Session rule all use the merged set.

### Notification flow

`flowRoutes()` lists every route, whichever origin it has, with where a Session route's answer goes (`result`) and which routes take it (`downstream`). `editFlow()` changes one at run time: `set` changes fields or creates the route, `remove` takes it out, `reset` puts a configuration route back as written, and `pause` and `resume` stop and restart it. A configuration route keeps its row and the change is stored over it, so a restart or a deploy keeps the change. `flowHistory()` holds the latest 200 changes with the route before and after.

`session.result` says where an answer goes: `notify` (the default, or `quiet` for a `quietResult` row), `urgent` (a note past do-not-disturb), `main` (the owner's main agent), `quiet`, or `event`. An `event` answer is published with source `flow` and kind `flow.<route id>.result`, and any route naming them takes it, so routes chain; `NO_REPLY` stops it. `editFlow()` refuses a loop with `ForkFlowError`, and an answer nothing can take goes to the notifier instead.

### Persistent Sessions

With `session.persistent.enabled`, the first batch creates the subscription's Session through the webhook runtime as usual, and the bus stores its id in the `persistent` table once the Session's first message arrives. Each later batch enters that Session as a new turn (`Agent.followup()` through `ctx.sessionController.resolveAgent()`), with the same prompt text and the same message source a new Session's first message has (`webhook`, provider `fork-event`, the batch id as delivery id), so turn-origin checks such as fork-taint's treat both alike. The preset owns compaction (`dsh-compaction-basic`'s `thresholdRatio`); the bus keeps the text of the Session's latest `compaction/summary` and counts compactions.

- **Gone** — a stored Session that is not found or is archived is forgotten, and the batch starts a new one.
- **Unavailable** — when the Session cannot take a turn now (a writer is held, the controller is missing), the batch gets a one-off Session (`detached`) and the stored one stays.
- **Rollover** — once the stored Session is `rolloverDays` old, the next batch starts a new Session whose first message carries the last compaction summary as `previous_summary_json`, labeled untrusted-derived data. When that Session's first message arrives it becomes the subscription's Session, and the old one is archived with `ctx.workspaceRegistry.archiveSession()`: DSH has no Session deletion, and the archive keeps the log readable and blocks further model steps.

With `key: subject` the bus keeps one Session per event subject instead: it splits a batch by subject into child batch rows (which do not count against `maxPerHour`), each continuing its subject's Session, stored under `<subscription>|<subject>` and titled `<titlePrefix>: <subject>`. A persistent Session's title is fixed (`titlePrefix`, or the subscription id), not rebuilt from the events of each batch. `ensureProject(path, name)` creates a project directory and registers it in the Web UI once; the bus calls it for `session.project`, and other plugins may call it through `ctx.forkEventBus.ensureProject()`.

`persistentSessions()` lists each subscription's Session (id, start time, batches, compactions, the Session it replaced), and `persistentSubscriptionOf(sessionId)` names the subscription whose current Session that is; fork-tool-up asks it before a channel note or an evidence lookup. Each batch's record carries `delivery`: `fresh`, `persistent-new`, `persistent`, `rollover`, or `detached`.

<a id="auto-archive"></a>
### Auto-archive

Every `sweepHours` hours the bus lists the Host's Sessions (`ctx.sessionController.list()`) and archives those whose last prompt is older than `inactiveDays` (a cold Session the list has no activity metadata for is dated by its log file's last write), through `ctx.workspaceRegistry.archiveSession()`. That is the Host's own archive: it asks every `workspace/session-activity` provider first and refuses a Session with a running turn, agent, job, or scheduled reminder (counted as `active`), it never deletes, and an archived Session comes back with one click in the Web UI. Each sweep logs its counts, the archived ids, and the skips by reason, and keeps the last report and the 200 most recently archived Sessions (stored in the `fork_event_bus_archive` domain) for `archiveStatus()` and Settings → Subscriptions and monitors.

A Session is left alone, and counted under that reason, when it is `recent`, of `unknown` activity (the Host lists it without activity metadata and its log's last write cannot be read either), a `subagent`'s, `running`, `pinned`, a subscription's `persistent` Session, the creator of a run-time subscription or watch (`subscription`), or claimed by a plugin. Plugins claim their own Sessions with `protectSessions(label, check)`; `check({ id, updatedAt, cwd, title })` returns `true` (or a reason) to keep one, a throw keeps it, and the returned function withdraws the claim. `fork-wechat` claims the owner's current chat Session (`wechat`), `fork-qqbot` its peers' current chat Sessions (`qqbot`), and `fork-qq` the groups' resident digest Sessions (`qq`). Register inside an effect that injects `forkEventBus`, so a reload of the bus or the plugin withdraws the claim.

When a conversation continues in a new Session (WeChat `/new`), `handOverSessions(from, to)` moves what the earlier Sessions own: the run-time subscriptions they created name `to` as creator (so the `subscription` protection and the creator Settings shows follow), then every mover registered with `registerHandover(kind, move)` moves its own bindings and returns them as `{ id, label }` items (`fork-tool-monitor` registers `monitor`). The answer lists the moved items by kind and the movers that failed; a failing mover is logged and the others still run, and every mover must be idempotent so the caller can retry. Register inside an effect that injects `forkEventBus`, like a protection.

- `archiveStatus()` — the settings, `nextSweepAt`, the protector labels, the last sweep's report, and the recently archived Sessions (newest first).
- `sweepArchive({ dryRun? })` — one sweep now (the Settings buttons); it joins a sweep that is already running, and `dryRun` only lists what would be archived.

### Result reports

When a bus-started Session ends its first turn, or a persistent Session ends a batch's turn, the bus records the outcome on the batch, logs the subscription, Session, delivery, the last request's input tokens, whether compaction ran, and the turn's tool calls by name, and sends the final assistant text to `ctx.forkNotifier`, titled with the batch title: one event names itself, several name their subject and count (`ci: octo/repo (3 events)`), never one event's title. A completed turn carries no mark; a turn that ended otherwise is titled `⚠️ <title> (<outcome>)`. When a Host-schedule reminder (`source.kind: schedule`) starts a turn in a Session that no channel of [`ctx.ownerRelay`](../owner-relay/README.md) claimed (`ownerOf(sessionId)` is `undefined`), the bus sends that turn's final answer titled `⏰ <task title>`: the title `ctx.schedule.view()` gives for the framing's `schedule_id` when the turn starts (a batch adds `(+N)`), `⏰ 定时任务` when the task cannot be read. The reminder prompt never goes into the report: it is the agent's instruction. In both cases a final answer of exactly `NO_REPLY` (`FORK_SILENT_REPLY`) sends nothing; a batch records `silent: true`. A turn the owner stopped (ended `aborted` with cause `user`, from the Web UI or WeChat `/stop`) is recorded but not reported, since whoever stopped it already knows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`publish()` stores each new `source:key` once in the `fork_event_bus` storage domain. Events whose actor or text matches `suppress` are recorded as `suppressed`, events no subscription selects as `unmatched`, and the rest add one pending row per matching subscription and arm that subscription's flush timer. Subscriptions are the configuration rows plus the rows of the `subscriptions` table; `subscribe()` and `unsubscribe()` run on the same serialized storage chain as publishing and flushing. A flush checks the rolling hourly limit, writes one batch row, deletes the pending rows, and then calls the actuator, so a crash between the two drops a batch rather than repeating it. `notify` batches go to `ctx.forkNotifier`; `session` batches go to `ctx.webhookRuntime.dispatch()` with kind `fork-event`, and a rule registered by the bus rebuilds the Session request from the subscription. The bus follows `session/event` for those Sessions and reports the end of their first turn. It also follows `user/message` events whose source is `schedule` and reports the end of that turn, naming the reminder from the `reminder_prompt_json` or `reminders_json` line of the Host framing.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration, subscription store, flush timers, actuators, Session and reminder observation |
| [`src/validate.ts`](src/validate.ts) | Subscription validation shared by configuration and `subscribe()` |
| [`src/match.ts`](src/match.ts) | Glob matching and loop suppression |
| [`src/prompt.ts`](src/prompt.ts) | Session request, batch, result, and reminder message rendering; the silent reply |
| [`src/storage.ts`](src/storage.ts) | Storage-domain tables for events, pending rows, batches, run-time subscriptions, and persistent Sessions |
| [`src/archive.ts`](src/archive.ts) | Auto-archive: the sweep timer, the selection rules, the protector registry, and the recently archived table |

This is a fork-local package; [`../UPSTREAM.md`](../UPSTREAM.md) describes how the `fork` group tracks upstream. `@deepseek-ai/dsh-owner-relay` imports `isSilentReply()` and `failureDetail()`, and `@deepseek-ai/dsh-fork-tool-watch` calls `ForkNotifier.ownsSession()`, so they stay stable. Because the relay depends on this package, the bus reads `ctx.ownerRelay` through a structural `ownerOf()` view instead of importing it. A note's optional `origin` names its sender for the channel's copy in the owner's chat Session and is never shown to the owner; a message for the main agent has its own optional `origin` token (`bili`, `cc`) that goes into the request id of the prompt the channel queues, so the Host can tell the turn it starts from one the owner started. `ForkNotifier.tellMainAgent()` is optional and the bus never calls it: a channel with a chat Session (fork-wechat) implements it so that another Session (dsh-bili's) can hand the owner's main agent a message.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Watch tools](../fork-tool-watch/README.md) — the agent creates and deletes subscriptions
- [Webhook runtime](../../experimental/webhook/README.md) — creates the Sessions
- [Basic compaction](../../compaction/compaction-basic/README.md) — compacts a persistent Session; its summary seeds the next one
- [Creator tools](../fork-tool-up/README.md) — the tools of the persistent `bili-digest` Session
- [Storage domain](../../storage/storage-domain/README.md) — durable tables
- [Permission presets](../../interaction/permission-presets/README.md) — unattended access levels

-----

<a id="model-experience"></a>
## Model Experience

### Session prompt

#### What the model sees

A subscription with `session.quietResult` records its Session's outcome and sends no result note. Each Session started by a `session` subscription receives one user message: the subscription's trusted `instructions`, a sentence that labels the event data as untrusted (or, when the subscription's `session.trustedText` is set because only the owner can publish to its sources, one that presents each event's text as the owner's request), the subscription id, the event count, and one line of JSON with at most `maxPromptEvents` events whose text is cut to `maxTextChars`. The bus adds nothing to reminder turns; it only reads their final answer. A configuration row may also set `session.model` (`{ provider, model }`, a registered `llm-pi-ai` route) to run its Sessions on that route instead of the profile's default; the Session then runs without the default's reasoning effort, and run-time subscriptions made with `subscribe()` cannot set it. A persistent subscription sends the same message as each later batch's turn; the first message after a rollover also carries the old Session's last compaction summary as one JSON line labeled untrusted-derived data, before the events.

#### Token effect

One data-dependent user message per batch, bounded by the two limits above, plus at most `maxSeedChars` of summary after a rollover. A persistent Session grows with every batch until its preset compacts it.

#### KV Cache effect

A message that opens a new Session establishes its reusable prefix; a batch turn of a persistent Session is appended after the existing prefix and does not invalidate it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **At-most-once dispatch** — a crash between recording a batch and calling its actuator drops that batch.
- **Turn reports are in memory** — a restart while a bus-started Session or a reminder turn runs loses that turn's report.
- **No Session deletion** — a rolled-over persistent Session is archived, not deleted; its log stays on disk until the owner deletes it.
- **Auto-archive reads every Session summary** — a sweep lists all Sessions the Host knows; with tens of thousands it takes seconds, which is why it runs every six hours rather than often.
- **Persistent Sessions are never swept** — a subscription's persistent Session (one per subject with `key: subject`) stays until its rollover; a repository that never runs CI again keeps its Session in the sidebar.
- **Rollover seed** — a Session that never compacted hands over nothing but its id; the summary of a compaction that ran while the bus was not running is not seen.
- **Reminder names come from the Host framing's task ids** — if the schedule message format changes, reports fall back to `⏰ Session <id>`.
- **No Web link to one Session** — results link to the Web root; the client has no per-Session URL.
- **Whole-domain rewrites** — the JSON storage backend rewrites the domain on each write; keep retention bounded.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Only the first turn of a bus-started Session, the batch turns of a persistent Session, unattended reminder turns, and turns a monitor wakes are reported; other later turns of the same Session reach the owner only through the Web UI.

</details>
