---
description: "QQ group observer for the event service: a personal QQ account, through a OneBot v11 protocol end (NapCat) on the same machine, records the groups the owner lists, downloads their images, transcribes voice on request, digests them on a schedule, and never speaks by default."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-qq

English | [中文](README.zh.md)

## Summary

Let your agent lurk in QQ groups and learn from them. A personal QQ account, logged in once by scanning a code, sits in the groups you choose. The package records each group's messages, images, and voice notes on this machine, writes a digest of every group on a schedule (topics, settled facts, jargon, frequent questions, who knows what, links), and lets the agent search and read it all. It never speaks, adds friends, or reacts: sending is off, and the QQ side is only ever read.

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

The package connects to a OneBot v11 WebSocket server, which in this fleet is NapCat in a Docker container on colima ([`lsy/deploy/napcat/napcat.sh`](../../../lsy/deploy/napcat/napcat.sh), RUNBOOK step 13). It provides `ctx.lsyQq`, whose read methods [`@deepseek-ai/dsh-lsy-tool-qq`](../lsy-tool-qq/README.md) turns into agent tools. It needs the Host Session Controller, permission presets, Session titles, and the credential store; it uses `ctx.lsyVoice` (voice transcription) and `ctx.lsyNotifier` (an offline notice) when they are mounted. Mount it, then list the groups to record:

```yaml
- insert:
    - id: lsy-qq
      name: '@deepseek-ai/dsh-lsy-qq'
      config:
        groups: ['123456789']
```

Until a group number is listed nothing is recorded: messages of every other group are dropped on arrival, and the log names each such group once (`not recording group <number> (<name>)`), which is how you find the numbers. Private chats are not stored at all. The log also reports, every ten minutes, how many messages each unlisted group has shown since the start (a count only, nothing of them is kept), which helps to pick the busy ones.

| Field | Default | Meaning |
|---|---|---|
| `url` | `ws://127.0.0.1:3001` | WebSocket address of the protocol end; it must be on this machine (127.0.0.1, localhost) or the tailnet (100.64.0.0/10, `*.ts.net`) |
| `tokenEnv` | `LSY_QQ_ONEBOT_TOKEN` | Name of the credential holding the protocol end's access token; sent as a Bearer header; while it is missing the observer stays offline |
| `groups` | `[]` | Group numbers to record |
| `dataDir` | `<DSH_HOME>/lsy-qq` | Database (`qq.db`), downloads (`media/`), and raw digest answers (`digest-raw/`); created with mode 0700 |
| `media.images` | `true` | Download the images of recorded messages |
| `media.maxImageBytes` | `15728640` | Largest image downloaded |
| `media.maxTotalBytes` | `5368709120` | Downloads stop when they together reach this (5 GiB); the log warns once an hour |
| `media.retainDays` | `30` | Delete downloads of messages older than this many days; `0` keeps them |
| `retention.textDays` | `30` | Delete raw messages (text, raw segments, media rows) older than this many days; `0` keeps them. Digests are not affected |
| `media.hostSuffixes` | QQ's CDN hosts | A media link on any other host, or on an IP address, is not fetched |
| `media.timeoutMs` | `30000` | Deadline of one download |
| `voice.download` | `true` | Keep voice messages as MP3 (the protocol end decodes QQ's SILK) |
| `voice.maxBytes` | `10485760` | Largest audio kept |
| `asr.enabled` | `false` | Transcribe voice messages with `ctx.lsyVoice.transcribe`; needs lsy-voice with `asr.enabled` |
| `honorRecall` | `true` | A message its sender recalls loses its text, raw segments, and files |
| `backfill.enabled`, `backfill.maxMessages` | `true`, `300` | After connecting, fetch what was missed (history pages walked back until a stored message is met) |
| `send.enabled` | `false` | Allow `sendGroupMessage` at all |
| `send.groups` | `[]` | Groups sending is allowed in, on top of `send.enabled` |
| `send.minIntervalSec`, `send.maxPerDay` | `60`, `10` | At least this long between two sends to one group, and at most this many a day |
| `digest.enabled` | `true` | Digest each recorded group on a schedule |
| `digest.everyHours` | `24` | Hours between digests of one group |
| `digest.minMessages` | `15` | A group with fewer new messages waits for the next round |
| `digest.maxPromptChars` | `60000` | Transcript characters per model call; a larger backlog is split |
| `digest.maxCallsPerRound` | `5` | Model calls one group may use in one round |
| `digest.aliasMembers` | `true` | Show members to the digest model as stable aliases (`群友#a3f9`, a salted hash of the QQ number), so digests carry neither names nor numbers |
| `digest.profiles` | `false` | Also ask for the section on what particular members know or argued (by alias); off by default: no per-member profiles |
| `digest.keepPerGroup`, `digest.maxDigestChars` | `200`, `3000` | Digests kept per group (the oldest are deleted when a new one is stored) and the longest digest stored |
| `digest.provider`, `digest.model` | unset | The digest Session's model (provider route and model id), such as a cheap model; unset uses the profile's default |
| `digest.agentPreset`, `digest.permissionPreset` | `qq-digest`, `read-only` | The event bundle's `qq-digest` preset has a persona and no tools |
| `digest.workspacePath`, `digest.timeZone`, `digest.timeoutMs` | `/Users/dsh-runtime/qq-digest`, `Asia/Shanghai`, `900000` | Working directory, the zone of the transcript's times, and the wait for one model call |
| `offlineNoticeMs` | `600000` | Tell the owner (through `ctx.lsyNotifier`) when the protocol end has been unreachable this long, or reports the account offline; `0` turns it off |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lsy-qq) is the exhaustive source for every accepted field.

