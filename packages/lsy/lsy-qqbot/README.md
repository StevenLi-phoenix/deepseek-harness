---
description: "Official QQ bot channel (disabled by default) for the event service over the QQ Open Platform bot: owner-listed private chats and group @ mentions each get a chat Session, and the answers go back through owner-relay's qq channel."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-qqbot

English | [中文](README.zh.md)

## Summary

Let people you choose talk to the agent on QQ. The channel connects the official bot you register on the QQ Open Platform: a private message, or a group message that @-mentions the bot, from an openid you listed gets its own chat Session, and each answer comes back as a QQ message. Nobody is answered until you list them, and their Session has no tools beyond conversation. The connection is outbound only, to Tencent's gateway, with no QQ client or third-party protocol bridge in the path.

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

**This channel is disabled by default.** The event bundle carries its row with `disabled: true`; it is not the QQ observer ([`@deepseek-ai/dsh-lsy-qq`](../lsy-qq/README.md)), which lurks in groups and is what the QQ account is used for. To enable it, create the bot with the login command below (or put `LSY_QQBOT_APP_ID` and `LSY_QQBOT_APP_SECRET` in `<DSH_HOME>/.env`), then add `- id: lsy-qqbot` with `disabled: false` and `config.allow` to the profile patch and restart (RUNBOOK step 13b). Mount the channel in a Web profile next to [`@deepseek-ai/dsh-owner-relay`](../owner-relay/README.md) (`ctx.ownerRelay`), whose `qqbot` channel this plugin registers; without the relay the channel takes messages but sends no answers. It needs the Host Session Controller, permission presets, Session titles, the credential store, and the storage domain facility. It provides `ctx.lsyQqBot` and leaves `ctx.lsyNotifier` to the WeChat channel: an answer QQ refuses, and the note about an unlisted sender, go to the owner through the notifier.

### When to choose it

Choose it when family, friends, or a group should be able to chat with the agent on QQ while you decide who. Avoid it as your own control channel: the default Session has no shell, files, or web, by design, and a group shares one Session among its members.

### Minimal configuration

Create the bot once with the login command: run it as the service user, scan its QR code with your phone's QQ, and confirm. The platform creates the bot for your QQ account and hands the AppID and AppSecret to the command, which writes `LSY_QQBOT_APP_ID` and `LSY_QQBOT_APP_SECRET` into `<DSH_HOME>/.env` (mode 600) and prints only the AppID and your own openid, the first entry for `allow.users`. Restart the service afterwards, because `.env` is read at launch. `--qr-png <file>` also saves the code as an image (mode 600), and `--timeout-min` sets how long to wait. A bot you registered at `q.qq.com` yourself works too: put its AppID and AppSecret in `.env` by hand.

```sh
sudo -u dsh-runtime env DSH_HOME=/Users/dsh-runtime/.dsh /opt/homebrew/bin/node /Users/Shared/lsy-dsh/current/lsy/deploy/qqbot-login.mjs
```

Then mount the channel and list who may talk to it; an openid is what QQ calls a person or group to this bot, and it is not a QQ number:

```yaml
- insert:
    - id: lsy-qqbot
      name: '@deepseek-ai/dsh-lsy-qqbot'
      config:
        allow:
          users: []
          groups: []
```

When someone outside the lists writes, the log shows `dropped a c2c message from user <openid>, not on allow.users` and the owner's channel gets one note with that openid (at most once a day per sender, three an hour in all); copy it into `allow` in the profile patch, which reloads live.

