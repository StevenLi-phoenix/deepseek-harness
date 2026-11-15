---
description: "Profile layer for the event service's speaking style: persona card, traits, memes, tone samples, and Settings → 说话风格."
kind: "package-bundle"
---

# @deepseek-ai/style

English | [中文](README.zh.md)

## Summary

This layer mounts DSH's speaking style: the persona card written with `persona_update`, traits of the groups' tone and the memes written with `style_note`, a meme miner, HotWatch's meme domain behind `meme_lookup`, and tone samples collected from the recorded QQ groups and public Bilibili comments. Every public write passes `ctx.contentGuard` and is refused while it is not mounted; the owner edits or deletes everything on the page.

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
| `speaking-style` | `@deepseek-ai/dsh-speaking-style` | the style store, the miner, and `meme_lookup`'s index |
| `speaking-style-settings` | `@deepseek-ai/dsh-speaking-style-settings` | Settings → 说话风格: card, traits, memes, tone samples |

### What it needs

`ctx.contentGuard` for every public write, and the QQ or Bilibili reads it mines (empty until those features are mounted).

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

- [Speaking style package](../../../packages/fork/speaking-style/README.md)
- [Content guard](../guard/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Inputs stay QQ, Bilibili and public web pages: never owner memory, WeChat, or the owner's messages.
- `review: required` holds new tone samples until the owner keeps them.
