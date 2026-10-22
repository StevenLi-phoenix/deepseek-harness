---
description: "Model-facing wechat_send_file tool: the agent sends a picture, video, or file from the host to the owner over the lsy WeChat channel, with every rule enforced by the channel, not the model."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-tool-wechat

English | [中文](README.zh.md)

## Summary

Ask your agent on WeChat for a screenshot, a report, or a clip, and it arrives in the chat as a real picture, file, or video instead of a path in a text reply. The agent calls `wechat_send_file` with a file on the host; image bytes become a picture, `.mp4`, `.mov`, and `.m4v` a video, everything else a file attachment. The rules live in host code: the recipient is always you, and a file goes out only while your last message keeps the reply window open. The result tells the agent what was sent or why nothing was.

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

Add the row to the plugin list of the agent preset that should send files, in a process that also mounts `@deepseek-ai/dsh-lsy-wechat`. The lsy event profile mounts it in its `unattended` preset, which the WeChat chat Session uses.

```yaml
- id: lsy-tool-wechat
  name: '@deepseek-ai/dsh-lsy-tool-wechat'
```

The plugin has no configuration; the size limit is the channel's `maxMediaBytes` (25 MiB).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Once the mounting scope resolves `ctx.lsyNotifier`, the plugin registers one `defineTool` definition whose body passes the path to `WechatChannel.sendFile()` and returns its outcome unchanged. The channel checks that the path is absolute and names a non-empty regular file within `maxMediaBytes`, takes the open reply window (keeping its last slot for the text reply), encrypts the file with a fresh AES-128 key, uploads it to the WeChat CDN, and sends one image, video, or file item to the owner on the same serialized path as text replies. Nothing is queued; each send is logged with its kind, name, size, and path.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the tool definition |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [WeChat channel](../lsy-wechat/README.md) — reply windows, media in both directions, and the owner's chat Session

-----

<a id="model-experience"></a>
## Model Experience

### Send tool

#### What the model sees

One tool schema whenever the calling Agent's preset mounts the package: `wechat_send_file` with the required string `path` ("Absolute path of a regular file on this computer, at most 25 MiB."). The description says that images arrive as pictures, `.mp4`/`.mov`/`.m4v` as videos, and everything else as files; that the recipient is always the owner and sending works only while the owner's last message is recent and its reply allowance is not used up; and that the final answer still goes out as the text reply.

#### Token effect

A fixed schema cost on every request from an Agent whose preset mounts the package; Agents under other presets pay nothing.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged; mounting or disposal may invalidate reuse from the first changed schema token.

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

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The upload flow follows xiaoshihou514/dsh-weixin (MIT) and @tencent-weixin/openclaw-weixin; video items carry no thumbnail.

</details>
