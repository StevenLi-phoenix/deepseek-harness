---
description: "The fork package group: fork-local sensors, the event bus, watch tools, and the WeChat channel that let external events and the owner's messages wake an agent on an always-on host."
kind: "package-group"
---

# fork/ — event-driven agent runs

English | [中文](README.zh.md)

## Summary

Talk to an always-on agent on WeChat and let it watch GitHub for you, without editing configuration or watching a dashboard. You say what matters; the agent creates its own watches and reminders with tools. Sensors poll and publish events; the bus deduplicates, suppresses the agent's own echoes, batches, and rate-limits; actuators send a WeChat message or start an unattended Session whose answer comes back to WeChat. This group is fork-local and tracks upstream through a ledger.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`bili/`](bili/README.md) | The agent's own Bilibili account as a client of bili-svc: reads and non-speech actions through bili-svc's door, the owner's messages answered through its Reply Gate, and a Settings section that manages bili-svc (accounts, QR sign-in, gate, brake, ledger) |
| [`provider-balance/`](provider-balance/README.md) | Account settings card with the balance or quota of every provider key |
| [`plugin-config/`](plugin-config/README.md) | The All settings card (`settings.plugin-config`) any Settings section embeds: every Config field of a plugin entry, its layer, and one reviewed save to the owner's patch |
| [`courses/`](courses/README.md) | The owner's course records (`ctx.courses`): a client of the courses service and a deadline poller that reminds the owner on WeChat by fixed rules and tells when the course sync is broken |
| [`courses-settings/`](courses-settings/README.md) | Settings section 课程 DDL: reminder switch, checks, the course sync's health, the next deadlines, the latest reminders, and the configuration |
| [`event-bus/`](event-bus/README.md) | Dedupe, loop suppression, subscriptions, coalescing, rate limits, notify and Session dispatch |
| [`event-ingest/`](event-ingest/README.md) | `POST /hooks/events` route: the owner's own services push events under one bearer token per source |
| [`github-sensor/`](github-sensor/README.md) | Polls GitHub releases, tags, commits, and notifications with conditional requests |
| [`gmail/`](gmail/README.md) | The owner's Gmail accounts (`ctx.gmail`): one Google sign-in per account, reading, drafts, and the send gate that holds a message as a draft and asks the owner on WeChat with a code when the account's policy and the turn's origin say so |
| [`gmail-settings/`](gmail-settings/README.md) | Settings section 邮箱: held messages to confirm or discard, the accounts with their send policy, adding an account through Google's sign-in, the OAuth client, and the page the sign-in returns to |
| [`content-guard/`](content-guard/README.md) | `ctx.contentGuard.check`: one validator for text that others can read; patterns, canary strings, overlap with the owner's memory, and a model, any layer that cannot run refusing |
| [`integrity-watch/`](integrity-watch/README.md) | Integrity watch: digests of the files that steer the agent, a WeChat notice naming what changed, system prompt hashes, and a count of the persona's forbidden stock lines |
| [`owner-memory/`](owner-memory/README.md) | Owner memory across Sessions: the memory block, `memory_search`, `memory_save`, `memory_forget`, and the claude.ai export importer |
| [`wechat-settings/`](wechat-settings/README.md) | Browser half of Settings → WeChat (bind by QR code, channel health, unbind) and Settings → 勿扰 (quiet hours) |
| [`presence/`](presence/README.md) | Whether the owner sleeps (the phone's Sleep Focus, a daily window, buttons in Settings → 勿扰); WeChat holds non-urgent messages meanwhile and sends them as one digest on waking |
| [`qq/`](qq/README.md) | QQ group observer over a OneBot v11 protocol end (NapCat): records the listed groups, digests them on a schedule, never speaks by default |
| [`qqbot/`](qqbot/README.md) | Official QQ bot channel, disabled by default: owner-listed private chats and @-mentions, one chat Session each, answers through `owner-relay` |
| [`qq-login/`](qq-login/README.md) | Settings section for QQ: the observer's connection, NapCat's login state, and the login QR code to scan with the phone after QQ signs the account out |
| [`speaking-style/`](speaking-style/README.md) | DSH's own speaking style: a persona card it writes itself, traits and memes from QQ groups, Bilibili, and the web (a miner finds them, a search explains them), and tone samples, shown to the unattended, up, bili, and qqbot presets (`ctx.speakingStyle`; `persona_update`, `style_note`, `meme_lookup`) |
| [`speaking-style-settings/`](speaking-style-settings/README.md) | Settings section 说话风格: the persona card with its history, memes with their origin, tone samples with one-tap deletion, review, the miner's last run, the stock-line trend, and the plugin's configuration |
| [`subagent-activity/`](subagent-activity/README.md) | Right-Sidebar page 子智能体 opened from one header button: each subagent of a Session, what it is doing now and for how long, and how the finished ones ended (the `subagentActivity` projection) |
| [`owner-memory-admin/`](owner-memory-admin/README.md) | Settings section for reviewing agent memory: waiting writes, entries, previewed rollback and erase, persona feedback (its Host route is `owner-memory`'s `settings` entry) |
| [`sysmon/`](sysmon/README.md) | Settings section with the Host machine's CPU, memory, power, temperature, and disk usage per volume |
| [`cc-admin/`](cc-admin/README.md) | Root service `ctx.claudeCodeSessions`: the service account's Claude Code sessions, listed, started with a first task, and stopped, for the Settings page |
| [`event-console/`](event-console/README.md) | The message flow page, and Settings sections for a service health overview, event subscriptions and schedule reminders, and Claude Code sessions with a voice preview |
| [`turn-taint/`](turn-taint/README.md) | Turn origin: who started the open turn and whether strangers' words reached it; Claude Code messaging only in the owner's own turns, reminders and watches from other turns reported |
| [`time-gap/`](time-gap/README.md) | Time check for every Session: an input that arrives after a quiet spell (5 minutes) reaches the model with the time, how long the Session was quiet, and a reminder to read it on its own terms |
| [`tool-courses/`](tool-courses/README.md) | `courses_deadlines`, `courses_find`, `courses_get`, `courses_sync`, `courses_set_progress`, `courses_save_memo` tools: the agent answers and updates the owner's course records |
| [`tool-gmail/`](tool-gmail/README.md) | `gmail_accounts`, `gmail_search`, `gmail_read`, `gmail_attachment`, `gmail_draft`, `gmail_send`, `gmail_modify` tools: the agent reads and sends the owner's mail, received mail as untrusted data, every send through the send gate |
| [`tool-monitor/`](tool-monitor/README.md) | `monitor_start`, `monitor_stop`, `monitor_list` tools: a command's output lines come back to the same Session |
| [`tool-up/`](tool-up/README.md) | `up_*` tools: the agent reads the creator account's comments, private messages and videos and asks bili-svc's Reply Gate for replies; the answer is `sent`, `held`, or `blocked` |
| [`tool-voice/`](tool-voice/README.md) | `speak` tool: the agent turns text into speech and sends the audio to the owner on WeChat |
| [`cc-bridge/`](cc-bridge/README.md) | `cc_list_sessions`, `cc_send`, `cc_start`, `cc_stop` tools: work with Claude Code sessions of the agent's own account |
| [`tool-qq/`](tool-qq/README.md) | `qq_groups`, `qq_digest`, `qq_recent`, `qq_search` tools: the agent reads what the QQ observer recorded and digested |
| [`tool-watch/`](tool-watch/README.md) | `watch_create`, `watch_list`, `watch_delete` tools: the agent manages its own watches; `flow_read`, `flow_edit`: it changes the whole notification flow |
| [`tool-wechat/`](tool-wechat/README.md) | `wechat_send` and `wechat_send_file` tools: the agent messages the owner mid-turn and sends pictures, videos, and files |
| [`voice/`](voice/README.md) | `ctx.voice`: text to speech (feiyu) and speech to text for audio files (asr-service, off by default) |
| [`wechat/`](wechat/README.md) | WeChat (iLink bot) channel: owner chat Session, its answers through `owner-relay`, and `ctx.ownerNotifier`; a Settings section to bind by QR code, see its health, and unbind |
| [`owner-relay/`](owner-relay/README.md) | `ctx.ownerRelay`: one rule set for every claimed Session's final answer, handed to its channel (WeChat, Bilibili messages) with a labelled WeChat fallback |
| [`tool-bili/`](tool-bili/README.md) | Bilibili tools of the `bili` preset: feeds, videos through subtitles, comments, inbox, likes, coins, follows, and saves through bili-svc, and a journal; no speech |

-----

<a id="related-documentation"></a>
## Related documentation

- [fork subsystem](../../docs/subsystems/fork.md) — service methods and result records.
- [Upstream ledger](UPSTREAM.md) — what this group copied from upstream and how to upgrade.
- [Webhook runtime](../experimental/webhook/README.md) — the Session creation seam the bus reuses.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Deployment profile and service files live in `/fork` at the repository root.

</details>
