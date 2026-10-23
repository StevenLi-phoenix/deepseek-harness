# fork — event-driven agent service (fork-local)

English | [中文](README.zh.md)

Deployment files for running this fork as an always-on, event-driven agent service on a Mac mini: the owner talks to the agent on WeChat, the agent creates its own watches and reminders, sensors poll GitHub, the bus decides what matters, and an unattended agent run or a WeChat message handles it. Code lives in [`packages/fork/`](../packages/fork/README.md); this directory holds the profile, service definitions, and runbooks.

## Layout

| Path | Contents |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | Fork-local changes (Keep a Changelog) |
| [`bundles/event/`](bundles/event/) | `@deepseek-ai/dsh-fork-event-bundle`: the event composition as a bundle layer (code-owned; routing state lives in storage and is managed by the agent's tools) |
| [`profiles/event/`](profiles/event/) | Event profile: `package.json` (Web bundles plus the event bundle) and `cordis.patch.yml`, the owner's empty patch layer that Web UI settings write to |
| [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) | Isolated deployment on the Mac mini: `dsh-runtime` user, LaunchDaemon, secrets, WeChat binding, verification |
| [`deploy/`](deploy/) | `install-app.sh`, `setup-profile.sh` (links plugins and the bundle; creates the owner layer once), `check-setup-profile.sh`, `upgrade.sh`, `wechat-login.mjs`, `home.cordis.patch.yml`, LaunchDaemon template |
| [`../packages/fork/UPSTREAM.md`](../packages/fork/UPSTREAM.md) | Upstream baseline, copied packages, touched upstream files, upgrade procedure |

## Checks for the fork group

```sh
pnpm exec vitest run packages/fork
pnpm exec vitest run packages/fork --coverage --coverage.include='packages/fork/*/src/**/*.ts'
pnpm exec tsc -b packages/fork/fork-event-bus packages/fork/fork-github-sensor packages/fork/fork-tool-watch packages/fork/fork-wechat packages/fork/fork-balance packages/fork/bili packages/fork/tool-bili
pnpm exec tsc -p tsconfig.host.json --noEmit   # also type-checks tests
pnpm exec tsx scripts/run-oxlint.ts packages/fork fork/deploy
pnpm run constraints && pnpm run verify-product-use && pnpm run verify-tsconfig-paths
pnpm run verify-translation-pairing packages/fork/README.md packages/fork/*/README.md fork/README.md docs/subsystems/fork.md
pnpm run verify-package-readme-model-experience && pnpm run verify-package-readme-summaries
pnpm run verify-config-catalog && pnpm run verify-cordis-catalog && pnpm run verify-md-links
```

## Run the event profile from source

```sh
export DSH_HOME=/path/to/test-home            # never the live ~/.dsh
mkdir -p "$DSH_HOME/profiles/event/node_modules/@deepseek-ai"
cp fork/profiles/event/package.json fork/profiles/event/cordis.patch.yml "$DSH_HOME/profiles/event/"
ln -s "$PWD/fork/bundles/event" "$DSH_HOME/profiles/event/node_modules/@deepseek-ai/dsh-fork-event-bundle"
pnpm dsh event --dump-config | less            # composed tree, with the layer that set each row
pnpm dsh event --port 3092 --no-open           # Web UI + sensors + bus + WeChat channel
```

Without `$DSH_HOME/fork-wechat/account.json` the WeChat channel idles and queues notifications. Watches are created from a Session with the `unattended` preset (`watch_create`); a `$DSH_HOME/cordis.patch.yml` can still override any row for experiments.
