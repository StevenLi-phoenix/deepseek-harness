---
description: "WeChat (iLink bot) channel for the event service: talk to the agent from WeChat in one long-lived chat Session, get its answers back, and receive event notifications through ctx.lsyNotifier, with a durable outbox for WeChat's reply-window limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-wechat

English | [中文](README.zh.md)

## Summary

Chat with your agent from WeChat on your phone. Bind a bot once by scanning a QR code; every message you send it then reaches the agent in one long-lived chat Session, and each answer comes back as a WeChat message. Event notifications and unattended-run results arrive in the same chat. WeChat lets a bot write only within a window your own messages open, so anything that cannot go out yet waits in a durable outbox and arrives as one digest when you next write. Only the WeChat user who scanned the code can talk to the agent.

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

Mount the channel in a Web profile next to `@deepseek-ai/dsh-lsy-event-bus`. It provides `ctx.lsyNotifier`, so the bus sends its notifications here, and it needs the Host Session Controller, permission presets, Session titles, and the storage domain facility.

### When to choose it

Choose it when the agent should reach you on your phone and you want to answer from there, without exposing the Web UI. Avoid it for group chats or for several people: it serves exactly one owner and drops everyone else's messages.

### Minimal configuration

Bind a bot first. Run the login from an installed build as the user the service runs as, scan the QR code with WeChat, and type the number WeChat may show:

```sh
sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/wechat-login.mjs
```

The command writes `<DSH_HOME>/lsy-wechat/account.json` with mode 600 and prints only the bot id and the owner id. A running service picks the file up within `accountPollMs`; binding again replaces it without a restart. Then mount the channel:

```yaml
- insert:
    - id: lsy-wechat
      name: '@deepseek-ai/dsh-lsy-wechat'
      config:
        chat:
          workspacePath: /Users/dsh-runtime/work
          agentPreset: unattended
          permissionPreset: danger-full-access
```

| Field | Default | Meaning |
|---|---|---|
| `accountFile` | `<DSH_HOME>/lsy-wechat/account.json` | Account written by the login command |
| `chat.workspacePath` | `/Users/dsh-runtime/work` | Absolute directory of the chat Session; created before every forwarded message. Received attachments go to its `.wechat-inbox/` (0700, files 0600), which ignores itself so a git workspace never commits them |
| `chat.agentPreset` | `unattended` | Agent preset of a new chat Session |
| `chat.permissionPreset` | `danger-full-access` | Permission preset set on a new chat Session |
| `chat.title` | `微信` | Title of a new chat Session |
| `chat.timeZone` | `America/New_York` | Time zone sent with every prompt and shown in digests |
| `maxMessageChars` | `3000` | Characters per WeChat message; longer texts are split, and every message also stays under 16384 UTF-8 bytes |
| `maxReplyParts` | `3` | Messages one text may become; the last part is cut beyond that |
| `repliesPerToken` | `10` | Messages the bot may send per message of yours |
| `contextTtlMs` | `84600000` | How long one of your messages keeps the reply window open (23.5 h) |
| `outboxLimit` | `50` | Undelivered texts kept; the oldest are dropped first |
| `accountPollMs` | `30000` | Account file re-check period while no usable account exists |
| `longPollTimeoutMs` | `35000` | Long-poll deadline until the server suggests another |
| `requestTimeoutMs` | `15000` | Deadline of one send |
| `cdnBaseUrl` | `https://novac2c.cdn.weixin.qq.com/c2c` | WeChat CDN for attachments; a server-provided `full_url` on another origin is refused |
| `maxMediaBytes` | `26214400` | Largest attachment downloaded (25 MiB) |
| `mediaTimeoutMs` | `60000` | Deadline of one attachment download |

In the chat, `/new` starts a fresh chat Session. Text, voice transcripts, and quotes reach the agent. Images, files, and videos are downloaded from the WeChat CDN, decrypted, and saved in the inbox; images also reach the model as image parts when its route accepts images.

