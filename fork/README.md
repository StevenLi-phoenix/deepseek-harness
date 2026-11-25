# fork — event-driven agent service (fork-local)

English | [中文](README.zh.md)

Deployment files for running this fork as an always-on, event-driven agent service on a Mac mini: the owner talks to the agent on WeChat, the agent creates its own watches and reminders, sensors poll GitHub, the bus decides what matters, and an unattended agent run or a WeChat message handles it. Code lives in [`packages/fork/`](../packages/fork/README.md); this directory holds the profile, service definitions, and runbooks.

## Layout

| Path | Contents |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | Fork-local changes (Keep a Changelog) |
| [`bundles/event/`](bundles/event/) | `@deepseek-ai/dsh-event-bundle`: the event service skeleton as a bundle layer (webhook runtime, owner relay, event bus and its subscriptions, ingest, the console and settings rows, the `notify` and `unattended` presets; routing state lives in storage and is managed by the agent's tools). Every feature is a bundle of its own beside it, mounted after it: `github`, `headless-browser`, `provider-balance`, `subagent-activity`, `sysmon`, `memory`, `presence`, `wechat`, `cc-admin`, `voice`, `bili`, `qq`, `courses`, `gmail`, `qqbot`, `integrity`, `guard`, `style` ([`bundles/event/README.md`](bundles/event/README.md) holds the mount order) |
| [`profiles/event/`](profiles/event/) | Event profile: `package.json` (Web bundles, the skeleton, then one bundle per feature in mount order) and `cordis.patch.yml`, the owner's empty patch layer that Web UI settings write to |
| [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) | Isolated deployment on the Mac mini: `dsh-runtime` user, LaunchDaemon, secrets, WeChat binding, verification |
| [`deploy/`](deploy/) | `install-app.sh`, `setup-profile.sh` (links plugins and every fork bundle; creates the owner layer once), `check-setup-profile.sh <installed prefix>` (checks fresh, migrated, and re-run homes; `upgrade.sh` runs it before switching `current`), `upgrade.sh`, `wechat-login.mjs`, `home.cordis.patch.yml`, LaunchDaemon template |
| [`../packages/fork/UPSTREAM.md`](../packages/fork/UPSTREAM.md) | Upstream baseline, copied packages, touched upstream files, upgrade procedure |

## Checks for the fork group

```sh
node fork/deploy/check-owner-names.mjs
pnpm exec vitest run packages/fork
pnpm exec vitest run packages/fork --coverage --coverage.include='packages/fork/*/src/**/*.ts'
pnpm exec tsc -b packages/fork/cc-bridge packages/fork/event-bus packages/fork/github-sensor packages/fork/tool-watch packages/fork/wechat packages/fork/qq packages/fork/qqbot packages/fork/tool-qq packages/fork/speaking-style packages/fork/content-guard packages/fork/provider-balance packages/fork/bili packages/fork/tool-bili
pnpm exec tsc -p tsconfig.host.json --noEmit   # also type-checks tests
pnpm exec tsx scripts/run-oxlint.ts packages/fork fork/deploy
pnpm run constraints && pnpm run verify-product-use && pnpm run verify-tsconfig-paths
pnpm run verify-translation-pairing packages/fork/README.md packages/fork/*/README.md fork/README.md docs/subsystems/fork.md
pnpm run verify-package-readme-model-experience && pnpm run verify-package-readme-summaries
pnpm run verify-config-catalog && pnpm run verify-cordis-catalog && pnpm run verify-md-links
```

`tsconfig.host.json` excludes `*.client.spec.*` tests; they type-check in the Client aggregate, `tsconfig.client.json`.

On GitHub, [`.github/workflows/fork-ci.yml`](../.github/workflows/fork-ci.yml) runs the pull-request gates of `ci.yml` on every push to `main` on hosted runners: static gates, typecheck and lint, coverage at 100% per file in six shards, and the build. A run in progress is never cancelled; a failed run reaches the owner through the `ci` route. The repository keeps the `CI master` workflow disabled (`gh workflow enable "CI master"` turns it back on): its push jobs wait for upstream's self-hosted runners and secrets.

## Run the event profile from source

```sh
export DSH_HOME=/path/to/test-home            # never the live ~/.dsh
fork/deploy/setup-profile.sh "$DSH_HOME" "$PWD" # links the plugins and all 19 fork bundles
pnpm dsh event --dump-config | less            # composed tree, with the layer that set each row
pnpm dsh event --port 3092 --no-open           # Web UI + sensors + bus + WeChat channel
```

Without `$DSH_HOME/wechat/account.json` the WeChat channel idles and queues notifications. Watches are created from a Session with the `unattended` preset (`watch_create`); a `$DSH_HOME/cordis.patch.yml` can still override any row for experiments.
