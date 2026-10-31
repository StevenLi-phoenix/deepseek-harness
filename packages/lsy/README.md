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
| [`bili/`](bili/README.md) | The agent's own Bilibili account as a client of bili-svc: reads and non-speech actions through bili-svc's door, the owner's messages answered through its Reply Gate, and a read-only Settings card |
| [`lsy-balance/`](lsy-balance/README.md) | Account settings card with the balance or quota of every provider key |
| [`lsy-event-bus/`](lsy-event-bus/README.md) | Dedupe, loop suppression, subscriptions, coalescing, rate limits, notify and Session dispatch |
| [`lsy-event-ingest/`](lsy-event-ingest/README.md) | `POST /hooks/lsy` route: the owner's own services push events under one bearer token per source |
| [`lsy-github-sensor/`](lsy-github-sensor/README.md) | Polls GitHub releases, tags, commits, and notifications with conditional requests |
| [`lsy-integrity/`](lsy-integrity/README.md) | Integrity watch: digests of the files that steer the agent, a WeChat notice naming what changed, system prompt hashes, and a count of the persona's forbidden stock lines |
| [`lsy-memory/`](lsy-memory/README.md) | Owner memory across Sessions: the memory block, `memory_search`, `memory_save`, `memory_forget`, and the claude.ai export importer |
| [`lsy-qq/`](lsy-qq/README.md) | QQ group observer over a OneBot v11 protocol end (NapCat): records the listed groups, digests them on a schedule, never speaks by default |
| [`lsy-qqbot/`](lsy-qqbot/README.md) | Official QQ bot channel, disabled by default: owner-listed private chats and @-mentions, one chat Session each, answers through `owner-relay` |
| [`lsy-sysmon/`](lsy-sysmon/README.md) | Settings section with the Host machine's CPU, memory, power, temperature, and disk usage per volume |
| [`lsy-taint/`](lsy-taint/README.md) | Turn origin: who started the open turn and whether strangers' words reached it; Claude Code messaging only in the owner's own turns, reminders and watches from other turns reported |
| [`lsy-tool-monitor/`](lsy-tool-monitor/README.md) | `monitor_start`, `monitor_stop`, `monitor_list` tools: a command's output lines come back to the same Session |
| [`lsy-tool-up/`](lsy-tool-up/README.md) | `up_*` tools: the agent reads the creator account's comments, private messages and videos and asks bili-svc's Reply Gate for replies; the answer is `sent`, `held`, or `blocked` |
| [`lsy-tool-voice/`](lsy-tool-voice/README.md) | `speak` tool: the agent turns text into speech and sends the audio to the owner on WeChat |
| [`lsy-cc-bridge/`](lsy-cc-bridge/README.md) | `cc_list_sessions`, `cc_send`, `cc_start`, `cc_stop` tools: work with Claude Code sessions of the agent's own account |
| [`lsy-tool-qq/`](lsy-tool-qq/README.md) | `qq_groups`, `qq_digest`, `qq_recent`, `qq_search` tools: the agent reads what the QQ observer recorded and digested |
| [`lsy-tool-watch/`](lsy-tool-watch/README.md) | `watch_create`, `watch_list`, `watch_delete` tools: the agent manages its own watches |
| [`lsy-tool-wechat/`](lsy-tool-wechat/README.md) | `wechat_send_file` tool: the agent sends pictures, videos, and files to the owner |
| [`lsy-voice/`](lsy-voice/README.md) | `ctx.lsyVoice`: text to speech (feiyu, Mac mini TTS fallback) and speech to text for audio files (asr-service, off by default) |
| [`lsy-wechat/`](lsy-wechat/README.md) | WeChat (iLink bot) channel: owner chat Session, its answers through `owner-relay`, and `ctx.lsyNotifier` |
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