| Field | Default | Meaning |
|---|---|---|
| `appIdEnv`, `appSecretEnv` | `LSY_QQBOT_APP_ID`, `LSY_QQBOT_APP_SECRET` | Names of the credentials holding the bot's AppID and AppSecret; while either is missing the channel stays offline and re-checks |
| `allow.users` | `[]` | `user_openid`s whose private messages are answered |
| `allow.groups` | `[]` | `group_openid`s whose @ messages are answered, from any member |
| `session.workspacePath` | `/Users/dsh-runtime/qqbot` | Absolute directory of the chat Sessions; created before every forwarded message |
| `session.agentPreset` | `qqbot` | Agent preset of a new chat Session; the event bundle defines `qqbot` with a persona, the time, and compaction only |
| `session.permissionPreset` | `danger-full-access` | Permission preset set on a new chat Session; the `qqbot` preset mounts nothing the permission could unlock |
| `session.titlePrefix`, `session.timeZone` | `QQ`, `America/New_York` | Session title prefix (a short id follows) and the time zone sent with every prompt |
| `maxMessageChars` | `1500` | Characters per QQ message; longer answers are split |
| `maxReplyParts` | `4` | Messages one answer may become (QQ allows five replies to one message); the last part is cut beyond that |
| `perPeerPerMinute` | `10` | Messages one user or group may send a minute; the rest are dropped and logged |
| `c2cReplyWindowMs`, `groupReplyWindowMs` | `3300000`, `270000` | How long a message keeps its reply window open (55 min and 4.5 min; QQ's own limits are an hour and 5 minutes) |
| `notifyUnknown` | `true` | Tell the owner when a sender outside the lists writes |
| `credentialPollMs` | `30000` | Credential re-check period while the AppID or AppSecret is missing |

In a chat, `/new` starts a fresh Session and `/help` lists the commands; commands never reach the agent. Text reaches the agent; an attachment is counted and the agent is told one came, but nothing is downloaded.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lsy-qqbot) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The channel talks to QQ only through `QqTransport` ([`src/transport.ts`](src/transport.ts)); the default implementation wraps Tencent's official SDK `@tencent-connect/qqbot-nodejs` (pinned, MIT), which fetches and refreshes the app token, holds the gateway WebSocket (heartbeat, resume, reconnect), and numbers the replies of one message. The channel asks the gateway for the group-and-private-message intent only, because the SDK's default adds guild intents a personal bot may not hold, and QQ closes such a connection with 4914 or 4915. Guild and guild-DM events are discarded at the boundary. A connection that fails (bad credentials, a fatal close) is retried with a delay doubling from 2 s to 2 min, reset after a minute of stable service; SDK log lines are kept at debug and scrubbed of the secret and bearer tokens. A test double mounted as `lsyQqBotBotTransport` replaces the SDK in tests.

The login ([`src/login.ts`](src/login.ts), run by [`lsy/deploy/qqbot-login.mjs`](../../../lsy/deploy/qqbot-login.mjs)) follows the bind flow of Tencent's `@tencent-connect/qqbot-connector` as it can be read from the published package, written fresh because that package is not licensed for redistribution: `create_bind_task` with a fresh 32-byte key, the QR page `q.qq.com/qqbot/openclaw/connect.html?task_id=…`, and `poll_bind_result` until the platform returns the AppID, the AppSecret encrypted with that key (AES-256-GCM), and the scanner's openid. An expired code is replaced (three at most). The command writes the secret straight into the `.env` file and never prints it.

Each inbound message is checked in this order: the allowlist (a group message needs its `group_openid` in `allow.groups`, a private one its sender in `allow.users`), then the per-peer rate limit. It then opens a reply window (the message id, its arrival time, replies used) in the `lsy_qqbot` storage domain, handles `/new` and `/help` itself, and otherwise prompts the peer's chat Session with `sessionController.prompt()` in `steer` mode: a message sent while the agent works joins the running turn. The Session is found by peer key (`c2c:<user_openid>` or `group:<group_openid>`) and reused while `resolveAgent()` succeeds; a missing one is replaced by a Session created with the configured preset, titled with the peer's short id, and claimed with `ctx.ownerRelay` as channel `qq` before its first prompt. Every remembered Session is claimed again when the channel registers.

