---
description: "Profile layer for the event service's headless browser: one persistent Chromium the agent drives with tools, with a page for a person to take over."
kind: "package-bundle"
---

# @deepseek-ai/headless-browser

English | [中文](README.zh.md)

## Summary

This layer mounts one persistent headless Chromium. The agent drives it with tools, and a person takes over at `/headless-browser` for a sign-in or a CAPTCHA. Its profile directory keeps the sign-in across restarts, so the layer needs a writable home but no per-deployment edit.

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
| `headless-browser` | `@deepseek-ai/dsh-headless-browser` | one persistent Chromium and its take-over page |

### What it needs

Nothing from another feature: the browser package owns its own process, profile directory and lifecycle.

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

- [Headless browser package](../../../packages/browser-use/README.md)
- [Event bundle](../event/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- One browser per home: a second row would fight the first for the profile directory.
