---
description: "QQ group observer for the event service: a personal QQ account, through a OneBot v11 protocol end (NapCat) on the same machine, records the groups the owner lists, downloads their images, transcribes voice on request, digests them on a schedule, and never speaks by default."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-qq

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

The package connects to a OneBot v11 WebSocket server, which in this fleet is NapCat in a Docker container on colima ([`fork/deploy/napcat/napcat.sh`](../../../fork/deploy/napcat/napcat.sh), RUNBOOK step 13). It provides `ctx.forkQq`, whose read methods [`@deepseek-ai/dsh-fork-tool-qq`](../fork-tool-qq/README.md) turns into agent tools. It needs the Host Session Controller, permission presets, Session titles, and the credential store; it uses `ctx.forkVoice` (voice transcription) and `ctx.forkNotifier` (an offline notice) when they are mounted. Mount it, then list the groups to record:

```yaml
- insert:
    - id: fork-qq
      name: '@deepseek-ai/dsh-fork-qq'
      config:
        groups: ['123456789']
```

Until a group number is listed nothing is recorded: messages of every other group are dropped on arrival, and the log names each such group once (`not recording group <number> (<name>)`), which is how you find the numbers. Private chats are not stored at all. The log also reports, every ten minutes, how many messages each unlisted group has shown since the start (a count only, nothing of them is kept), which helps to pick the busy ones.

| Field | Default | Meaning |
|---|---|---|
| `url` | `ws://127.0.0.1:3001` | WebSocket address of the protocol end; it must be on this machine (127.0.0.1, localhost) or the tailnet (100.64.0.0/10, `*.ts.net`) |
| `tokenEnv` | `FORK_QQ_ONEBOT_TOKEN` | Name of the credential holding the protocol end's access token; sent as a Bearer header; while it is missing the observer stays offline |
| `groups` | `[]` | Group numbers to record. Volatile: Settings → QQ adds and removes groups and the observer follows at once, saving to the profile patch (an added group is backfilled) |
| `dataDir` | `<DSH_HOME>/fork-qq` | Database (`qq.db`), downloads (`media/`), and raw digest answers (`digest-raw/`); created with mode 0700 |
| `media.images` | `true` | Download the images of recorded messages |
| `media.maxImageBytes` | `15728640` | Largest image downloaded |
| `media.maxTotalBytes` | `5368709120` | Downloads stop when they together reach this (5 GiB); the log warns once an hour |
| `media.retainDays` | `30` | Delete downloads of messages older than this many days; `0` keeps them |
| `retention.textDays` | `30` | Delete raw messages (text, raw segments, media rows) older than this many days; `0` keeps them. Digests are not affected |
| `media.hostSuffixes` | QQ's CDN hosts | A media link on any other host, or on an IP address, is not fetched |
| `media.timeoutMs` | `30000` | Deadline of one download |
| `voice.download` | `true` | Keep voice messages as MP3 (the protocol end decodes QQ's SILK) |
| `voice.maxBytes` | `10485760` | Largest audio kept |
| `asr.enabled` | `false` | Transcribe voice messages with `ctx.forkVoice.transcribe`; needs fork-voice with `asr.enabled` |
| `honorRecall` | `true` | A message its sender recalls loses its text, raw segments, and files |
| `backfill.enabled` | `true` | After connecting, fetch what was missed |
| `backfill.maxMessages` | `20` | Messages fetched per group at most (one page of that size; older pages are walked back only up to this total) |
| `backfill.maxGroups` | `5` | Groups caught up per connection; the next connection continues with the following ones |
| `backfill.gapMs` | `5000` | Pause between two groups' backfills, plus up to half as much again of jitter |
| `backfill.skipWithinMs` | `1800000` | A connection made less than this long after the previous one dropped fetches nothing, so a flapping link does not hammer the account; `0` never skips |
| `backfill.minIntervalMs` | `1800000` | A backfill runs at most this often, also across plugin restarts (`<dataDir>/connection-state.json`); `0` never holds one back |
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
| `digest.archiveSessions` | `true` | Archive each digest Session when its turn ends, so it does not fill the sidebar; its log stays (DSH has no way to delete a stored Session) |
| `digest.maxToolCalls` | `12` | Tool calls one digest Session may make, refused ones included |
| `digest.agentPreset`, `digest.permissionPreset` | `qq-digest`, `read-only` | The event bundle's `qq-digest` preset has a persona and two narrow tools, `qq_digest_write` and `qq_group_note` (no shell, files, web, or memory) |
| `digest.workspacePath`, `digest.timeZone`, `digest.timeoutMs` | `/Users/dsh-runtime/work/qq`, `Asia/Shanghai`, `900000` | Working directory (the digest Sessions are titled `QQ: <group name>` and live there), the zone of the transcript's times, and the wait for one model call |
| `offlineNoticeMs` | `600000` | Tell the owner (through `ctx.forkNotifier`) when the protocol end has been unreachable this long, or reports the account offline; `0` turns it off. One notice per outage: what was told is kept in `<dataDir>/outage-notice.json` until the connection comes back, so a reload or deploy mid-outage does not tell again |
| `reconnectQuietMs` | `600000` | A connection made less than this long after the previous one was last alive skips the group list and the backfill, also across a plugin restart (the time is kept in `<dataDir>/connection-state.json`, refreshed every minute while connected); `0` never skips. The group list is fetched at most once an hour either way |
| `offlineRepeatMs` | `86400000` | While an outage lasts, remind the owner again after this long (24 h); `0` never repeats |
| `settingsUrl` | unset | The event service's address, quoted in that notice next to "Settings → QQ"; unset names the page without a link |
| `login.enabled` | `true` | Ask the login door for NapCat's login state (the Settings QQ section) |
| `login.url` | `http://127.0.0.1:3002` | The login door's address (`napcat.sh door`); it must be on this machine or the tailnet |
| `login.timeoutMs` | `5000` | Deadline of one call to the door |

**Which changes restart the plugin.** A profile reload restarts the plugin (and drops the OneBot connection) unless the change touches only volatile fields: `groups`, `backfill.*`, `media.*`, `voice.*`, `asr.enabled`, `retention.textDays`, `honorRecall`, `offlineNoticeMs`, `offlineRepeatMs`, `reconnectQuietMs`, and `settingsUrl` are read afresh at each use and apply without a restart. `url`, `tokenEnv`, `dataDir`, `digest.*`, `send.*`, and `login.*` are fixed when the plugin starts (the digest runner and the sender copy them), so changing them restarts it.

Backfilled messages are stored as text only: their images and voice are not downloaded (the rows say so), and live messages are unaffected.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-fork-qq) is the exhaustive source for every accepted field.

