# Changelog

Fork-local changes on top of upstream DeepSeek Harness. Format: [Keep a Changelog](https://keepachangelog.com/). Upstream changes are not repeated here; see [`../packages/fork/UPSTREAM.md`](../packages/fork/UPSTREAM.md) for the upstream baseline.

## [Unreleased]

### Added
- `@deepseek-ai/dsh-fork-event-bus`: durable event bus with dedupe, loop suppression (agent actors and output markers), user-authored subscriptions, coalescing windows, rolling hourly rate limits, notify dispatch through `ctx.forkNotifier`, Session dispatch through the webhook runtime (`fork-event` kind), and first-turn result reports.
- `@deepseek-ai/dsh-fork-telegram`: Telegram Bot API notifier providing `ctx.forkNotifier`; plain-text messages clipped to 4096 characters, token resolved per send from a credential reference, one retry on short `retry_after`, errors never contain the token.
- `packages/fork/UPSTREAM.md` ledger and this `fork/` deployment directory.
