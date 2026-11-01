---
description: "The lsy package group: fork-local sensors, the event bus, watch tools, and the WeChat channel that let external events and the owner's messages wake an agent on an always-on host."
kind: "package-group"
---

# lsy/ — event-driven agent runs

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
| [`lsy-balance/`](lsy-balance/README.md) | Account settings card with the balance or quota of every provider key |
| [`lsy-config/`](lsy-config/README.md) | The All settings card (`settings.plugin-config`) any Settings section embeds: every Config field of a plugin entry, its layer, and one reviewed save to the owner's patch |
| [`lsy-courses/`](lsy-courses/README.md) | The owner's course records (`ctx.lsyCourses`): a client of the courses service and a deadline poller that reminds the owner on WeChat by fixed rules and tells when the course sync is broken |
| [`lsy-courses-settings/`](lsy-courses-settings/README.md) | Settings section 课程 DDL: reminder switch, checks, the course sync's health, the next deadlines, the latest reminders, and the configuration |
| [`lsy-event-bus/`](lsy-event-bus/README.md) | Dedupe, loop suppression, subscriptions, coalescing, rate limits, notify and Session dispatch |
| [`lsy-event-ingest/`](lsy-event-ingest/README.md) | `POST /hooks/lsy` route: the owner's own services push events under one bearer token per source |
| [`lsy-github-sensor/`](lsy-github-sensor/README.md) | Polls GitHub releases, tags, commits, and notifications with conditional requests |
| [`lsy-guard/`](lsy-guard/README.md) | `ctx.lsyGuard.check`: one validator for text that others can read; patterns, canary strings, overlap with the owner's memory, and a model, any layer that cannot run refusing |
| [`lsy-integrity/`](lsy-integrity/README.md) | Integrity watch: digests of the files that steer the agent, a WeChat notice naming what changed, system prompt hashes, and a count of the persona's forbidden stock lines |
| [`lsy-memory/`](lsy-memory/README.md) | Owner memory across Sessions: the memory block, `memory_search`, `memory_save`, `memory_forget`, and the claude.ai export importer |
| [`lsy-wechat-settings/`](lsy-wechat-settings/README.md) | Browser half of Settings → WeChat (bind by QR code, channel health, unbind) and Settings → 勿扰 (quiet hours) |
| [`lsy-presence/`](lsy-presence/README.md) | Whether the owner sleeps (the phone's Sleep Focus, a daily window, buttons in Settings → 勿扰); WeChat holds non-urgent messages meanwhile and sends them as one digest on waking |
| [`lsy-qq/`](lsy-qq/README.md) | QQ group observer over a OneBot v11 protocol end (NapCat): records the listed groups, digests them on a schedule, never speaks by default |
| [`lsy-qqbot/`](lsy-qqbot/README.md) | Official QQ bot channel, disabled by default: owner-listed private chats and @-mentions, one chat Session each, answers through `owner-relay` |
| [`lsy-qq-login/`](lsy-qq-login/README.md) | Settings section for QQ: the observer's connection, NapCat's login state, and the login QR code to scan with the phone after QQ signs the account out |
| [`lsy-style/`](lsy-style/README.md) | DSH's own speaking style: a persona card it writes itself, traits and memes from QQ groups, Bilibili, and the web (a miner finds them, a search explains them), and tone samples, shown to the unattended, up, bili, and qqbot presets (`ctx.lsyStyle`; `persona_update`, `style_note`, `meme_lookup`) |
| [`lsy-style-settings/`](lsy-style-settings/README.md) | Settings section 说话风格: the persona card with its history, memes with their origin, tone samples with one-tap deletion, review, the miner's last run, the stock-line trend, and the plugin's configuration |
| [`lsy-memory-admin/`](lsy-memory-admin/README.md) | Settings section for reviewing agent memory: waiting writes, entries, previewed rollback and erase, persona feedback (its Host route is `lsy-memory`'s `settings` entry) |
| [`lsy-sysmon/`](lsy-sysmon/README.md) | Settings section with the Host machine's CPU, memory, power, temperature, and disk usage per volume |
| [`lsy-cc-admin/`](lsy-cc-admin/README.md) | Root service `ctx.lsyClaudeCode`: the service account's Claude Code sessions, listed, started with a first task, and stopped, for the Settings page |
| [`lsy-console/`](lsy-console/README.md) | Settings sections for a service health overview, event subscriptions and schedule reminders, and Claude Code sessions with a voice preview |
| [`lsy-taint/`](lsy-taint/README.md) | Turn origin: who started the open turn and whether strangers' words reached it; Claude Code messaging only in the owner's own turns, reminders and watches from other turns reported |
| [`lsy-time-gap/`](lsy-time-gap/README.md) | Time check for every Session: an input that arrives after a quiet spell (5 minutes) reaches the model with the time, how long the Session was quiet, and a reminder to read it on its own terms |
| [`lsy-tool-courses/`](lsy-tool-courses/README.md) | `courses_deadlines`, `courses_find`, `courses_get`, `courses_set_progress`, `courses_save_memo` tools: the agent answers and updates the owner's course records |
| [`lsy-tool-monitor/`](lsy-tool-monitor/README.md) | `monitor_start`, `monitor_stop`, `monitor_list` tools: a command's output lines come back to the same Session |
| [`lsy-tool-up/`](lsy-tool-up/README.md) | `up_*` tools: the agent reads the creator account's comments, private messages and videos and asks bili-svc's Reply Gate for replies; the answer is `sent`, `held`, or `blocked` |
| [`lsy-tool-voice/`](lsy-tool-voice/README.md) | `speak` tool: the agent turns text into speech and sends the audio to the owner on WeChat |
| [`lsy-cc-bridge/`](lsy-cc-bridge/README.md) | `cc_list_sessions`, `cc_send`, `cc_start`, `cc_stop` tools: work with Claude Code sessions of the agent's own account |
| [`lsy-tool-qq/`](lsy-tool-qq/README.md) | `qq_groups`, `qq_digest`, `qq_recent`, `qq_search` tools: the agent reads what the QQ observer recorded and digested |
| [`lsy-tool-watch/`](lsy-tool-watch/README.md) | `watch_create`, `watch_list`, `watch_delete` tools: the agent manages its own watches |
| [`lsy-tool-wechat/`](lsy-tool-wechat/README.md) | `wechat_send_file` tool: the agent sends pictures, videos, and files to the owner |
| [`lsy-voice/`](lsy-voice/README.md) | `ctx.lsyVoice`: text to speech (feiyu, Mac mini TTS fallback) and speech to text for audio files (asr-service, off by default) |
| [`lsy-wechat/`](lsy-wechat/README.md) | WeChat (iLink bot) channel: owner chat Session, its answers through `owner-relay`, and `ctx.lsyNotifier`; a Settings section to bind by QR code, see its health, and unbind |
| [`owner-relay/`](owner-relay/README.md) | `ctx.ownerRelay`: one rule set for every claimed Session's final answer, handed to its channel (WeChat, Bilibili messages) with a labelled WeChat fallback |
| [`tool-bili/`](tool-bili/README.md) | Bilibili tools of the `bili` preset: feeds, videos through subtitles, comments, inbox, likes, coins, follows, and saves through bili-svc, and a journal; no speech |

-----

<a id="related-documentation"></a>
## Related documentation

- [Upstream ledger](UPSTREAM.md) — what this group copied from upstream and how to upgrade.
- [Webhook runtime](../experimental/webhook/README.md) — the Session creation seam the bus reuses.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Deployment profile and service files live in `/lsy` at the repository root.

</details>
