---
description: "Model-facing WeChat tools: wechat_send messages the owner in the middle of a turn, wechat_send_file sends a picture, video, or file from the host to the owner, and defer_deliver holds a text for a time or the owner's waking, with every rule enforced by the channel, not the model."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-tool-wechat

English | [中文](README.zh.md)

## Summary

Ask your agent on WeChat for a screenshot, a report, or a clip, and it arrives in the chat as a real picture, file, or video. `wechat_send_file` sends a file as the matching message type, `defer_deliver` holds a text until a time the agent names or until you wake, and `wechat_send` lets it message you in the middle of a long job. The rules live in host code: the recipient is always you, and a file goes out only while your last message keeps the reply window open.

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

Add the row to the plugin list of the agent preset that should send files, in a process that also mounts `@deepseek-ai/dsh-fork-wechat`. The fork event profile mounts it in its `unattended` preset, which the WeChat chat Session uses.

```yaml
- id: fork-tool-wechat
  name: '@deepseek-ai/dsh-fork-tool-wechat'
```

The plugin has no configuration; the size limit is the channel's `maxMediaBytes` (25 MiB). `wechat_send` is registered only while the channel's `chat.delivery` is `hybrid` (its default); with `text` the agent has the other two tools only.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Once the mounting scope resolves `ctx.forkNotifier`, the plugin registers up to three `defineTool` definitions. `wechat_send` (only while `ctx.forkNotifier.delivery()` is `hybrid`, read each time the channel is provided, so a config reload registers or drops it) passes the text, `urgent`, and the calling Session's id to `WechatChannel.sendText()`, which returns how many messages went out or wait and how many replies are left, or why it refused (the turn's cap, the window's last slot, an empty text, text delivery). `wechat_send_file` passes the path to `WechatChannel.sendFile()` and returns its outcome unchanged; `defer_deliver` checks that `until` is ISO 8601 with a UTC offset (a time without one would be read in the Host's zone, which the model cannot see), passes the text and the parsed time to `WechatChannel.holdDelivery()`, and gives the held time back as ISO text. The channel queues the text in its outbox with a release time and one timer for the earliest; a wake releases it early, and the owner's own messages do not. For a file, the channel checks that the path is absolute and names a non-empty regular file within `maxMediaBytes`, takes the open reply window (keeping its last slot for the text reply), encrypts the file with a fresh AES-128 key, uploads it to the WeChat CDN, and sends one image, video, or file item to the owner on the same serialized path as text replies. Nothing is queued; each send is logged with its kind, name, size, and path.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the three tool definitions |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [WeChat channel](../fork-wechat/README.md) — reply windows, media in both directions, and the owner's chat Session

-----

<a id="model-experience"></a>
## Model Experience

### Message tool

#### What the model sees

While `chat.delivery` is `hybrid`, a schema `wechat_send`: the required string `text` ("What to tell the owner, as you would write it in a message: plain text, no Markdown.") and the optional boolean `urgent` (pass the owner's sleep). The description says it messages the owner now, in the middle of the turn (progress on a long job, a first answer before a slow step, a finding that cannot wait); that the final answer is still sent as the reply, so what was sent here is not repeated in it, and that if everything was said here the turn ends with exactly `NO_REPLY`; that everything for one moment belongs in one message because the owner can be answered only about ten times per message of theirs and the last of those is kept for the final answer; and that `urgent` is only for something the owner must read even while asleep.

#### Token effect

A fixed schema cost of about 250 tokens on every request from an Agent whose preset mounts the package while `hybrid` delivery is on.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged; switching `chat.delivery` adds or removes the schema and may invalidate reuse from the first changed schema token.

### Message results

#### What the model sees

One JSON text block per call: `{ "sent": <messages sent now>, "queued": <messages waiting>, "held": true | false, "why"?: "<reason the first one waits>", "repliesLeft"?: <replies left in the window> }`, or `{ "notSent": "<reason>" }` with reasons such as `the text is empty`, `this turn already sent 10 messages (the cap is 10): put what is left into your final answer`, `reply quota nearly used up; the last message is kept for your final answer`, or `wechat_send is off (chat.delivery is text): put the words in your answer`.

#### Token effect

A few dozen tokens per call, kept in the Session's history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

### Send tool

#### What the model sees

One tool schema whenever the calling Agent's preset mounts the package: `wechat_send_file` with the required string `path` ("Absolute path of a regular file on this computer, at most 25 MiB."). The description says that images arrive as pictures, `.mp4`/`.mov`/`.m4v` as videos, and everything else as files; that the recipient is always the owner and sending works only while the owner's last message is recent and its reply allowance is not used up; and that the final answer still goes out as the text reply.

#### Token effect

A fixed schema cost on every request from an Agent whose preset mounts the package; Agents under other presets pay nothing.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged; mounting or disposal may invalidate reuse from the first changed schema token.

### Defer tool

#### What the model sees

A second schema, `defer_deliver`: the required string `text` ("What to tell the owner, as you would write it in a message.") and the optional string `until` (ISO 8601 with a UTC offset, at most 7 days ahead; leave it out to wait for the owner to wake). The description says the text arrives at `until` or when the owner wakes if that is first, that without `until` the owner has to be asleep now, that the text should not be repeated in the final answer (answer exactly `NO_REPLY` if this was all), and that sending needs an open WeChat reply window.

#### Token effect

A fixed schema cost of about 300 tokens on every request from an Agent whose preset mounts the package.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged; mounting or disposal may invalidate reuse from the first changed schema token.

### Defer results

#### What the model sees

One JSON text block per call: `{ "held": <messages>, "until": "<ISO time>"?, "wakes": true | false }` (`wakes` is true when the owner sleeps now, so the waking may release it first), or `{ "notHeld": "<reason>" }` with reasons such as `the text is empty`, `until is not in the future`, `until is more than 7 days away`, `until is not an ISO 8601 time with a UTC offset, …`, or `the owner is awake: put the text in your answer, or give a time with until`.

#### Token effect

A few dozen tokens per call, kept in the Session's history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

### Send results

#### What the model sees

One JSON text block per call: `{ "sent": "image" | "video" | "file", "name", "bytes" }`, or `{ "notSent": "<reason>" }` with reasons such as `path must be absolute`, `not a regular file`, `the file exceeds 26214400 bytes`, `the owner has not written yet`, `reply window expired`, `reply quota nearly used up; the last message is kept for the text reply`, or `upload failed: …`.

#### Token effect

A few dozen tokens per call, kept in the Session's history until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Owner only, window only** — a file cannot reach anyone else, and cannot wait for the next window the way text does.
- **No voice** — audio files go out as file attachments, not voice messages.
- **A held text needs a window at its time** — when the reply window is closed or out of quota at `until`, the text waits in the outbox like any other and goes with the owner's next message.
- **No cancel** — a held text cannot be taken back by the agent; the owner can send everything held at once from Settings → 勿扰.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The upload flow follows xiaoshihou514/dsh-weixin (MIT) and @tencent-weixin/openclaw-weixin; video items carry no thumbnail.

</details>
