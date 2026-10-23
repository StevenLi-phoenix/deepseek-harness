---
name: dsh-plugin-sourcing
description: Before building any new capability for DeepSeek Harness (a dsh plugin, tool, sensor, channel, UI panel, memory, monitor, provider, or a fork-local packages/lsy package), search the GitHub topic dsh-plugin (the source of truth for dsh plugins) and its market-index mirrors for an existing implementation; download and review the best candidates without running them; install a candidate that meets the requirement and passes review, otherwise reference it and write our own. Use this whenever someone asks to add, build, implement, or "make dsh able to" do something new, even when they do not mention the market or plugins.
---

# Source a DSH capability before building it

The dsh ecosystem moves fast: thousands of community plugins exist, and the capability you are about to write has often been written already. Writing it again costs hours and gives up features that someone else already debugged; installing a stranger's package without reading it hands their code the Host's credentials. This workflow sits between those two failures: look first, read before trusting, then install, borrow, or build.

## 1. Pin down the requirement

Write two or three lines before searching, because the review in step 4 is a comparison against them:

- What the capability must do, observably (inputs, outputs, who sees what).
- Where it runs: Host plugin, preset tool, browser panel, profile patch, skill.
- Hard constraints. In this fork they include: rules enforced in host code, never by prompts (model input and output are untrusted); secrets never printed, logged, or sent to the model; fork-local code lives in `packages/lsy/` (see `lsy/AGENTS.md` and `packages/lsy/UPSTREAM.md`).

## 2. Search, cheapest and most trusted first

1. **This repository.** Upstream may already ship it, possibly off by default: search `packages/` (including `packages/experimental/`), `apps/cli/config/examples/`, and `docs/user/guide/` for the capability's nouns. Example: memory was already covered by `docs/user/guide/mcp-memory.md` (three MCP memory servers).
2. **The GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin): the source of truth.** dsh plugins are published as GitHub repositories tagged `dsh-plugin`; every market index and awesome list is crawled from that topic, so search it directly:

   ```sh
   gh search repos --topic dsh-plugin <word> [word...] --sort updated --limit 30 \
     --json fullName,description,stargazersCount,updatedAt,url
   ```

   Try a few phrasings, and Chinese terms too: many descriptions are bilingual. Stars and recent updates help rank, but neither substitutes for the review in step 4.
3. **Mirrors, for extra metadata.** Indexes add what GitHub search lacks, such as `engines.dsh` and the npm package name. A dsh agent with the `plugin_market` tool searches the indexes its profile configures; otherwise the bundled script validates each index with the repo's own `parseMarketIndex` and matches every word:

   ```sh
   pnpm exec tsx .agents/skills/dsh-plugin-sourcing/scripts/search-market.mts <word> [word...]
   ```

   Its default indexes (jsDelivr `dsh-plugin-catalog`, `wangyutansheng/dsh-market-index`) are third-party crawls of the topic and can lag it; `npm search --json "dsh <words>"` finds packages that were published without a topic.

Record the queries you ran; step 6 reports them.

## 3. Shortlist

Keep at most three candidates. Prefer, in order: covers the requirement without extra machinery you would have to disable; compatible `engines.dsh` / `@deepseek-ai/*` peer ranges for the running DSH version (`dsh --version`, or the root `package.json` version in this repo); recently published and maintained; a license that allows what you intend (installing is fine for any license; copying code needs a permissive one plus attribution).

## 4. Download and review without running anything

Fetch into a fresh scratch directory, never into the repo or a profile, and never with `npm install` (that runs lifecycle scripts):

```sh
mkdir -p "$SCRATCH/review/<name>" && cd "$SCRATCH/review/<name>"
npm pack <name>@<exact-version> && tar -xzf ./*.tgz            # npm source
git clone --depth 1 <repo-url> src                              # git source; check out the listed commit
```

Read the source the way an attacker would have written it:

- `package.json`: `preinstall` / `install` / `postinstall` / `prepare` scripts, unusual dependencies, `bin` entries, `engines.dsh` and peers.
- What it registers in DSH: Cordis services, web routes (are they behind `/api` sign-in or self-authenticated?), model tools and their descriptions, prompt or context injection, patches that disable or replace built-in rows.
- Side effects: network hosts it contacts (telemetry, update checks, uploads), `child_process`, writes outside `$DSH_HOME` and the session workspace, reads of `.env`, credentials, keychains, or other profiles.
- Red flags: obfuscated or minified-only code with no source, `eval` / `new Function`, dynamic `require` of remote code, postinstall downloads.
- Fit: compare against step 1 line by line, including the hard constraints, and check for overlap with packages already mounted (two plugins registering the same tool name, route, or slot conflict).

## 5. Decide

| Outcome | When | Then |
|---|---|---|
| **Install** | Meets the requirement, passes review, compatible, no conflict | Install the exact reviewed version (below). |
| **Reference** | Useful design or code, but it conflicts, fails review, is incompatible, or does more than we want | Do not install. Write our own (a `packages/lsy/` package in this fork) using it as the reference; copy code only under a compatible license, with attribution. |
| **Build** | Nothing fits | Write it ourselves, and note that the market was searched. |

Installing, always pinned to the version you reviewed:

- Interactive profile: `dsh plugin --profile <profile> add <name>@<version>` (forwards to pnpm with DSH's compatibility check), or `plugin_manager` → `install_bundle` with the target `plugin_market` returned, or the Web UI's Plugins → Discover.
- The lsy event service (runs as `dsh-runtime`):

  ```sh
  sudo -n -u dsh-runtime /usr/bin/env HOME=/Users/dsh-runtime DSH_HOME=/Users/dsh-runtime/.dsh PATH=/opt/homebrew/bin:/usr/bin:/bin \
    node /Users/Shared/lsy-dsh/current/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile event add <name>@<version>
  sudo -n /bin/launchctl kickstart -k system/app.lishuyu.dsh-events
  ```

  `setup-profile.sh` merges the profile manifest on upgrades, so the dependency survives new builds.
- pnpm 11 blocks dependency build scripts; approve one only after reading exactly what it runs.
- Verify after install: the plugin loads (service log), its tool or route works once, nothing it replaced broke.

## 6. Record and report

- In this fork: one `lsy/CHANGELOG.md` entry (Added) naming the package, version, and why. A referenced project goes in the new package README's Dev Note ("follows <repo> (<license>) at <version or commit>"); a built-from-scratch one notes the searches that found nothing.
- When something we built is published as its own repository, tag it so the next person finds it where they look: `gh repo edit <owner>/<repo> --add-topic dsh-plugin`.
- Tell the requester, briefly: the queries, the candidates and the verdict for each with the deciding reason, and what was installed, referenced, or built.