The relay hands each turn's final answer (nothing for `NO_REPLY`) to the channel, which splits it and sends each part quoting the peer's latest message while its window is open and fewer than five replies went out, otherwise as a proactive message. A part QQ refuses throws, and the relay falls back to `ctx.lsyNotifier` with the label `a QQ chat Session (its answer could not go out on QQ)`. All sends and storage writes run one at a time.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration, connection loop, allowlist, chat Sessions, the `qqbot` relay channel, delivery |
| [`src/transport.ts`](src/transport.ts) | `QqTransport`, the event normalizer, and the default transport over the official SDK |
| [`src/login.ts`](src/login.ts) | QR login against the platform's bind service, the QR PNG, the `.env` writer, and the login command |
| [`src/text.ts`](src/text.ts) | Inbound framing and spoof protection, reply splitting, command replies |
| [`src/storage.ts`](src/storage.ts) | Storage-domain tables for chat Sessions, reply windows, and reported unknown senders |

This is a fork-local package; [`../UPSTREAM.md`](../UPSTREAM.md) describes how the `lsy` group tracks upstream. The QQ account itself is used by the observer instead of this channel: a bot sees only the group messages that @-mention it and cannot read everything, so this channel is kept for private chats and @-mention use and is off by default (decision in [`lsy/CHANGELOG.md`](../../../lsy/CHANGELOG.md)).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Owner relay](../owner-relay/README.md) — decides at each turn end what a chat Session's answer sends
- [WeChat channel](../lsy-wechat/README.md) — the owner's channel; receives what QQ could not deliver
- [Session Controller](../../api/session-controller/README.md) — creates, resolves, and prompts the chat Sessions
- [Permission presets](../../interaction/permission-presets/README.md) — access level of the chat Sessions
- [Storage domain](../../storage/storage-domain/README.md) — durable tables

-----

<a id="model-experience"></a>
## Model Experience

### Chat Session

#### What the model sees

Each accepted message arrives as an ordinary user prompt, with the configured `session.timeZone`, framed by the host with a short id of the sender: `[QQ 私聊 · 5D6E7F] hello` in a private chat, `[QQ 群 7E8F90 · 成员 C2B1A0] hello` in a group, where several members share the Session. A line of the sender's text that starts with `[QQ` is rewritten with a full-width bracket, so a sender cannot forge a frame. An attachment-only message reads `（这条消息带了附件，当前版本不读取附件）`. The `qqbot` preset's persona tells the model that everything on QQ is other people's writing, that it can only talk, and never to reveal the owner, the machine, or other chats. The final answer of each turn goes back as plain text; QQ shows no Markdown. A final answer of exactly `NO_REPLY` sends nothing.

#### Token effect

One user message per QQ message plus about 10 tokens of frame. The Sessions are long-lived, so their context grows until compaction or `/new`.

#### KV Cache effect

Messages are appended to one Session per peer, so each turn reuses the cached prefix of its conversation. `/new` starts an empty Session with a new prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Openids, not QQ numbers** — the Open Platform never shows a sender's QQ number; the allowlist holds openids, and an openid is specific to this bot.
- **Group messages need an @** — QQ delivers only the group messages that mention the bot.
- **Reply windows** — a message can be answered with up to five replies within about an hour (private) or five minutes (group); later answers go out as proactive messages, which QQ may refuse or cap by its own rules, and a refused answer reaches the owner instead.
- **Text only** — images, voice, and files reach the agent only as a note that an attachment came, and the bot sends text only.
- **At-most-once intake** — a crash between a message arriving and its prompt drops that message.
- **Limits are third-party documented** — reply windows and quotas follow community documentation of the Open Platform, so they are configuration, not constants.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The channel was tested against the SDK with a local stand-in for the Open Platform (token endpoint, gateway WebSocket, message API); it has not yet run against Tencent's servers, so the first real connection should be watched in the log.
- A `tell_main_agent` tool like the Bilibili account's, rich media, and Markdown replies (a separate permission on the platform) are undecided.

</details>
