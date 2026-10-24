---
description: "One relay of a Session's final answer to the owner (ctx.ownerRelay): channels such as the WeChat chat and the Bilibili account's messages claim their Sessions, one rule set decides at each turn end, an answer a channel cannot deliver falls back to ctx.lsyNotifier labelled with its origin, and the event bus skips claimed Sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-owner-relay

English | [中文](README.zh.md)

## Summary

One place decides what you hear when one of your agent's Sessions finishes a turn. Channels such as the WeChat chat and the Bilibili account's messages claim the Sessions they carry; at every turn end the relay applies the same rules (a turn you stopped or an exact `NO_REPLY` sends nothing, an unfinished turn adds a warning with its reason) and hands the answer to the claiming channel. An answer a channel cannot deliver comes to WeChat instead, labelled with where it came from, and the event bus never reports a claimed Session a second time.

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

Mount the relay at the root of the profile, before the plugins that use it. It needs no other service and has no configuration; it reads `ctx.lsyNotifier` (from [`@deepseek-ai/dsh-lsy-wechat`](../lsy-wechat/README.md)) only when a fallback needs it. The lsy event bundle mounts it right before the event bus.

```yaml
- id: owner-relay
  name: '@deepseek-ai/dsh-owner-relay'
```

### When to choose it

Choose it when a plugin owns Sessions whose final answers should reach the owner over a channel of its own. Avoid it for reports about Sessions no channel claims (the event bus's result and reminder notes) and for notices that are not a turn's answer (a login or risk-control notice): send those to `ctx.lsyNotifier` directly.

### The rules

The relay keeps the latest assistant text of each claimed Session (text parts only) and decides when the turn ends:

| Turn end | What the claiming channel gets |
|---|---|
| `aborted` with cause `user` (WeChat `/stop`, the Web UI's stop) | Nothing: the owner already knows |
| Final text exactly `NO_REPLY` | Nothing |
| `completed` with text | The text |
| `completed` without text | Nothing |
| Any other end (`error`, `aborted` for another cause, `max-tokens`, `interrupted`) | The text, if any, then `⚠️ 本轮未完成（<kind>）`, plus `原因：<code>: <message>` under it for an `error` |

### The service

| Member of `ctx.ownerRelay` | Meaning |
|---|---|
| `registerChannel(channel)` | Adds a channel; returns a disposer that removes it and releases every Session it claimed. A second channel of the same name throws. |
| `claim(sessionId, channelName)` | That channel relays the Session's turns from now on; a claim by another channel moves to it. |
| `release(sessionId)` | Stops relaying the Session; returns whether it was claimed. |
| `ownerOf(sessionId)` | The claiming channel's name, or `undefined`. |

A channel (`RelayChannel`) has a `name`, `deliver(answer)`, the optional hooks `onTurnStart`, `onTurnEnd`, and `onTurnSettled`, and an optional `fallbackLabel`. The answer carries `sessionId`, `text` (what the owner gets), `outcome`, and `detail` (the failure reason). `deliver` resolves `sent` (sent or durably queued) or `kept` (the channel chose not to send, such as a Bilibili turn no wake started) and rejects when it could not deliver. The relay calls `onTurnStart` at `turn/start`; at `turn/end` it calls `onTurnEnd(sessionId, ended)`, then `deliver` in the same tick, then `onTurnSettled` once `deliver` and any fallback finished. With nothing to send, `onTurnSettled` follows `onTurnEnd` at once. `ended` is the relay's decision for the turn: `answer` (a `deliver` follows), `silent` (the final text is `NO_REPLY`), `stopped` (the owner stopped the turn), or `empty` (a completed turn without text), so a channel that tracks state per turn knows how it ended even when nothing is delivered.

When `deliver` rejects, the relay sends `ctx.lsyNotifier` the note `↪️ 这条回答没能从原渠道发出，改发这里`: the answer, `原因：<error>` under it, and the channel's `fallbackLabel` as the note's `origin`, which the WeChat chat Session's copy names as its sender. A channel without a label is the notifier's own, so its failure is only logged.

Claims live in memory. Each channel claims its stored Sessions again when it registers, claims a new Session before its first prompt, and loses its claims when it unregisters. The lsy event profile has two channels:

| Channel | Plugin | Claims | Delivers | `fallbackLabel` |
|---|---|---|---|---|
| `wechat` | `@deepseek-ai/dsh-lsy-wechat` | Every chat Session it remembers (current and earlier ones) | A WeChat reply; an earlier chat Session's answer is also copied into the current one | None: it is the notifier |
| `bili-dm` | `@deepseek-ai/dsh-bili` | The account's Sessions | Bilibili messages for a turn a wake started (`kept` otherwise, and `kept` for an answer the watch floor holds back while the wake keeps browsing); what cannot go out goes to WeChat with its reason and the label | `the Bilibili account's Session (its answer could not go out as a Bilibili message)` |

`@deepseek-ai/dsh-lsy-event-bus` asks `ownerOf()` before it follows a reminder or monitor turn, so a claimed Session's turn reaches the owner once, through its channel.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`OwnerRelay` is a Cordis service (`ctx.ownerRelay`) that listens to `session/event` and ignores every Session nobody claimed. For a claimed Session it stores the latest `assistant/message` text (`contentText`: text parts joined, a message without text keeps the previous one) and, at `turn/end`, takes it and applies `decideRelay`. The hooks are called synchronously from the event, each inside its own `try`, so a failing hook is logged and never stops the relay; `deliver` is called before the first `await`, which lets a channel read per-turn state that `onTurnEnd` just set; `onTurnEnd` receives `decision.kind` as its second argument. Deliveries run in the background and teardown waits for them. A Session claimed by a channel that is not registered is logged and skipped.

Every decision is logged at info level with the Session id and the reason, never the text: `owner-relay: Session <id> ended a turn (<outcome>); relaying <n> chars through <channel>`, the reason nothing is relayed (`the owner stopped`, `that answered NO_REPLY`, `without text`), and `<channel> sent` or `kept the answer`. A rejected delivery and every fallback outcome are logged at warn or info.

The relay depends on `@deepseek-ai/dsh-lsy-event-bus` for `failureDetail`, `isSilentReply`, and the `LsyNotifier` contract, so the bus reads `ctx.ownerRelay` through a structural `ownerOf()` view instead of importing this package. `@deepseek-ai/dsh-lsy-wechat` and `@deepseek-ai/dsh-bili` import its types only and register through an `inject: ['ownerRelay']` child plugin; `bili`, which has a browser half, keeps it a development dependency.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The service: channels, claims, the event follower, delivery, fallback, and logs |
| [`src/rules.ts`](src/rules.ts) | Pure rules: `contentText`, `decideRelay`, and the fallback note |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md). Unit tests drive the service with channel doubles; the lsy-wechat, lsy-event-bus, and bili tests mount it with the real plugins.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [WeChat channel](../lsy-wechat/README.md) — the `wechat` channel and `ctx.lsyNotifier`
- [Bilibili account](../bili/README.md) — the `bili-dm` channel
- [Event bus](../lsy-event-bus/README.md) — reports for Sessions no channel claims

-----

<a id="model-experience"></a>
## Model Experience

### Fallback note

#### What the model sees

The relay adds nothing to the Sessions whose answers it relays; it only reads their events. An answer that falls back reaches the owner's WeChat chat Session as a shared note (from `@deepseek-ai/dsh-lsy-wechat`), dated with its send time and framed with the channel's `fallbackLabel` instead of the generic other-session wording, so the chat agent knows where a message the owner answers came from.

##### Shared fallback note

```markdown
At Fri 2026-10-23 19:42 (America/New_York), the Bilibili account's Session (its answer could not go out as a Bilibili message) sent the owner this message on WeChat. It is context, not the owner speaking: the owner may reply to it in this chat.
↪️ 这条回答没能从原渠道发出，改发这里

魔女，这只猫自己学会开门了 https://www.bilibili.com/video/BV1aa4y1X7aa

原因：the write guard failed
```

#### Token effect

One shared note per fallback: the answer plus a one-line frame. Relayed answers add nothing to any model context.

#### KV Cache effect

Append-only: the note is injected into the chat Session before its next step, after the reusable prefix, and nothing earlier is rewritten.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Claims live in memory** — a Session is relayed only while its channel is registered and has claimed it; a turn that ends while the channel's plugin restarts is not relayed.
- **One channel per Session** — a second claim moves the Session to the new channel.
- **No durable answers** — the relay stores nothing; an answer in flight when the host stops is lost unless its channel had queued it (lsy-wechat's outbox does).
- **The fallback needs the notifier** — without `ctx.lsyNotifier`, or for the notifier's own channel, an undelivered answer is only logged.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The event bus keeps its own result and reminder notes: they report Sessions no channel claimed, with their own formats and batch bookkeeping. Folding them in as a channel is undecided.

</details>
