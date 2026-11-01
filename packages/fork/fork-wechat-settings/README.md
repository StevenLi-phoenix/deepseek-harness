---
description: "Browser half of Settings → WeChat (bind the owner's bot by QR code, channel health, reply window, unbind) and Settings → 勿扰 (quiet hours: Sleep Focus, daily window, buttons, iPhone Shortcut steps); the Host routes are served by fork-wechat and fork-presence."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-wechat-settings

English | [中文](README.zh.md)

## Summary

Manage the owner's WeChat channel and quiet hours from any browser. **Settings → WeChat** binds the bot by QR code, shows whether it is bound, the long-poll's health, the reply window and the outbox, and unbinds after a second click. **Settings → 勿扰** shows whether you count as asleep and why, holds non-urgent messages until you wake, and carries the iPhone Shortcut setup. Both pages poll every few seconds while open and pause while the page is hidden.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the row next to the Web bundles; the fork event bundle mounts it. It needs the settings shell (`@deepseek-ai/dsh-client-ui-settings-general`, which declares the `settings.section` list). The pages are useful once their Host routes exist: `/api/fork.wechat` comes with [`@deepseek-ai/dsh-fork-wechat`](../fork-wechat/README.md#understand-the-implementation) and `/api/fork.presence` with [`@deepseek-ai/dsh-fork-presence`](../fork-presence/README.md), each mounted by its own row.

```yaml
- id: fork-wechat-settings
  name: '@deepseek-ai/dsh-fork-wechat-settings'
```

The package has no configuration. Its sections are `fork-wechat` (order 52) and `fork-presence` (order 53), with dictionaries in eight languages.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, so the plugin appears in the Loader and the browser half (`exports["./client"]`, found through `dsh.client` in `package.json`) is delivered. The routes are not here because they need the live channel and the presence service, which a package with a browser face may not import at runtime; the Host packages keep them and stay host-only. The wire types the routes answer (`src/wechat-view.ts`, `src/presence-view.ts`) are copies of `fork-wechat/src/view.ts` and `fork-presence/src/view.ts`; a test in each Host package fails when the copy differs by one byte.

Each page has one store and one loader that share a request in flight, keep the last view when a request fails, and post the page's actions to the same route. The WeChat page also polls an open QR login every 2 seconds, draws the code from the module rows the Host sends (an SVG path on a white card, so it scans in a dark theme too), and offers the link only when it is an HTTPS link on a WeChat domain. Neither page shows a token or a message text: the Host masks ids and answers times, counts, and codes, and the Shortcut instructions name the environment variable that holds the ingest token, never its value.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Node half: the empty `apply` |
| [`src/wechat-view.ts`](src/wechat-view.ts), [`src/presence-view.ts`](src/presence-view.ts) | Byte-identical copies of the Host packages' wire types |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: registers both sections |
| [`src/client/wechat/`](src/client/wechat) | The WeChat section: store, loader, pollers, QR drawing, the section, dictionaries |
| [`src/client/presence/`](src/client/presence) | The quiet-hours section: store, loader, poller, the section, dictionaries |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [fork-wechat](../fork-wechat/README.md) — the channel and the `/api/fork.wechat` route
- [fork-presence](../fork-presence/README.md) — presence and the `/api/fork.presence` route
- [Settings domain](../../client/ui-settings/README.md) — the `settings.section` slot these sections fill
- [fork-memory-admin](../fork-memory-admin/README.md) — the browser-only package whose layout this follows

-----

<a id="model-experience"></a>
## Model Experience

None, as the sections are browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Two copies of the wire types** — a change to a Host `view.ts` needs the same change in this package; the Host tests fail until it is made.
- **Only while open** — nothing is polled while nobody has a section open.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The two pages share one package because they are small and ship together; splitting them would need a second package with the same layout.

</details>
