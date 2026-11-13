# AGENTS.md — fork fork layer

These rules supplement the repo-wide [AGENTS.md](../AGENTS.md) for `packages/fork/*` and `fork/`. Product docs: [README](README.md), [deploy/RUNBOOK.md](deploy/RUNBOOK.md), [CHANGELOG](CHANGELOG.md), [upstream ledger](../packages/fork/UPSTREAM.md).

## Fork rules

- Work on `main` and push to `origin` (`StevenLi-phoenix/deepseek-harness`). Upstream syncs follow the ledger's upgrade procedure.
- Every edit outside `packages/fork/` and `fork/` is an upstream-file edit: add its file and change to the ledger's "Upstream files touched" table in the same commit.
- Record fork changes in [CHANGELOG.md](CHANGELOG.md) (Keep a Changelog sections under `[Unreleased]`).
- **Never prefix a new name with `fork`.** Name packages, services, storage domains, routes, locale namespaces, and keys by function (`gmail`, `tool-gmail`, `ctx.gmail`, `GMAIL_CLIENT_ID`); `fork` is the owner's initials, and this repository is public. Existing `fork-*` names stay until a planned rename.
- Before adding a client, scheduler, budget, notifier, classifier, key, or deploy script, check `packages/fork`, the Web UI's Remote API, AMS, `https://registry.lishuyu.app`, and the GitHub topic `dsh-plugin`. A new one says in its commit why those do not do.

## Memory and persona safety

- **Learning happens in data, never in the persona.** The persona is read-only bundle text reviewed in git. What the agent learns goes only into bounded containers (`fork-memory`, the Bilibili journal) that record their source, are visible and deletable to the owner, and enter prompts as data. Keep `packages/fork/bili/tests/persona.spec.ts` green.
- **A stranger's words are not the owner's.** A turn a relayed message, web page, event, or QQ group starts is not the owner's; `hold` and `enforce`, off by owner choice (RUNBOOK), stop its protected writes and Claude Code messages ([fork-taint](../packages/fork/fork-taint/README.md)).
- **DSH's speaking style is strangers' words in the prompt** ([`fork-style`](../packages/fork/fork-style/README.md)). Inputs stay QQ, Bilibili, and public web pages (never fork-memory, WeChat, or the owner's messages); outputs stay style, with no fact or name of anyone; every public write passes `ctx.forkGuard` and is refused without it; all of it is visible and deletable in Settings → 说话风格. Never widen it to instructions, facts, or other inputs without the owner deciding.
- **Text others can read goes through `ctx.forkGuard.check(text, { purpose, audience })`** ([`fork-guard`](../packages/fork/fork-guard/README.md)), which fails closed. New writers of shared or public text call it instead of adding their own PII patterns. Never log the text or a canary value; keep honeypot and canary strings out of this public repository (profile patch and `$DSH_HOME/fork-guard/canaries.txt` only).

## Event service architecture

- **The main agent takes only summaries from other Sessions**, besides the owner's own messages and its own schedule. A route that should reach it goes through a Session with `result: main` (normally the notification desk), and its monitors publish events for the desk instead of waking it. Nothing else wakes the chat Session: an alert, a log line, or a monitor's output goes to a Session first.
- **The message flow page is generated.** `flow-live.ts` draws every route from what it really does, so change the route to change the picture; `flow-graph.ts` only places the boxes and draws what no route carries.
- **Resident processes are AMS services.** Declare any long-running process beside `dsh-events` on the mini to AMS (`service.toml`, `ams ctl`, `ams secret set`; its error lines reach the escalation journal and ga-watch), never as a new LaunchDaemon, LaunchAgent, or notifier of its own.
- **Processes talk through versioned APIs.** DSH and a split-out service exchange versioned DTOs over a unix socket, HTTP, or a pipe; neither opens the other's database, WAL, or state files.
- Architecture: [package table and READMEs](../packages/fork/README.md), [subsystem page](../docs/subsystems/fork.md), [runbook](deploy/RUNBOOK.md).

## Profile layering

The `event` profile composes, in order: the base and Web bundles; `@deepseek-ai/dsh-fork-event-bundle` ([bundles/event/](bundles/event/), code-owned); the profile patch `$DSH_HOME/profiles/event/cordis.patch.yml` (the owner's layer, seeded once from [profiles/event/cordis.patch.yml](profiles/event/cordis.patch.yml); Web UI settings save here); and the home patch `$DSH_HOME/cordis.patch.yml` ([deploy/home.cordis.patch.yml](deploy/home.cordis.patch.yml)).

- A patch entry's `config` replaces that entry's whole `config`; restate every field the lower layer set.
- The Web UI refuses to save any entry the home patch sets, so the home patch holds only deployment fixtures the UI does not edit.
- `setup-profile.sh` never replaces the owner's layer; it merges the manifest and relinks plugins and the bundle.
- Verify a layering change with `pnpm dsh event --dump-config` (installed build: runbook, Operate); each row names the layer that set it.

## Checks and regeneration

- The fork check list is in [README.md](README.md#checks-for-the-fork-group). One file or test: `pnpm exec vitest run packages/fork/fork-wechat/tests/text.spec.ts -t relayText`.
- Typechecks read built declarations and Typert-generated remote clients (`packages/api/*/lib/typert.remote-client.d.ts`). After changing a Service Definition or an `@Remote` method, run `pnpm exec tsx scripts/build.ts --scope typecheck`; a stale build surfaces as "Property … does not exist" in consumers.
- After changing a Service Definition, run `pnpm run gen-cordis-catalog` (API catalog and `docs/subsystems/*` regions) before `verify-cordis-catalog`.
- After editing a README and its `.zh.md`, run `pnpm run verify-translation-pairing <README.md> --write`, then again without `--write`.
- Keep `TMPDIR` short for builds: a tsx IPC socket path over 104 bytes fails with `listen EINVAL`.

## Deployment (Mac mini)

The [runbook](deploy/RUNBOOK.md) owns the service account, paths, and procedure. Push to `main`, then deploy from any checkout with `ssh mini`:

```sh
fork/deploy/deploy-dsh.sh --plan   # says whether this commit goes hot or restarts, and why
fork/deploy/deploy-dsh.sh          # deploys it, waits, and exits 0 only when that commit runs
```

- This is the only deploy path. `upgrade.sh` and `launchctl kickstart` are for a first install, or when `dsh-upgrade` itself cannot run.
- Keep what you change on the hot path when you can (runbook §21).
- Service secrets live in `/Users/dsh-runtime/.dsh/.env` and `.credentials.yaml`; use them only through shell substitution. `stdout.log` carries the first-login token URL: redact it when reading.
