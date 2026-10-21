---
description: "Durable event bus for event-driven agent runs: dedupe, loop suppression, user-authored subscriptions, coalescing windows, hourly rate limits, and dispatch to a notifier or to new webhook Sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-event-bus

English | [中文](README.zh.md)

## Summary

Route events from sensors to a phone notification or a new unattended agent Session, but only through subscriptions you wrote. The bus drops duplicates and events the agent caused itself. It groups bursts into one batch and caps batches per hour, so a noisy repository never floods your phone or your model budget. State survives restarts. Session results come back as one message with the final answer.

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

Mount the bus in a Web profile together with a sensor such as `@deepseek-ai/dsh-lsy-github-sensor`, a notifier such as `@deepseek-ai/dsh-lsy-telegram`, and, for Session subscriptions, the webhook runtime.

### When to choose it

Choose it when external events should wake an agent or a human without a person watching a dashboard. Avoid it for reminders inside one conversation; the Host schedule service already delivers those.

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

| Field | Default | Meaning |
|---|---|---|
| `subscriptions` | `[]` | Routing rules; only these start actuators |
| `subscriptions[].sources` / `kinds` / `subjects` | `[]` | Case-insensitive `*` globs; an empty list matches everything |
| `subscriptions[].action` | required | `notify` or `session` |
| `subscriptions[].coalesceMs` | `60000` | Window after the first pending event that later events join |
| `subscriptions[].maxPerHour` | `12` | Batches per rolling hour; later ones wait |
| `subscriptions[].session` | required for `session` | Absolute `workspacePath`, `instructions`, presets, prompt bounds |
| `suppress.actors` / `suppress.markers` | `[]` | Agent identities and output markers whose events are dropped |
| `retainEvents` / `retainBatches` | `5000` / `1000` | Stored history; the oldest settled rows are pruned |
| `maxTextChars` | `4000` | Stored characters of each event's untrusted text |
| `notifySessionResult` | `true` | Send each bus-started Session's first-turn result to the notifier |
| `maxNoteEvents` | `10` | Events listed in one notify message |
| `webUrl` | unset | Web UI link attached to Session results |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidshlsy-event-bus) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`publish()` stores each new `source:key` once in the `lsy_event_bus` storage domain. Events whose actor or text matches `suppress` are recorded as `suppressed`, events no subscription selects as `unmatched`, and the rest add one pending row per matching subscription and arm that subscription's flush timer. A flush checks the rolling hourly limit, writes one batch row, deletes the pending rows, and then calls the actuator, so a crash between the two drops a batch rather than repeating it. `notify` batches go to `ctx.lsyNotifier`; `session` batches go to `ctx.webhookRuntime.dispatch()` with kind `lsy-event`, and a rule registered by the bus rebuilds the Session request from the subscription. The bus follows `session/event` for those Sessions and reports the end of their first turn.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration, flush timers, actuators, Session observation |
| [`src/match.ts`](src/match.ts) | Glob matching and loop suppression |
| [`src/prompt.ts`](src/prompt.ts) | Session request, batch message, and result message rendering |
| [`src/storage.ts`](src/storage.ts) | Storage-domain tables for events, pending rows, and batches |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Webhook runtime](../../experimental/webhook/README.md) — creates the Sessions
- [Storage domain](../../storage/storage-domain/README.md) — durable tables
- [Permission presets](../../interaction/permission-presets/README.md) — unattended access levels

-----

<a id="model-experience"></a>
## Model Experience

### Session prompt

#### What the model sees

Each Session started by a `session` subscription receives one user message: the subscription's trusted `instructions`, a sentence that labels the event data as untrusted, the subscription id, the event count, and one line of JSON with at most `maxPromptEvents` events whose text is cut to `maxTextChars`.

#### Token effect

One data-dependent user message per started Session, bounded by the two limits above.

#### KV Cache effect

The message opens a new Session, so it establishes rather than invalidates that Session's reusable prefix.

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **At-most-once dispatch** — a crash between recording a batch and calling its actuator drops that batch.
- **No Web link to one Session** — results link to the Web root; the client has no per-Session URL.
- **Whole-domain rewrites** — the JSON storage backend rewrites the domain on each write; keep retention bounded.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md) for how the `lsy` group tracks upstream.

</details>
