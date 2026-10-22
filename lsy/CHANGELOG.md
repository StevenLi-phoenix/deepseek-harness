# Changelog

Fork-local changes on top of upstream DeepSeek Harness. Format: [Keep a Changelog](https://keepachangelog.com/). Upstream changes are not repeated here; see [`../packages/lsy/UPSTREAM.md`](../packages/lsy/UPSTREAM.md) for the upstream baseline.

## [Unreleased]

### Added
- `@deepseek-ai/dsh-lsy-event-bus`: durable event bus with dedupe, loop suppression (agent actors and output markers), subscriptions from configuration or created at run time by the agent (persisted), coalescing windows, rolling hourly rate limits, notify dispatch through `ctx.lsyNotifier`, Session dispatch through the webhook runtime (`lsy-event` kind), first-turn result reports, reports of unattended reminder turns, and `NO_REPLY` for turns that need no message.
- `@deepseek-ai/dsh-lsy-github-sensor`: polls releases, tags, branch commits, and `/notifications` every 60 s with `ETag`/`Last-Modified` conditional requests, baselines on first poll, honors `X-Poll-Interval`, pauses on primary and secondary rate limits, persists cursors, retries items whose publish failed, and polls repositories the agent adds at run time (with a repository probe). Includes a fake GitHub REST double and an end-to-end pipeline test.
- `@deepseek-ai/dsh-lsy-tool-watch`: `watch_create`, `watch_list`, and `watch_delete` tools, so the agent creates and removes its own GitHub watches (`notify` or `session`) instead of anyone editing YAML; time-based checks use the built-in `schedule_create`.
- `@deepseek-ai/dsh-lsy-wechat`: WeChat channel over the iLink bot API — QR binding (`lsy/deploy/wechat-login.mjs`), a long-lived owner chat Session fed by WeChat messages with replies relayed back, `ctx.lsyNotifier` for the bus, reply-window and quota tracking, and an outbox delivered as a digest when the owner writes again.
- `lsy/profiles/event`: event profile composition (Web bundles + webhook runtime + lsy packages + console logger), `unattended` agent preset (standard minus ask-user, plan mode, goals, plugin tools; plus the watch tools) whose persona targets WeChat delivery, and the open-in-app pair disabled for remote use. Smoke-tested from source: real GitHub baseline polling and a synthetic event dispatched into a webhook Session with the `unattended` preset.
- `lsy/deploy/`: `install-app.sh` (packed install, optional deps kept for koffi), `setup-profile.sh` (profile layout and plugin links for the installed product), `upgrade.sh` (build, test, pack, install, switch `current`), `wechat-login.mjs`, LaunchDaemon template `app.lishuyu.dsh-events.plist` (user `dsh-runtime`, port 3081), and `RUNBOOK.md` for the isolated deployment.
- `packages/lsy/UPSTREAM.md` ledger and this `lsy/` deployment directory.

### Changed
- The event service takes over `dsh.tailc2559b.ts.net` from the interactive instance: the event bus `webUrl` points there, and `RUNBOOK.md` step 10 records the cutover (`svc:dsh` to port 3081, old LaunchAgent stopped and disabled) and its rollback, plus the passwordless operator sudoers entry and live-reload notes.
- Failed turns say why: `failureDetail()` (event bus) turns a `TurnEndReason` of kind `error` into one line (`AUTH: 401 User not found.`, at most 200 characters). The WeChat warning adds `原因：…` under `⚠️ 本轮未完成（error）`, bus result and reminder notes add `Reason: …`, the batch record keeps it as `error`, and both log lines carry it.
- LaunchDaemon `app.lishuyu.dsh-events.plist` also trusts `dsh.tailc2559b.ts.net`, so the event service can take over the Tailscale name of the interactive instance it replaces without a plist change.
- Models route through OpenRouter: `lsy/deploy/home.cordis.patch.yml` (installed as `$DSH_HOME/cordis.patch.yml`) enables the `openrouter` route of `llm-pi-ai` keyed by `OPENROUTER_API_KEY` and makes `deepseek/deepseek-v4.1-flash` the default model. Verified with `--dump-config` and a headless request that reached OpenRouter. `RUNBOOK.md` step 5 now covers the OpenRouter key, one classic GitHub token for both GitHub names, the home patch, and logging `gh` in for `git push` (the harness strips credential-shaped variables from agent shells).
- Event service logs move from `~dsh-runtime/Library/Logs/dsh-events/` (inside the 700 `Library`) to `/Users/dsh-runtime/logs/`, which the operator reads without sudo.

### Fixed
- `RUNBOOK.md` step 0: drop the recursive `chown` of `/Volumes/MiniSSD` (with ownership enabled every entry already belonged to `lishuyu`; only the volume root needs it) in favor of a `find` check, stop and restart globalawareness alongside kaorou, and note that `launchctl bootstrap` may report `5: Input/output error` for a service that did start.
