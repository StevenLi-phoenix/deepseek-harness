---
description: "Durable event bus for event-driven agent runs: dedupe, loop suppression, subscriptions from configuration or created by the agent at run time, coalescing windows, hourly rate limits, dispatch to a notifier or to new webhook Sessions, and reports of unattended reminder turns."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-event-bus

English | [中文](README.zh.md)

## Summary

Route events from sensors to a phone notification or a new unattended agent Session, through subscriptions that you write in the configuration or that the agent creates itself with `watch_create`. The bus drops duplicates and events the agent caused itself. It groups bursts into one batch and caps batches per hour, so a noisy repository never floods your phone or your model budget. State, including agent-created subscriptions, survives restarts. Session results and unattended reminder turns come back as one message with the final answer, and an answer of `NO_REPLY` sends nothing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the bus in a Web profile together with a sensor such as `@deepseek-ai/dsh-lsy-github-sensor`, a notifier such as `@deepseek-ai/dsh-lsy-wechat`, and, for Session subscriptions, the webhook runtime. Add `@deepseek-ai/dsh-lsy-tool-watch` to an agent preset so the agent manages subscriptions itself.

### When to choose it

Choose it when external events should wake an agent or a human without a person watching a dashboard. Avoid it for reminders inside one conversation; the Host schedule service already delivers those, and this bus only reports the result of unattended reminder turns.

### Minimal configuration

```yaml
- insert:
    - id: webhook-runtime
      name: '@deepseek-ai/dsh-webhook'
    - id: lsy-event-bus
      name: '@deepseek-ai/dsh-lsy-event-bus'
      config:
        webUrl: https://dsh.example.ts.net/
        suppress: { actors: [my-agent-bot], markers: ['Dsh-Agent:'] }
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
| `suppress.actors` / `suppress.markers` | `[]` | Agent identities and output markers whose events are dropped |
| `retainEvents` / `retainBatches` | `5000` / `1000` | Stored history; the oldest settled rows are pruned |
| `maxTextChars` | `4000` | Stored characters of each event's untrusted text |
| `notifySessionResult` | `true` | Send each bus-started Session's first-turn result to the notifier |
| `reportScheduledTurns` | `true` | Send the final answer of each unattended Host-schedule reminder turn to the notifier |
| `maxNoteEvents` | `10` | Events listed in one notify message |
| `webUrl` | unset | Web UI link attached to Session results |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lsy-event-bus) is the exhaustive source for every accepted field.

### Run-time subscriptions

`ctx.lsyEventBus` exposes the subscription store that `watch_create`, `watch_list`, and `watch_delete` use:

- `subscribe(subscription, { createdBy? })` — validates the rule exactly like a configuration row, stores it with `createdAt` and the creating Session, and returns its view. It rejects with `LsySubscriptionError` code `invalid_subscription`, or `duplicate_id` when the configuration or another stored subscription uses the id.
- `unsubscribe(id)` — returns `removed`, `not_found`, or `config_owned`; removal also drops that subscription's pending events and flush timer.
- `listSubscriptions()` — configuration rows first, then stored ones by creation time, each with `origin` (`config` or `agent`) and `status`: pending events, the armed flush time, batches in the last hour, and the last batch's time, status, Session outcome, and silent flag.

Matching, flushing, restart recovery, and the webhook Session rule all use the merged set.

### Result reports

When a bus-started Session ends its first turn, the bus records the outcome on the batch and sends the final assistant text to `ctx.lsyNotifier`. When a Host-schedule reminder (`source.kind: schedule`) starts a turn in a Session that the notifier does not relay itself (`ownsSession(sessionId)`), the bus sends that turn's final answer titled `⏰ <first line of the reminder prompt>`. In both cases a final answer of exactly `NO_REPLY` (`LSY_SILENT_REPLY`) sends nothing; a batch records `silent: true`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`publish()` stores each new `source:key` once in the `lsy_event_bus` storage domain. Events whose actor or text matches `suppress` are recorded as `suppressed`, events no subscription selects as `unmatched`, and the rest add one pending row per matching subscription and arm that subscription's flush timer. Subscriptions are the configuration rows plus the rows of the `subscriptions` table; `subscribe()` and `unsubscribe()` run on the same serialized storage chain as publishing and flushing. A flush checks the rolling hourly limit, writes one batch row, deletes the pending rows, and then calls the actuator, so a crash between the two drops a batch rather than repeating it. `notify` batches go to `ctx.lsyNotifier`; `session` batches go to `ctx.webhookRuntime.dispatch()` with kind `lsy-event`, and a rule registered by the bus rebuilds the Session request from the subscription. The bus follows `session/event` for those Sessions and reports the end of their first turn. It also follows `user/message` events whose source is `schedule` and reports the end of that turn, naming the reminder from the `reminder_prompt_json` or `reminders_json` line of the Host framing.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration, subscription store, flush timers, actuators, Session and reminder observation |
| [`src/validate.ts`](src/validate.ts) | Subscription validation shared by configuration and `subscribe()` |
| [`src/match.ts`](src/match.ts) | Glob matching and loop suppression |
| [`src/prompt.ts`](src/prompt.ts) | Session request, batch, result, and reminder message rendering; the silent reply |
| [`src/storage.ts`](src/storage.ts) | Storage-domain tables for events, pending rows, batches, and run-time subscriptions |

This is a fork-local package; [`../UPSTREAM.md`](../UPSTREAM.md) describes how the `lsy` group tracks upstream. `@deepseek-ai/dsh-lsy-wechat` imports `LSY_SILENT_REPLY`, `isSilentReply()`, and `LsyNotifier.ownsSession()`, so they stay stable.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Watch tools](../lsy-tool-watch/README.md) — the agent creates and deletes subscriptions
- [Webhook runtime](../../experimental/webhook/README.md) — creates the Sessions
- [Storage domain](../../storage/storage-domain/README.md) — durable tables
- [Permission presets](../../interaction/permission-presets/README.md) — unattended access levels

-----

<a id="model-experience"></a>
## Model Experience

### Session prompt

#### What the model sees

Each Session started by a `session` subscription receives one user message: the subscription's trusted `instructions`, a sentence that labels the event data as untrusted, the subscription id, the event count, and one line of JSON with at most `maxPromptEvents` events whose text is cut to `maxTextChars`. The bus adds nothing to reminder turns; it only reads their final answer.

#### Token effect

One data-dependent user message per started Session, bounded by the two limits above.

#### KV Cache effect

The message opens a new Session, so it establishes rather than invalidates that Session's reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **At-most-once dispatch** — a crash between recording a batch and calling its actuator drops that batch.
- **Turn reports are in memory** — a restart while a bus-started Session or a reminder turn runs loses that turn's report.
- **Reminder names come from the Host framing** — if the schedule message format changes, reports fall back to `⏰ Session <id>`.
- **No Web link to one Session** — results link to the Web root; the client has no per-Session URL.
- **Whole-domain rewrites** — the JSON storage backend rewrites the domain on each write; keep retention bounded.
