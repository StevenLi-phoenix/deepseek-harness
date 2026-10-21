---
description: "The lsy package group: fork-local sensors, the event bus, and notifiers that let external events wake an unattended agent on an always-on host."
kind: "package-group"
---

# lsy/ — event-driven agent runs

English | [中文](README.zh.md)

## Summary

Let GitHub activity and local process health wake an agent or ping your phone without anyone watching a dashboard. Sensors poll and publish events; the bus deduplicates, suppresses the agent's own echoes, batches, and rate-limits; actuators send a Telegram message or start an unattended webhook Session and report its answer. Only subscriptions you wrote can start anything. This group is fork-local and tracks upstream through a ledger.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`lsy-event-bus/`](lsy-event-bus/README.md) | Dedupe, loop suppression, subscriptions, coalescing, rate limits, notify and Session dispatch |
| [`lsy-telegram/`](lsy-telegram/README.md) | Telegram notifier providing `ctx.lsyNotifier` |

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
