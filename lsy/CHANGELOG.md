# Changelog

Fork-local changes on top of upstream DeepSeek Harness. Format: [Keep a Changelog](https://keepachangelog.com/). Upstream changes are not repeated here; see [`../packages/lsy/UPSTREAM.md`](../packages/lsy/UPSTREAM.md) for the upstream baseline.

## [Unreleased]

### Added
- `@deepseek-ai/dsh-lsy-event-bus`: durable event bus with dedupe, loop suppression (agent actors and output markers), user-authored subscriptions, coalescing windows, rolling hourly rate limits, notify dispatch through `ctx.lsyNotifier`, Session dispatch through the webhook runtime (`lsy-event` kind), and first-turn result reports.
- `@deepseek-ai/dsh-lsy-telegram`: Telegram Bot API notifier providing `ctx.lsyNotifier`; plain-text messages clipped to 4096 characters, token resolved per send from a credential reference, one retry on short `retry_after`, errors never contain the token.
- `@deepseek-ai/dsh-lsy-github-sensor`: polls releases, tags, branch commits, and `/notifications` every 60 s with `ETag`/`Last-Modified` conditional requests, baselines on first poll, honors `X-Poll-Interval`, pauses on primary and secondary rate limits, persists cursors, and retries items whose publish failed. Includes a fake GitHub REST double and an end-to-end pipeline test (sensor → bus → notifier/webhook runtime).
- `packages/lsy/UPSTREAM.md` ledger and this `lsy/` deployment directory.
