---
description: "Time check for every Session: an input that starts a turn after a quiet spell reaches the model with the current time, how long the Session was quiet, when the last exchange was, and the instruction to read it on its own terms and re-check outside state."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-time-gap

English | [中文](README.zh.md)

## Summary

A message that arrives after a long silence is not a quick follow-up, but its history does not show that to the model. When a prompt, an event, or a reminder starts a turn at least `thresholdMs` (5 minutes) after a Session's last activity, this package puts a short notice before it: the current time and zone, how long the Session was quiet, when the last exchange was, and that the input starts a new exchange. It covers Web UI chats, channel Sessions, bus and webhook deliveries, and reminders; the owner's WeChat messages keep [fork-wechat](../fork-wechat/README.md)'s own check.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount one row at the profile root, where its listener sees the steps of every agent preset. The fork event bundle mounts it with the defaults below; Settings → 订阅与监控 edits the row through the All settings card at the foot of the page, which saves to the owner's patch and reloads the plugin.

```yaml
- id: fork-time-gap
  name: '@deepseek-ai/dsh-fork-time-gap'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Add the notice at all; `false` registers nothing |
| `thresholdMs` | `300000` (5 minutes) | Shortest silence that counts as a quiet spell |
| `timeZone` | `America/New_York` | IANA zone of the times in the notice; an unknown zone fails the plugin at load |
| `excludePresets` | `qq-digest` | Agent presets whose Sessions never get the notice (the digest run's prompt carries its own time window) |
| `senderPresets` | `qqbot` | Agent presets whose prompts carry someone else's words, so the notice says "the sender" |
| `deferChannels` | `wechat` | Owner-relay channels that write their own time check before the owner's messages in the Sessions they claim |

### Which Sessions and inputs get it

The listener acts on the first step of a turn whose claimed messages include an incoming input, in a Session that is not a subagent's and whose preset is not excluded. The silence is measured from the later of the Session's last assistant message and its previous incoming input, both read from the Session log; a Session's first input has nothing to measure from and gets no notice. A message steered into a running turn joins work in progress, so later steps get none. The input that decides the wording is the first incoming one among the claimed messages, classified by its durable `source` and the Session header, never by its text:

| Source | Session | Wording |
|---|---|---|
| `user` (Web UI, channel prompts) | any preset not in `senderPresets` (Web UI chats, `unattended`, the `bili` account's messages from the owner's main account) | the owner |
| `user` | a preset in `senderPresets` (`qqbot`) | the sender |
| `user` with a `principal` (a guest) or a request id with fork-taint's `fork-untrusted:` prefix (another Session passing a message on) | any | the sender |
| `webhook` (bus batches, webhook rules), `fork-tool-monitor` | any | this event |
| `schedule` | any | this reminder |

Other sources (instructions, snapshots, other plugins' notices, this plugin's own notice) are context, not input: they neither start the count nor get a notice. An owner input in a Session that an owner-relay channel in `deferChannels` claims is left to that channel. `fork-wechat` claims its chat Sessions as `wechat` and writes its own notice before the owner's message, from its own records of what it last sent the owner (including notes from other Sessions that enter the chat Session only at its next turn); reminders, events, and messages another Session passes on in a WeChat chat Session still get this plugin's notice. Its threshold is `fork-wechat.timeGapMs`, which defaults to the same 5 minutes.

Each notice logs one info line, `fork-time-gap: Session <id>, <owner|sender|event|reminder> input after <gap> of silence`, with no message text; a deferred Session logs at debug level.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers a Session projection `forkTimeGap` (version 1) holding two times, `lastIncomingAt` (the latest `user/message` whose source is an incoming kind) and `lastReplyAt` (the latest `assistant/message`), so the gap survives restarts and replays without reading history. Its `agent/pre-step` listener awaits the projection, delegates with `next()`, and, on step 1 of an entering decision, measures the gap at `Date.now()`; the current step's messages are not yet in the log, so the state is the Session's history before them. The notice is inserted into the decision's messages just before the incoming input, with source `{ kind: 'fork-time-gap', form: 'notice', summary: 'Time check: <gap> since the last exchange' }`. A decision that already carries a `fork-time-gap` message gets no second one. The deferral reads `ctx.get('ownerRelay')?.ownerOf(sessionId)`; without `owner-relay` nothing is deferred.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin: configuration, projection, pre-step listener |
| [`src/notice.ts`](src/notice.ts) | Input classification, gap measurement, notice text |
| [`src/format.ts`](src/format.ts) | `formatStamp` and `formatGap`, shared with `fork-wechat` |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [WeChat channel](../fork-wechat/README.md) — the WeChat chat Session's own time check
- [Turn origin](../fork-taint/README.md) — the same source rules decide whose turn it is
- [Time context](../../context/time-context/README.md) — the upstream clock reading some presets also mount

-----

<a id="model-experience"></a>
## Model Experience

### Time check before an input after a quiet spell

#### What the model sees

One user-role notice, just before the incoming input of a turn's first step, when the Session was quiet for at least `thresholdMs`. The head names the input (`the owner sent the message below at`, `the sender sent the message below at`, `this event arrived at`, or `this reminder arrived at`); `<now>` and `<last>` are stamps such as `Sun 2026-11-01 11:05` in `<zone>`, `<gap>` reads like `12 min`, `3 h 5 min`, or `2 d 3 h`, and `<previous>` is `your own reply` or `an earlier input that got no reply`.

##### Verbatim text for a message from the owner or a sender

```markdown
Time check: the owner sent the message below at <now> (<zone>), after <gap> of silence in this Session. Before it, the last exchange here was <previous>, at <last>. Read the message on its own terms: it starts a new exchange unless it clearly refers back to something earlier. Things outside this conversation (files, processes, services, accounts, other people's messages) may have changed since then; check again before relying on what you saw earlier.
```

##### Verbatim text for an event or a reminder

```markdown
Time check: this event arrived at <now> (<zone>), after <gap> of silence in this Session. Before it, the last exchange here was <previous>, at <last>. Treat it as arriving now, not as part of the last exchange: what it concerns may have changed since then, so check the current state before acting on it.
```

#### Token effect

About 120 tokens for a message's notice and 90 for an event's or reminder's (about 500 and 350 characters), at most one per turn and only after a quiet spell; every notice stays in the history until compaction removes it.

#### KV Cache effect

Append-only: the notice joins the new turn after the cached history, and the system prompt and tool list never change, so a reusable prefix stays reusable.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Two thresholds for WeChat** — the owner's WeChat messages use `fork-wechat.timeGapMs` (Settings → 微信), not `thresholdMs`; both default to 5 minutes, and changing one does not change the other. One setting would need `fork-wechat` to hand its records to this plugin through a service.
- **Queued input** — an input queued behind a running turn (`mode: 'queue'`) is measured when its own turn starts, from the reply just before it, so a long wait in the queue shows no gap.
- **Owner or sender comes from the preset** — the owner typing in the Web UI into a Session of a `senderPresets` preset is called "the sender"; only the source and the preset are read, never the text.
- **Background-job notices** — `tool-jobs` completions and other plugins' notices are context, so a turn they start gets no notice.
