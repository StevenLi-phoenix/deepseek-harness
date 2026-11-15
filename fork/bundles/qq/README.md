---
description: "Profile layer for the event service's QQ observer: the ctx.qq client of qq-recorder, Settings → QQ, and the qq-digest and qq-main presets."
kind: "package-bundle"
---

# @deepseek-ai/qq

English | [中文](README.zh.md)

## Summary

This layer mounts the QQ observer: `ctx.qq` as a client of the qq-recorder service that holds the one OneBot connection, Settings → QQ with the login QR code, and the two presets that read what it records. `qq-digest` writes one group's digest in that group's own Session; `qq-main` keeps the picture across groups. The agent never speaks on QQ and no tool sends.

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
| `qq` | `@deepseek-ai/dsh-qq` | the observer client: groups, digests, notes, and the recorder settings push |
| `qq-login` | `@deepseek-ai/dsh-qq-login` | Settings → QQ: connection, sign-in state, login QR code |
| `preset-qq-digest` | `@deepseek-ai/dsh-agent-preset` | the `qq-digest` preset: one group, two narrow write tools |
| `preset-qq-main` | `@deepseek-ai/dsh-agent-preset` | the `qq-main` preset: the picture across groups, no tools |

### What it needs

The qq-recorder service on the same Mac (its socket and `QQ_RECORDER_TOKEN`), the `qq` source in the `qq-main` bus subscription, and the `tool-qq` row inside `preset-unattended`.

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

- [QQ package](../../../packages/fork/qq/README.md)
- [QQ tools](../../../packages/fork/tool-qq/README.md)
- [QQ login page](../../../packages/fork/qq-login/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- `groups` starts empty: nothing is recorded until the owner lists group numbers in the profile patch.
- Sending and voice transcription are not offered; a config that enables them fails the load.
