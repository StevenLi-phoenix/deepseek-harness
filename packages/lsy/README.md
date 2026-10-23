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
| [`bili/`](bili/README.md) | The agent's own Bilibili account: QR sign-in, cookie refresh, guarded writes, a risk brake, a body clock and inbox that wake its Session, and a Settings section |
| [`lsy-balance/`](lsy-balance/README.md) | Account settings card with the balance or quota of every provider key |
| [`lsy-event-bus/`](lsy-event-bus/README.md) | Dedupe, loop suppression, subscriptions, coalescing, rate limits, notify and Session dispatch |
| [`lsy-event-ingest/`](lsy-event-ingest/README.md) | `POST /hooks/lsy` route: the owner's own services push events under one bearer token per source |
| [`lsy-github-sensor/`](lsy-github-sensor/README.md) | Polls GitHub releases, tags, commits, and notifications with conditional requests |
| [`lsy-memory/`](lsy-memory/README.md) | Owner memory across Sessions: the memory block, `memory_search`, `memory_save`, `memory_forget`, and the claude.ai export importer |
| [`lsy-sysmon/`](lsy-sysmon/README.md) | Settings section with the Host machine's CPU, memory, power, temperature, and disk usage per volume |
| [`lsy-tool-monitor/`](lsy-tool-monitor/README.md) | `monitor_start`, `monitor_stop`, `monitor_list` tools: a command's output lines come back to the same Session |
| [`lsy-tool-watch/`](lsy-tool-watch/README.md) | `watch_create`, `watch_list`, `watch_delete` tools: the agent manages its own watches |
| [`lsy-tool-wechat/`](lsy-tool-wechat/README.md) | `wechat_send_file` tool: the agent sends pictures, videos, and files to the owner |
| [`lsy-wechat/`](lsy-wechat/README.md) | WeChat (iLink bot) channel: owner chat Session, its answers through `owner-relay`, and `ctx.lsyNotifier` |
| [`owner-relay/`](owner-relay/README.md) | `ctx.ownerRelay`: one rule set for every claimed Session's final answer, handed to its channel (WeChat, Bilibili messages) with a labelled WeChat fallback |
| [`tool-bili/`](tool-bili/README.md) | Bilibili tools of the `bili` preset: feeds, videos through subtitles, comments, inbox, guarded writes, and a journal |

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
