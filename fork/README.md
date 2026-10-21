# fork — event-driven agent service (fork-local)

Deployment files for running this fork as an always-on, event-driven agent service on a Mac mini: sensors poll GitHub and local processes, the bus decides what matters, and an unattended agent or a phone notification handles it. Code lives in [`packages/fork/`](../packages/fork/README.md); this directory holds the profile, service definitions, and runbooks.

## Layout

| Path | Contents |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | Fork-local changes (Keep a Changelog) |
| [`profiles/event/`](profiles/event/) | Event profile: `package.json` (bundles) and `cordis.patch.yml` (composition layer, code-owned) |
| [`profiles/event/home.patch.example.yml`](profiles/event/home.patch.example.yml) | Routing layer template for `$DSH_HOME/cordis.patch.yml` (deployment-owned) |
| [`../packages/fork/UPSTREAM.md`](../packages/fork/UPSTREAM.md) | Upstream baseline, copied packages, touched upstream files, upgrade procedure |

## Checks for the fork group

```sh
pnpm exec vitest run packages/fork
pnpm exec vitest run packages/fork --coverage --coverage.include='packages/fork/*/src/**/*.ts'
pnpm exec tsc -b packages/fork/fork-event-bus packages/fork/fork-telegram packages/fork/fork-github-sensor
pnpm exec tsc -p tsconfig.host.json --noEmit   # also type-checks tests
pnpm exec tsx scripts/run-oxlint.ts packages/fork
pnpm run constraints && pnpm run verify-product-use && pnpm run verify-tsconfig-paths
pnpm run verify-translation-pairing packages/fork/README.md packages/fork/*/README.md
```

## Run the event profile from source

```sh
export DSH_HOME=/path/to/test-home            # never the live ~/.dsh
mkdir -p "$DSH_HOME/profiles/event"
cp fork/profiles/event/package.json fork/profiles/event/cordis.patch.yml "$DSH_HOME/profiles/event/"
cp fork/profiles/event/home.patch.example.yml "$DSH_HOME/cordis.patch.yml"   # then edit
pnpm dsh event --dump-config | less            # composed tree, with the layer that set each row
pnpm dsh event --port 3092 --no-open           # Web UI + sensors + bus
```

Relative module rows in `$DSH_HOME/cordis.patch.yml` (e.g. `name: ./my-rule.mjs`) resolve against `$DSH_HOME`.
