# AGENTS.md — lsy fork layer

These rules supplement the repo-wide [AGENTS.md](../AGENTS.md) for this fork's event service: the `packages/lsy/*` plugins and this `lsy/` directory. Product docs: [README](README.md), [deploy/RUNBOOK.md](deploy/RUNBOOK.md), [CHANGELOG](CHANGELOG.md), [upstream ledger](../packages/lsy/UPSTREAM.md), [subsystem page](../docs/subsystems/lsy.md).

## Fork rules

- Work on `lsy/main` and push to `origin` (`StevenLi-phoenix/deepseek-harness`); `master` mirrors the `upstream` remote. Upstream syncs follow the ledger's upgrade procedure.
- Every edit outside `packages/lsy/` and `lsy/` is an upstream-file edit: add its file and change to the ledger's "Upstream files touched" table in the same commit, so a sync can re-apply it.
- Record fork changes in [CHANGELOG.md](CHANGELOG.md) (Keep a Changelog sections under `[Unreleased]`).

## Event service architecture

- `lsy-github-sensor` polls releases, tags, branch commits, and `/notifications`, and publishes `LsyEventInput` rows to `lsy-event-bus`. Its webhook rule turns GitHub App deliveries (relayed by phm's `github-relay` to `/hooks/github`) into events keyed like polling's.
- `lsy-event-bus` dedupes, suppresses the agent's own activity by identity (the `dsh-events[bot]` App login, never model-written text), matches subscriptions (from configuration or created at run time), coalesces, and rate-limits per hour. A batch either goes to `ctx.lsyNotifier` (`notify`) or starts an unattended Session through the webhook runtime (`session`, kind `lsy-event`); first-turn results and unattended reminder turns are reported back. A final answer of exactly `NO_REPLY` sends nothing; `failureDetail()` turns a failed turn's `LlmFailure` into the one-line reason shown to the owner.
- `lsy-wechat` is the owner channel over the iLink bot API: one long-lived chat Session (`/new` starts another), `ctx.lsyNotifier`, a reply window of about 24 hours with about 10 replies per owner message, and an outbox delivered as a digest.
- Agent tools: `lsy-tool-watch` (`watch_create`, `watch_list`, `watch_delete`; time-based checks use built-in `schedule_create`) `lsy-tool-wechat` (`wechat_send_file`, rules enforced in `WechatChannel.sendFile`), and `lsy-memory` (Host-injected memory block per root Session; `memory_search`, `memory_save`, `memory_forget`).
- `lsy-balance` is the only browser plugin: a card in the Account page's `settings.account.balances` slot (fork-added upstream), fed by its Host route `/api/lsy.balance`, which resolves provider keys. Split `tsconfig.host.json`/`tsconfig.client.json`: `*.client.spec.*` tests type-check in the client aggregate.

## Profile layering

The `event` profile composes, in order: the base and Web bundles; `@deepseek-ai/dsh-lsy-event-bundle` ([bundles/event/](bundles/event/), code-owned); the profile patch `$DSH_HOME/profiles/event/cordis.patch.yml` (the owner's layer, seeded once from [profiles/event/cordis.patch.yml](profiles/event/cordis.patch.yml); Web UI settings save here); and the home patch `$DSH_HOME/cordis.patch.yml` ([deploy/home.cordis.patch.yml](deploy/home.cordis.patch.yml)).

- A patch entry's `config` replaces that entry's whole `config`; restate every field the lower layer set.
- The Web UI refuses to save any entry the home patch sets, so the home patch holds only deployment fixtures the UI does not edit.
- `setup-profile.sh` never replaces the owner's layer; it merges the manifest and relinks plugins and the bundle.
- Patch edits reload live; `.env` edits and new builds need a restart.
- Verify a layering change with `DSH_HOME=<home> node <prefix>/node_modules/@deepseek-ai/dsh/lib/bin.js event --dump-config` (from source: `pnpm dsh event --dump-config`); each row names the layer that set it.

## Checks and regeneration

- The lsy check list is in [README.md](README.md#checks-for-the-lsy-group). One file or test: `pnpm exec vitest run packages/lsy/lsy-wechat/tests/text.spec.ts -t relayText`.
- Typechecks read other packages' built declarations and Typert-generated remote clients (`packages/api/*/lib/typert.remote-client.d.ts`). After changing a Service Definition or an `@Remote` method, run `pnpm exec tsx scripts/build.ts --scope typecheck`; a stale build surfaces as "Property … does not exist" in consumers.
- After changing a Service Definition, run `pnpm run gen-cordis-catalog` (API catalog and `docs/subsystems/*` regions) before `verify-cordis-catalog`.
- After editing a README and its `.zh.md` together, run `pnpm run verify-translation-pairing <README.md> --write`, then the check without `--write`.
- `deploy/check-setup-profile.sh <installed prefix>` checks fresh, migrated, and re-run homes; `deploy/upgrade.sh` runs it before switching `current`.
- Do not set `TMPDIR` to a long path for builds: the tsx IPC socket path then exceeds 104 bytes and fails with `listen EINVAL`.

## Deployment (Mac mini)

The [runbook](deploy/RUNBOOK.md) owns the procedure. The service runs as the non-admin user `dsh-runtime` (LaunchDaemon `app.lishuyu.dsh-events`, `127.0.0.1:3081`, served as `https://dsh.tailc2559b.ts.net`); `/Users/lishuyu` and `/Volumes/MiniSSD` are closed to it. Builds install to `/Users/Shared/lsy-dsh/<sha>` behind the `current` symlink; logs are `/Users/dsh-runtime/logs/{stdout,stderr}.log`, and stdout carries the first-login token URL, so redact it when reading.

Upgrade without a password through `/etc/sudoers.d/dsh-events`:

```sh
lsy/deploy/upgrade.sh
sudo -n -u dsh-runtime /usr/bin/env PATH=/opt/homebrew/bin:/usr/bin:/bin /Users/Shared/lsy-dsh/current/lsy/deploy/setup-profile.sh /Users/dsh-runtime/.dsh /Users/Shared/lsy-dsh/current
sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
```

Keep the previous build for rollback. Service secrets live in `/Users/dsh-runtime/.dsh/.env` and `.credentials.yaml`; use them only through shell substitution. The harness strips variables named like `*KEY*`, `*PASSWORD*`, `*SECRET*`, or `*TOKEN*` from agent shells, so the service user's `git push` authenticates through its own `gh` login.
