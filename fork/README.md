# fork — event-driven agent service (fork-local)

Deployment files for running this fork as an always-on, event-driven agent service on a Mac mini: sensors poll GitHub and local processes, the bus decides what matters, and an unattended agent or a phone notification handles it. Code lives in [`packages/fork/`](../packages/fork/README.md); this directory holds the profile, service definitions, and runbooks.

## Layout

| Path | Contents |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | Fork-local changes (Keep a Changelog) |
| [`../packages/fork/UPSTREAM.md`](../packages/fork/UPSTREAM.md) | Upstream baseline, copied packages, touched upstream files, upgrade procedure |

## Checks for the fork group

```sh
pnpm exec vitest run packages/fork
pnpm exec vitest run packages/fork --coverage --coverage.include='packages/fork/*/src/**/*.ts'
pnpm exec tsc -b packages/fork/fork-event-bus packages/fork/fork-telegram
pnpm exec tsx scripts/run-oxlint.ts packages/fork
pnpm run constraints && pnpm run verify-product-use && pnpm run verify-tsconfig-paths
pnpm run verify-translation-pairing packages/fork/README.md packages/fork/*/README.md
```