**When QQ signs the account out**, scan again from the DSH page: **Settings → QQ** ([`@deepseek-ai/dsh-fork-qq-login`](../fork-qq-login/README.md)) shows the connection, NapCat's login state, and the login QR code. The code comes through the *login door*, a small container `napcat.sh start` runs next to NapCat (`napcat.sh door` starts it alone) on `127.0.0.1:3002`. NapCat's WebUI can open a shell in its container and read the QQ session, so the service user never holds its token: the door holds it, answers only `GET /v1/login` and `POST /v1/login/refresh`, accepts the OneBot token as the caller's proof, and passes on typed, capped fields (the QR link only if it is an https `*.qq.com` address). The observer reads the door through `loginStatus()` and `refreshLogin()`, reports its own connection through `connectionStatus()`, and reconnects at once when the door says NapCat is logged in while it is still backing off. **What `dsh-runtime` can and cannot do with NapCat**: it holds the OneBot token (the OneBot API on `127.0.0.1:3001`, which this package only reads from) and, through the door, can read whether QQ is logged in, read the login QR link while a scan is needed, and ask for a fresh code (refused while QQ is logged in and for ten minutes after, otherwise once per 10 s). It cannot reach NapCat's WebUI (config, files, a shell in the container, logout, restart), the docker socket, or the volumes holding the QQ session. Recovery steps: RUNBOOK §13, [QQ 掉线恢复](../../../fork/deploy/RUNBOOK.md#qq-recovery).

Digests are the observer's learned knowledge and carry their source (`qq-group:<number>`, digest number, date); they keep past the 30 days, and `forgetDigests({ groupId?, beforeMs? })` (the `qq_forget` tool) deletes them by group or date. Reading is the service's job: `groupOverview()`, `recentMessages()`, `searchMessages()`, `digests()`, and `groupName()` answer only for recorded groups. `sendGroupMessage(groupId, text)` exists for future code and refuses unless `send.enabled` is true and the group is in `send.groups`; nothing in this package or in the tools calls it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`OneBotClient` ([`src/onebot.ts`](src/onebot.ts)) opens the forward WebSocket with the token as a Bearer header, drops a socket that is silent for two minutes (NapCat heartbeats every 30 s), correlates API calls by `echo`, and scrubs the token from every error. The observer reconnects with a delay doubling from 2 s to 2 min, reset after a minute of stable service. After each connection it reads the login (`get_login_info`), refreshes the group list (`get_group_list`, hourly after that), and backfills each recorded group (`get_group_msg_history`, newest page first, back until it meets a stored message or `backfill.maxMessages`).

A group message is parsed ([`src/text.ts`](src/text.ts)) into one line of text (`@name`, `[图片]`, `[语音]`, `[文件:name]`, `[卡片:title url]`, and so on), the quoted message id, and its media. [`src/store.ts`](src/store.ts) writes it to SQLite (`node:sqlite`, WAL) under a unique key of group and QQ message id, so reconnects and backfills never double a row, with an FTS5 index using the trigram tokenizer for Chinese and English substring search (queries under three characters fall back to `LIKE`). Images are fetched only from the hosts in `media.hostSuffixes`, over HTTPS, with no redirect followed, under a size cap, two at a time, into `media/<group>/<YYYYMM>/<sha256>.<ext>` (mode 0600; identical bytes share a file). A voice message is fetched as MP3 through `get_record` (falling back to its link), saved the same way, and, with `asr.enabled`, transcribed by fork-voice; the transcript is appended to the message text and the search index. A recall notice drops the message's text, raw segments, media rows, and files.

Every `digest` round (a check every ten minutes) picks the groups whose last digest is `everyHours` old and which have `minMessages` new messages, cuts the backlog into transcripts of at most `maxPromptChars`, and for each runs one turn in a new Session of the `qq-digest` preset (permission `read-only`, the configured model). The model hands the digest in with `qq_digest_write` and keeps the group's notes with `qq_group_note`; both are bound to the Session and to the one group it digests (a call for any other group is refused, as is a second digest, a call past `digest.maxToolCalls`, and a call from any other Session), and the runner stores the digest with its window, model, and usage when the turn ends. A model that skips the tool and writes the digest as its answer is still kept. What it handed in and its final text are written to `digest-raw/` before the digest is stored; a `NO_REPLY` answer stores a placeholder so the cursor moves on. Each round is logged with the tool calls, refusals, notes added and removed, and how often the Session was condensed. The transcript is framed as untrusted data and cannot close its own block.

Group notes are the QQ channel's own memory (stored here, not in fork-memory): what the group usually talks about, its slang and mood, at most 30 per group and 40 characters each, shown to the model in the next round as `#id text` so it can drop one. A note describes the group, never a person: a filter refuses long numbers, emails, `@`, member aliases, addresses, schools and organisations, and any name or card a member of that group has shown. `groupNotes(groupId)` reads them. `evidenceOf(groupId, messageIds)` answers, for each message the group still holds (recorded, not recalled, inside `retention.textDays`), a sender key, the time, and the stored one-line text, so a caller can check a quotation word for word. The key is sixteen hex digits of a salted hash of the group and the member, stable within the group and different in every other, never the QQ number. `groupOfSession(sessionId)` and `recentTextOf(sessionId)` let a tool take the group, and the messages the model was shown, from the calling digest Session (both answer only while its turn runs).

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, configuration, connection loop, event handling, media downloads, schedules, reads, gated sending |
| [`src/onebot.ts`](src/onebot.ts) | OneBot v11 client and the address check |
| [`src/login.ts`](src/login.ts) | Client of the login door: checks each answer field by field |
| [`src/status.ts`](src/status.ts) | Connection and login reading types for the Settings section |
| [`src/text.ts`](src/text.ts) | Segments to text and media |
| [`src/store.ts`](src/store.ts) | SQLite schema, FTS5 search, retention and digest queries |
| [`src/media.ts`](src/media.ts) | Address allowlist, capped fetch, type detection, content-addressed files |
| [`src/pii.ts`](src/pii.ts) | The filter a group note passes: no person, number, address, school, or member name |
| [`src/digest.ts`](src/digest.ts) | Transcript chunking, the digest prompt, and the model call through a Session |

This is a fork-local package; [`../UPSTREAM.md`](../UPSTREAM.md) describes how the `fork` group tracks upstream. The protocol end is NapCat: it runs Tencent's own Linux QQ client with a plugin, so no QQ protocol is reimplemented here. LLBot's macOS CLI was rejected because it signs packets with closed native modules that call the vendor's token service; the official QQ Open Platform bot was built first and dropped because a bot sees only messages that @-mention it in groups and cannot be a member that reads everything. The data stays under `dataDir` on this machine; the only text that leaves it is the transcript sent to the digest model and what the agent reads through its tools.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [QQ tools](../fork-tool-qq/README.md) — `qq_groups`, `qq_digest`, `qq_recent`, `qq_search` over this service
- [Voice service](../fork-voice/README.md) — transcription of voice messages
- [Session Controller](../../api/session-controller/README.md) — runs the digest Sessions
- [Permission presets](../../interaction/permission-presets/README.md) — `read-only` for the digest Session

-----

<a id="model-experience"></a>
## Model Experience

### Digest Session

#### What the model sees

One user prompt per transcript chunk in a new Session: an instruction in English naming the group, the section headings to write (话题, 结论与事实, 术语与梗, 常见问题, 链接与资料; 成员观点与专长 only with `digest.profiles`) and a 1500-character limit, then the transcript inside `<qq_group_messages trust="untrusted">`, one line per message as `[MM-DD HH:mm] 群友#a3f9 ↳reply: text` (members are aliases by default; with `digest.aliasMembers` off, name and the last 4 digits of the QQ number). The message tells the model the group number to pass to its two tools, and shows the group's notes inside `<qq_group_notes trust="derived">`. The preset's persona says the chat is data and that its only tools write this group's digest and notes. The digest is what `qq_digest_write` received (else the final text); `NO_REPLY` means nothing was worth keeping.

#### Token effect

Up to `maxPromptChars` characters of transcript plus about 300 tokens of instruction per call, and up to about 1500 characters back; at most `maxCallsPerRound` calls per group per round, one round a day per group by default. The step usage is stored with each digest.

#### KV Cache effect

Each call is a new Session with its own short prefix; nothing is shared between digests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Retention** — raw messages and downloads are deleted after 30 days; a digest or a quoted name inside message text can still carry what a member wrote about themselves.
- **The login code is the door's** — if the door is not running (`napcat.sh door`), the Settings page cannot show a code and says how to start it; the protocol-end connection itself does not depend on it.
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
