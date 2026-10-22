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
| [`fork-balance/`](fork-balance/README.md) | Composer dock pill with the DeepSeek account balance |
| [`fork-event-bus/`](fork-event-bus/README.md) | Dedupe, loop suppression, subscriptions, coalescing, rate limits, notify and Session dispatch |
| [`fork-github-sensor/`](fork-github-sensor/README.md) | Polls GitHub releases, tags, commits, and notifications with conditional requests |
| [`fork-tool-watch/`](fork-tool-watch/README.md) | `watch_create`, `watch_list`, `watch_delete` tools: the agent manages its own watches |
| [`fork-wechat/`](fork-wechat/README.md) | WeChat (iLink bot) channel: owner chat Session, reply relay, and `ctx.forkNotifier` |

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
