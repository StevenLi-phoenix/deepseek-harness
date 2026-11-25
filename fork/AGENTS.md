# AGENTS.md — fork layer

These rules supplement the repo-wide [AGENTS.md](../AGENTS.md) for `packages/fork/*` and `fork/`. Product docs: [README](README.md), [deploy/RUNBOOK.md](deploy/RUNBOOK.md), [CHANGELOG](CHANGELOG.md), [upstream ledger](../packages/fork/UPSTREAM.md).

## Fork rules

- Work on `main` and push to `origin` (`StevenLi-phoenix/deepseek-harness`). Upstream syncs follow the ledger's upgrade procedure.
- Every edit outside `packages/fork/` and `fork/` is an upstream-file edit: add its file and change to the ledger's "Upstream files touched" table in the same commit.
- Record fork changes in [CHANGELOG.md](CHANGELOG.md) (Keep a Changelog sections under `[Unreleased]`).
- **Name by function, never by person.** Packages, services, storage domains, routes, env names, and keys say what they do (`gmail`, `ctx.gmail`, `GMAIL_CLIENT_ID`), qualified where upstream uses the word (`owner-memory`); never a person's name or initials (this repository is public; `deploy/check-owner-names.mjs` enforces it). The owner-named prefix stays for what is personal or meaningless outside this deployment (the résumé writer, the owner's data tools), outside this repository.
- Before adding a client, scheduler, budget, notifier, classifier, key, or deploy script, check `packages/fork`, the Web UI's Remote API, AMS, `https://registry.lishuyu.app`, and the GitHub topic `dsh-plugin`. A new one says in its commit why those do not do.

## Memory and persona safety

- **Learning happens in data, never in the persona.** The persona is read-only bundle text reviewed in git. What the agent learns goes only into bounded containers (`owner-memory`, the Bilibili journal) that record their source, are visible and deletable to the owner, and enter prompts as data. Keep `packages/fork/bili/tests/persona.spec.ts` green.
- **A stranger's words are not the owner's.** A turn a relayed message, web page, event, or QQ group starts is not the owner's; `hold` and `enforce`, off by owner choice (RUNBOOK), stop its protected writes and Claude Code messages ([turn-taint](../packages/fork/turn-taint/README.md)).
- **DSH's speaking style is strangers' words in the prompt** ([`speaking-style`](../packages/fork/speaking-style/README.md)). Inputs stay QQ, Bilibili, and public web pages (never owner-memory, WeChat, or the owner's messages); outputs stay style, with no fact or name of anyone; every public write passes `ctx.contentGuard` and is refused without it; all of it is visible and deletable in Settings → 说话风格. Never widen it to instructions, facts, or other inputs without the owner deciding.
- **Text others can read goes through `ctx.contentGuard.check(text, { purpose, audience })`** ([`content-guard`](../packages/fork/content-guard/README.md)), which fails closed. New writers of shared or public text call it instead of adding their own PII patterns. Never log the text or a canary value; keep honeypot and canary strings out of this public repository (profile patch and `$DSH_HOME/content-guard/canaries.txt` only).

## Event service architecture

- **The main agent takes only summaries from other Sessions**, besides the owner's own messages and its own schedule. A route that should reach it goes through a Session with `result: main` (normally the notification desk), and its monitors publish events for the desk instead of waking it. Nothing else wakes the chat Session: an alert, a log line, or a monitor's output goes to a Session first.
- **The owner hears only the main agent.** Every note for the owner (`ctx.ownerNotifier.send()`) becomes a turn of the chat Session (`wechat` `chat.notes: turn`), and the main agent tells the owner in its own words or answers `NO_REPLY`; the host never sends text it built itself. Name the sender in `OwnerNote.origin`, mark what cannot wait `urgent` (its answer passes do-not-disturb), and keep a plugin's note rare and already filtered. Only `safety` notes, and notes the chat cannot take, go as written.
- **The message flow page is generated.** `flow-live.ts` draws every route from what it really does, so change the route to change the picture; `flow-graph.ts` only places the boxes and draws what no route carries.
- **AMS is the only process supervisor.** Declare any long-running process beside `dsh-events` on the mini to AMS (`service.toml`, `ams ctl`, `ams secret set`; its error lines reach the escalation journal), never as a LaunchDaemon, LaunchAgent, or notifier of its own. DSH never starts, restarts, or takes over an AMS service, and no service migrates into a DSH profile: two supervisors fight, and a supervised process must outlive the harness. DSH adds observation (mount failures, disposal, a tool failing repeatedly, a Session ending badly) as events for the owning channel, once per problem and once on recovery.
- **A plugin is a whole feature by itself.** Installing one package must be enough: it brings its own dependencies, owns its processes (for example its browser, its profile directory, its lifecycle) and works with no sibling plugin mounted first beyond the platform. An external-service connector is the stated exception — depending on the outside service is its job.
- **Processes talk through versioned APIs.** DSH and a split-out service exchange versioned DTOs over a unix socket, HTTP, or a pipe; neither opens the other's database, WAL, or state files.
- Architecture: [package table and READMEs](../packages/fork/README.md), [subsystem page](../docs/subsystems/fork.md), [runbook](deploy/RUNBOOK.md).

## Profile layering

The `event` profile composes the base and Web bundles, the service skeleton `@deepseek-ai/dsh-event-bundle`, one bundle per feature under `fork/bundles/<feature>/` in the order [profiles/event/package.json](profiles/event/package.json) lists, the owner's profile patch, and the home patch. [bundles/event/README.md](bundles/event/README.md) owns the layer table and ordering rules; the [runbook](deploy/RUNBOOK.md) owns the patches on the mini.

- A feature's rows and presets live in its own bundle; list a new bundle in the profile manifest, or `setup-profile.sh` fails.
- A patch entry's `config` replaces the lower layer's whole `config`; restate every field.
- Verify a layering change with `pnpm dsh event --dump-config`; each row names its layer.

## Checks and regeneration

- [README.md](README.md#checks-for-the-fork-group) lists the fork checks. Fork CI runs every gate on each push to `main`; read it with `gh run list --workflow "Fork CI"`.
- After changing a Service Definition or an `@Remote` method, run `pnpm exec tsx scripts/build.ts --scope typecheck` (typechecks read built declarations), then `pnpm run gen-cordis-catalog`.
- After editing a README and its `.zh.md`, run `pnpm run verify-translation-pairing <README.md> --write`.
- Keep `TMPDIR` short: a tsx IPC socket path over 104 bytes fails with `listen EINVAL`.

## Deployment (Mac mini)

Push to `main`, then from any checkout with `ssh mini` run `fork/deploy/deploy-dsh.sh --plan` (hot or restart, and why) and `fork/deploy/deploy-dsh.sh` (exits 0 only when that commit runs). This is the only deploy path; the [runbook](deploy/RUNBOOK.md) owns the service account, paths, the hot path (§21), and first installs. Service secrets live in `/Users/dsh-runtime/.dsh/.env` and `.credentials.yaml`; use them only through shell substitution, and redact the first-login token URL when reading `stdout.log`.