Digests are the observer's learned knowledge and carry their source (`qq-group:<number>`, digest number, date); they keep past the 30 days, and `forgetDigests({ groupId?, beforeMs? })` (the `qq_forget` tool) deletes them by group or date. Reading is the service's job: `groupOverview()`, `recentMessages()`, `searchMessages()`, `digests()`, and `groupName()` answer only for recorded groups. `sendGroupMessage(groupId, text)` exists for future code and refuses unless `send.enabled` is true and the group is in `send.groups`; nothing in this package or in the tools calls it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`OneBotClient` ([`src/onebot.ts`](src/onebot.ts)) opens the forward WebSocket with the token as a Bearer header, drops a socket that is silent for two minutes (NapCat heartbeats every 30 s), correlates API calls by `echo`, and scrubs the token from every error. The observer reconnects with a delay doubling from 2 s to 2 min, reset after a minute of stable service. After each connection it reads the login (`get_login_info`), refreshes the group list (`get_group_list`, hourly after that), and backfills each recorded group (`get_group_msg_history`, newest page first, back until it meets a stored message or `backfill.maxMessages`).

A group message is parsed ([`src/text.ts`](src/text.ts)) into one line of text (`@name`, `[图片]`, `[语音]`, `[文件:name]`, `[卡片:title url]`, and so on), the quoted message id, and its media. [`src/store.ts`](src/store.ts) writes it to SQLite (`node:sqlite`, WAL) under a unique key of group and QQ message id, so reconnects and backfills never double a row, with an FTS5 index using the trigram tokenizer for Chinese and English substring search (queries under three characters fall back to `LIKE`). Images are fetched only from the hosts in `media.hostSuffixes`, over HTTPS, with no redirect followed, under a size cap, two at a time, into `media/<group>/<YYYYMM>/<sha256>.<ext>` (mode 0600; identical bytes share a file). A voice message is fetched as MP3 through `get_record` (falling back to its link), saved the same way, and, with `asr.enabled`, transcribed by lsy-voice; the transcript is appended to the message text and the search index. A recall notice drops the message's text, raw segments, media rows, and files.

