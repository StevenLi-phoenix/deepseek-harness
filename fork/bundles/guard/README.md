---
description: "Profile layer for the event service's content guard: ctx.contentGuard, the one validator for text others can read, and the Settings view of its refusals."
kind: "package-bundle"
---

# @deepseek-ai/guard

English | [中文](README.zh.md)

## Summary

This layer mounts `ctx.contentGuard`, the one validator for text that others can read, and the Settings view of its refusals. Its layers refuse in order: patterns, canaries, overlap with the owner's memory file, and a model on the default route. Every writer of public text calls it, and it fails closed.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

### Install into the event profile

The layer ships with this repository: `fork/deploy/setup-profile.sh` links every directory under `fork/bundles/` into `$DSH_HOME/profiles/event/node_modules/@deepseek-ai/` and writes the profile manifest, so a deploy mounts it without a per-deployment edit. To add it by hand, link it and name it at the end of `dsh.profile.bundles`.

### What you get

| Row | Package | What it mounts |
|---|---|---|
| `content-guard` | `@deepseek-ai/dsh-content-guard` | `ctx.contentGuard` and its layers |
| `content-guard-settings` | `@deepseek-ai/dsh-content-guard/settings` | the guard card: settings and the last 24 hours by rule |

### What it needs

The owner's memory file for the overlap layer, and a model route for the last layer, which is never switched off for a public audience.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The rows are the ones this feature had inside `@deepseek-ai/dsh-event-bundle`, moved here verbatim and in the same relative order. The profile applies every layer as one flattened patch list in `dsh.profile.bundles` order, and an `insert` appends, so this layer mounts after the skeleton rows it uses and before the owner's profile patch. `fork/bundles/event/README.md` holds the mount order and the reasoning.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Content guard package](../../../packages/fork/content-guard/README.md)
- [Speaking style](../style/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- It sees text, not intent, and it can refuse something harmless.
- The Settings view shows counts by rule, never a text.
