---
description: "Model-facing owner_push tool: the agent pushes an urgent message to the owner's phone, or queues one line for the daily email digest, through the API platform's message bus, one message per matter key."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-push

English | [中文](README.zh.md)

## Summary

When something is lost unless you act within hours (an interview time to confirm today, a deadline that falls today, a run that cannot go on without you), your agent pushes it to your phone rather than leaving it in a WeChat report. The agent calls `owner_push` with the text and a key naming the matter; the API platform's message bus pushes it through its notification service, or, with `digest` set, saves it for the daily email digest. The bus takes one message per key, so a later run does not push the same matter again.

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

Add the row to the plugin list of the agent preset that should push. The fork event profile mounts it in its `unattended` preset, which the WeChat chat Session and the scheduled runs use.

```yaml
- id: tool-push
  name: '@deepseek-ai/dsh-tool-push'
```

The tool posts with a PAT that may post to the message bus (the `messageservice` write ACL, or an administrator). Put it in `$DSH_HOME/.env` or the credential store under `MESSAGE_PAT`; the value is read on every call, so a rotated token needs no restart. Without it the tool answers that the token is not set and posts nothing.

| Option | Default | Meaning |
|---|---|---|
| `apiBase` | `https://api.lishuyu.app` | Platform base, without a trailing slash |
| `tokenEnv` | `MESSAGE_PAT` | Name of the PAT in the credential store or `$DSH_HOME/.env` |
| `source` | `dsh` | `source` of every message |
| `channel` | `dsh` | Bus channel the messages are kept in; `display` is refused, since the bus never pushes it |
| `pushPriority` | `6` | Priority of a push: the bus pushes at or above its notify threshold (5), and 7 or more also takes over the e-ink display and emails |
| `requestTimeoutMs` | `15000` | Timeout of one post |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`owner_push` checks the arguments (text 1-500 characters after trimming, key a lowercase slug of at most 100 characters) and posts one message to `POST <apiBase>/v2/call/messageservice/post`. A push is `{ source, text, channel, priority: pushPriority, idempotency_key: "owner-push:<key>" }`; a digest line is the same at priority 0 with `digest: true` and `digest_key: <key>`. The bus forwards a message at or above its notify threshold to the notification service, which pushes it through Bark; a digest message goes to the notifier's daily email digest, which collapses lines with the same key.

The typed RPC is used rather than the bus's REST adapter (`/message/messages`) because the REST adapter drops `idempotency_key`. The bus scopes the key to the caller: an identical repeat returns the first message's id and pushes nothing, and the same key with other content answers 409 `idempotency_conflict`, which the tool reports as already sent. No state is kept in DSH.

Every post logs the message id, push or digest, the key, and the text's length (never the text or the token); a failure logs its class (`not-configured`, `auth`, `duplicate`, `invalid`, `http`, `network`, `timeout`) at warn.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: configuration, argument checks, and the tool definition |
| [`src/bus.ts`](src/bus.ts) | The message bus client and its failure classes |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [WeChat tools](../tool-wechat/README.md) — reports, files, and held messages to the owner on WeChat

-----

<a id="model-experience"></a>
## Model Experience

### Push tool

#### What the model sees

One tool schema whenever the calling Agent's preset mounts the package: `owner_push` with the required strings `text` and `key` and the optional boolean `digest`. The description says to push only what is lost if the owner does not act within hours (an interview time to confirm today, a deadline that falls today, a run that cannot go on without the owner); that anything that can wait belongs in the WeChat report or, with `digest`, the next daily email digest, and that a deadline a day or more away is not urgent; and that the bus takes one message per key, so a later run that finds the same matter sends nothing new. The `unattended` persona repeats the rule in one sentence.

#### Token effect

A fixed schema cost on every request from an Agent whose preset mounts the package; Agents under other presets pay nothing.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged; mounting or disposal may invalidate reuse from the first changed schema token.

### Push results

#### What the model sees

One JSON text block per call: `{ "posted": true, "id", "as": "push" | "digest" }`, or `{ "notPosted": "<reason>" }` such as `the bus already took a message for key <key>; nothing new was sent, so do not send it again`, `the message bus token is not set; tell the owner in your WeChat report instead`, `the message bus refused the token (HTTP 403 forbidden); …`, `text is longer than 500 characters; say it shorter`, or a key that is not a slug.

#### Token effect

A few dozen tokens per call, kept in the Session's history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Accepted is not delivered** — the bus answers once the message and its notification job are stored; a phone that is off or a Bark failure is visible only in the notification service's log.
- **One message per key** — a matter that needs a second push, such as a reminder an hour before an interview, needs its own key.
- **The urgency call is the model's** — the description and the persona set the bar; nothing checks a deadline's distance.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Host alerts (AMS intake, the platform's own failures) could reach the phone through the same bus once a rule decides which deserve a push.

</details>