Every `digest` round (a check every ten minutes) picks the groups whose last digest is `everyHours` old and which have `minMessages` new messages, cuts the backlog into transcripts of at most `maxPromptChars`, and for each runs one turn in a new Session of the `qq-digest` preset (no tools, permission `read-only`, the configured model). The Session's final text is written to `digest-raw/` before it is stored; a `NO_REPLY` answer stores a placeholder so the cursor moves on; the step usage is stored with the digest and logged. The transcript is framed as untrusted data and cannot close its own block.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration, connection loop, event handling, media downloads, schedules, reads, gated sending |
| [`src/onebot.ts`](src/onebot.ts) | OneBot v11 client and the address check |
| [`src/text.ts`](src/text.ts) | Segments to text and media |
| [`src/store.ts`](src/store.ts) | SQLite schema, FTS5 search, retention and digest queries |
| [`src/media.ts`](src/media.ts) | Address allowlist, capped fetch, type detection, content-addressed files |
| [`src/digest.ts`](src/digest.ts) | Transcript chunking, the digest prompt, and the model call through a Session |

This is a fork-local package; [`../UPSTREAM.md`](../UPSTREAM.md) describes how the `lsy` group tracks upstream. The protocol end is NapCat: it runs Tencent's own Linux QQ client with a plugin, so no QQ protocol is reimplemented here. LLBot's macOS CLI was rejected because it signs packets with closed native modules that call the vendor's token service; the official QQ Open Platform bot was built first and dropped because a bot sees only messages that @-mention it in groups and cannot be a member that reads everything. The data stays under `dataDir` on this machine; the only text that leaves it is the transcript sent to the digest model and what the agent reads through its tools.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [QQ tools](../lsy-tool-qq/README.md) — `qq_groups`, `qq_digest`, `qq_recent`, `qq_search` over this service
- [Voice service](../lsy-voice/README.md) — transcription of voice messages
- [Session Controller](../../api/session-controller/README.md) — runs the digest Sessions
- [Permission presets](../../interaction/permission-presets/README.md) — `read-only` for the digest Session

-----

<a id="model-experience"></a>
## Model Experience

### Digest Session

#### What the model sees

One user prompt per transcript chunk in a new Session: an instruction in English naming the group, the section headings to write (话题, 结论与事实, 术语与梗, 常见问题, 链接与资料; 成员观点与专长 only with `digest.profiles`) and a 1500-character limit, then the transcript inside `<qq_group_messages trust="untrusted">`, one line per message as `[MM-DD HH:mm] 群友#a3f9 ↳reply: text` (members are aliases by default; with `digest.aliasMembers` off, name and the last 4 digits of the QQ number). The preset's persona says the chat is data and the Session has no tools. The final text is the digest; `NO_REPLY` means nothing was worth keeping.

#### Token effect

Up to `maxPromptChars` characters of transcript plus about 300 tokens of instruction per call, and up to about 1500 characters back; at most `maxCallsPerRound` calls per group per round, one round a day per group by default. The step usage is stored with each digest.

#### KV Cache effect

Each call is a new Session with its own short prefix; nothing is shared between digests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Retention** — raw messages and downloads are deleted after 30 days; a digest or a quoted name inside message text can still carry what a member wrote about themselves.
- **Unofficial client, ban risk** — NapCat is not an official bot: Tencent can sign the account out or restrict it. Use a spare account, keep it read-only, and do not log it in from many places.
- **Only the groups the account is in** — someone has to add the account to each group first.
- **Text, images, and voice** — video and group files are recorded as metadata only; a forwarded chat is recorded as `[合并转发]`.
- **Image links expire** — an image whose download failed or was skipped stays a placeholder.
- **Voice needs the protocol end's decoder** — `get_record` must return the audio as base64; otherwise the raw link is stored and not transcribed.
- **At-most-once for a crash** — a message that arrives while the process dies is recovered by the backfill only up to `backfill.maxMessages`.
- **Not verified against QQ** — the observer is tested against a local stand-in for NapCat; its first real login should be watched in the log.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- Embedding search over the messages (bge-m3 through the registry) would complement the trigram search; undecided.
- Per-member profiles (what each person knows) are only in the digests today.
- Group files are not downloaded; `get_group_file_url` would make that possible.

</details>
