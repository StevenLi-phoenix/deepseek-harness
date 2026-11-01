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
| [`fork-balance/`](fork-balance/README.md) | Account settings card with the balance or quota of every provider key |
| [`fork-config/`](fork-config/README.md) | The All settings card (`settings.plugin-config`) any Settings section embeds: every Config field of a plugin entry, its layer, and one reviewed save to the owner's patch |
| [`fork-event-bus/`](fork-event-bus/README.md) | Dedupe, loop suppression, subscriptions, coalescing, rate limits, notify and Session dispatch |
| [`fork-event-ingest/`](fork-event-ingest/README.md) | `POST /hooks/events` route: the owner's own services push events under one bearer token per source |
| [`fork-github-sensor/`](fork-github-sensor/README.md) | Polls GitHub releases, tags, commits, and notifications with conditional requests |
| [`fork-guard/`](fork-guard/README.md) | `ctx.forkGuard.check`: one validator for text that others can read; patterns, canary strings, overlap with the owner's memory, and a model, any layer that cannot run refusing |
| [`fork-integrity/`](fork-integrity/README.md) | Integrity watch: digests of the files that steer the agent, a WeChat notice naming what changed, system prompt hashes, and a count of the persona's forbidden stock lines |
| [`fork-memory/`](fork-memory/README.md) | Owner memory across Sessions: the memory block, `memory_search`, `memory_save`, `memory_forget`, and the claude.ai export importer |
| [`fork-wechat-settings/`](fork-wechat-settings/README.md) | Browser half of Settings → WeChat (bind by QR code, channel health, unbind) and Settings → 勿扰 (quiet hours) |
| [`fork-presence/`](fork-presence/README.md) | Whether the owner sleeps (the phone's Sleep Focus, a daily window, buttons in Settings → 勿扰); WeChat holds non-urgent messages meanwhile and sends them as one digest on waking |
| [`fork-qq/`](fork-qq/README.md) | QQ group observer over a OneBot v11 protocol end (NapCat): records the listed groups, digests them on a schedule, never speaks by default |
| [`fork-qqbot/`](fork-qqbot/README.md) | Official QQ bot channel, disabled by default: owner-listed private chats and @-mentions, one chat Session each, answers through `owner-relay` |
| [`fork-qq-login/`](fork-qq-login/README.md) | Settings section for QQ: the observer's connection, NapCat's login state, and the login QR code to scan with the phone after QQ signs the account out |
| [`fork-style/`](fork-style/README.md) | Speaking style from real people: short QQ group and Bilibili exchanges, filtered without a model, shown to the main agent once a day as quoted data (`ctx.forkStyle`) |
| [`fork-style-settings/`](fork-style-settings/README.md) | Settings section 说话风格: the samples with one-tap deletion, review, the owner's own lines, collection counts, and the stock-line trend |
| [`fork-memory-admin/`](fork-memory-admin/README.md) | Settings section for reviewing agent memory: waiting writes, entries, previewed rollback and erase, persona feedback (its Host route is `fork-memory`'s `settings` entry) |
| [`fork-sysmon/`](fork-sysmon/README.md) | Settings section with the Host machine's CPU, memory, power, temperature, and disk usage per volume |
| [`fork-cc-admin/`](fork-cc-admin/README.md) | Root service `ctx.forkClaudeCode`: the service account's Claude Code sessions, listed, started with a first task, and stopped, for the Settings page |
| [`fork-console/`](fork-console/README.md) | Settings sections for a service health overview, event subscriptions and schedule reminders, and Claude Code sessions with a voice preview |
| [`fork-taint/`](fork-taint/README.md) | Turn origin: who started the open turn and whether strangers' words reached it; Claude Code messaging only in the owner's own turns, reminders and watches from other turns reported |
| [`fork-tool-monitor/`](fork-tool-monitor/README.md) | `monitor_start`, `monitor_stop`, `monitor_list` tools: a command's output lines come back to the same Session |
| [`fork-tool-up/`](fork-tool-up/README.md) | `up_*` tools: the agent reads the creator account's comments, private messages and videos and asks bili-svc's Reply Gate for replies; the answer is `sent`, `held`, or `blocked` |
| [`fork-tool-voice/`](fork-tool-voice/README.md) | `speak` tool: the agent turns text into speech and sends the audio to the owner on WeChat |
| [`fork-cc-bridge/`](fork-cc-bridge/README.md) | `cc_list_sessions`, `cc_send`, `cc_start`, `cc_stop` tools: work with Claude Code sessions of the agent's own account |
| [`fork-tool-qq/`](fork-tool-qq/README.md) | `qq_groups`, `qq_digest`, `qq_recent`, `qq_search` tools: the agent reads what the QQ observer recorded and digested |
| [`fork-tool-watch/`](fork-tool-watch/README.md) | `watch_create`, `watch_list`, `watch_delete` tools: the agent manages its own watches |
| [`fork-tool-wechat/`](fork-tool-wechat/README.md) | `wechat_send_file` tool: the agent sends pictures, videos, and files to the owner |
| [`fork-voice/`](fork-voice/README.md) | `ctx.forkVoice`: text to speech (feiyu, Mac mini TTS fallback) and speech to text for audio files (asr-service, off by default) |
| [`fork-wechat/`](fork-wechat/README.md) | WeChat (iLink bot) channel: owner chat Session, its answers through `owner-relay`, and `ctx.forkNotifier`; a Settings section to bind by QR code, see its health, and unbind |
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

Deployment profile and service files live in `/fork` at the repository root.

</details>