`sendFile(path)` sends a local file back: image bytes go out as a picture, `.mp4`, `.mov`, and `.m4v` as a video, anything else as a file. The host decides everything the model must not: the recipient is always the owner, the file goes only through the open reply window (never the outbox), the window's last slot stays for the turn's text reply, and the path must name a regular file within `maxMediaBytes`. The tool package [`@deepseek-ai/dsh-lsy-tool-wechat`](../lsy-tool-wechat/README.md) exposes it to the agent as `wechat_send_file`.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lsy-wechat) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The channel long-polls `ilink/bot/getupdates` while the plugin is active and stores the returned cursor in the `lsy_wechat` storage domain before it handles the messages, so a crash drops messages rather than repeating prompts. It re-reads the account file between polls; without a usable account, or after the server reports the token stale (`-14`), it logs once and checks the file every `accountPollMs`. It accepts only user messages from the owner. Each one opens a reply window (`context_token`, receive time, used count), flushes the outbox as digest messages that never take the window's last slot, and is forwarded with `sessionController.prompt()` in `steer` mode to the owner's chat Session: an idle Session starts a turn, and a busy one takes the message at its next step, so a picture sent right after a word reaches the turn already answering that word. Before that, each image, file, and video item is downloaded (AES-128-ECB, key from `image_item.aeskey` or `media.aes_key`), typed from its bytes or name, and written to the inbox; the prompt gets a note per attachment and the images as image parts, and a `session/attachment-invalid` refusal (a text-only model) is retried with the note alone. The stored Session is reused while `resolveAgent()` succeeds; a missing or broken one is replaced by a new Session created with `sessionController.create()`, given its permission preset and title. The channel follows `session/event` for every chat Session it created, keeps the latest assistant text of the turn, and sends it when the turn ends unless it is `NO_REPLY`. `send()` and the relay share one serialized delivery path: a text goes out only through an open, unexpired window with slots left, the send that takes the last slot carries a footer, and everything else is queued with its reason. `ret -2` closes the window, `-14` pauses the channel, and network failures keep the text queued. Every `send()` also injects the rendered note into the newest chat Session (`agent.inject()`, source kind `lsy-wechat`, form `notice`), framed as another Session's message rather than the owner's: it waits for the next turn without starting one, because the owner's reply to that note reaches the chat Session, not the Session that wrote it.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration, long-poll loop, chat Session, reply relay, delivery and outbox |
| [`src/api.ts`](src/api.ts) | Minimal iLink client with per-request deadlines; errors never contain the token |
| [`src/login.ts`](src/login.ts) | QR login status machine, terminal login command, account file |
| [`src/text.ts`](src/text.ts) | Inbound text extraction, message splitting, relay text, digests |
| [`src/media.ts`](src/media.ts) | CDN download and decryption, image type detection, the inbox, and the attachment note; outbound encryption and upload (`getuploadurl`, CDN POST, `x-encrypted-param`) |
| [`src/storage.ts`](src/storage.ts) | Storage-domain tables for cursors, reply windows, chat Sessions, and the outbox |

This is a fork-local package; [`../UPSTREAM.md`](../UPSTREAM.md) describes how the `lsy` group tracks upstream. The protocol follows the Tencent OpenClaw WeChat plugin (`@tencent-weixin/openclaw-weixin` 2.4.10); this client implements QR login, `getupdates`, media download, and text `sendmessage`. The media layout and origin check follow [xiaoshihou514/dsh-weixin](https://github.com/xiaoshihou514/dsh-weixin) (MIT). [`lsy/deploy/wechat-login.mjs`](../../../lsy/deploy/wechat-login.mjs) is a thin shim over `runLoginCli()`, which the tests cover.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Event bus](../lsy-event-bus/README.md) — sends notifications and Session results to this channel
- [Session Controller](../../api/session-controller/README.md) — creates, resolves, and prompts the chat Session
- [Permission presets](../../interaction/permission-presets/README.md) — access level of the chat Session
- [Storage domain](../../storage/storage-domain/README.md) — durable tables

-----

<a id="model-experience"></a>
## Model Experience

### Chat Session

#### What the model sees

Each WeChat message of the owner arrives in the chat Session as an ordinary user prompt with the configured `chat.timeZone`, the same as text typed in the Web UI. The text carries no WeChat framing; a quote adds one `[引用] …` line, a voice message reads `[语音] <transcript>`, and media read as placeholders followed by one note per attachment, such as `- image (image/jpeg, 84.2 KB) saved at /Users/dsh-runtime/work/.wechat-inbox/…-image.jpg; it is attached to this message.`; an attachment that could not be fetched says so and that its content is unavailable. Images within 20 MiB in a format the Host accepts (PNG, JPEG, GIF, WebP) are also image parts of the same message. The model's final answer of each turn is relayed back as plain text, so Markdown shows up literally on the phone. A final answer of exactly `NO_REPLY` sends nothing.

#### Token effect

One user message per WeChat message, as long as the owner wrote it, plus about one line per attachment and the image tokens of each attached image. The chat Session is long-lived, so its context grows across days until compaction or `/new`.

#### KV Cache effect

Messages are appended to one Session, so each turn reuses the cached prefix of the conversation so far. `/new` starts an empty Session with a new prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **24-hour window** — WeChat accepts bot messages only for about a day after the owner's last message; later texts wait in the outbox. Send the bot a word once a day if you expect alerts.
- **About 10 replies per owner message** — the window allows a limited number of bot messages; the last one says so, and the rest wait for the owner's next message.
- **No proactive first contact** — the bot cannot write before the owner has written to it.
- **Voice is text only** — voice reaches the agent as its transcript, and the bot never sends voice; images, files, and videos go both ways.
- **The inbox is never pruned** — received attachments stay in `.wechat-inbox/` until removed by hand.
- **No typing indicator** — the owner sees nothing while the agent works.
- **At-most-once intake** — a crash between storing the cursor and forwarding a message drops that message.
- **Limits are third-party documented** — window length, quota, and size limits are not officially published, so they are configuration, not constants.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- `/new` is the only chat command; other commands, such as switching the chat Session's model from WeChat, are undecided.

</details>
