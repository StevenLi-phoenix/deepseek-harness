---
description: "Profile layer for the event service's composer dock pill: the DeepSeek account balance next to the activity and usage pills."
kind: "package-bundle"
---

# @deepseek-ai/provider-balance

English | [中文](README.zh.md)

## Summary

This layer adds one composer dock pill: the DeepSeek account balance, next to the activity and usage pills. It is a single UI row with no tools and no Session behaviour.

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
| `provider-balance` | `@deepseek-ai/dsh-provider-balance` | the balance pill in the composer dock |

### What it needs

A DeepSeek provider route in the profile; without one the pill has nothing to show.

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

- [Provider balance package](../../../packages/fork/provider-balance/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- The pill reads the balance of the configured DeepSeek route only.
