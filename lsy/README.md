# lsy — event-driven agent service (fork-local)

Deployment files for running this fork as an always-on, event-driven agent service on a Mac mini: sensors poll GitHub and local processes, the bus decides what matters, and an unattended agent or a phone notification handles it. Code lives in [`packages/lsy/`](../packages/lsy/README.md); this directory holds the profile, service definitions, and runbooks.

## Layout

| Path | Contents |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | Fork-local changes (Keep a Changelog) |
| [`../packages/lsy/UPSTREAM.md`](../packages/lsy/UPSTREAM.md) | Upstream baseline, copied packages, touched upstream files, upgrade procedure |

## Checks for the lsy group

```sh
pnpm exec vitest run packages/lsy
pnpm exec vitest run packages/lsy --coverage --coverage.include='packages/lsy/*/src/**/*.ts'
pnpm exec tsc -b packages/lsy/lsy-event-bus packages/lsy/lsy-telegram
pnpm exec tsx scripts/run-oxlint.ts packages/lsy
pnpm run constraints && pnpm run verify-product-use && pnpm run verify-tsconfig-paths
pnpm run verify-translation-pairing packages/lsy/README.md packages/lsy/*/README.md
```
