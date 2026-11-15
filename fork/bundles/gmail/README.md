---
description: "Profile layer for the event service's Gmail accounts: ctx.gmail with its per-account send policy, drafts, attachments and label changes, and Settings → 邮箱."
kind: "package-bundle"
---

# @deepseek-ai/gmail

English | [中文](README.zh.md)

## Summary

This layer mounts the owner's Gmail accounts: one Google sign-in per account with only `gmail.modify`, the Gmail REST API, per-account send policies, drafts, attachments and label changes, and Settings → 邮箱 for the OAuth client and the held messages. Reading mail counts as strangers' words, so a send after it waits for the owner.

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
| `gmail` | `@deepseek-ai/dsh-gmail` | the accounts, the send gate, drafts and labels |
| `gmail-settings` | `@deepseek-ai/dsh-gmail-settings` | Settings → 邮箱: OAuth client, connections, held messages |

### What it needs

`GMAIL_CLIENT_ID` and the per-account grants in the credential store, and the `tool-gmail` row inside `preset-unattended`.

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

- [Gmail package](../../../packages/fork/gmail/README.md)
- [Gmail tools](../../../packages/fork/tool-gmail/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Only the `gmail.modify` scope is requested; no other Google service is reachable.
- At most 50 sends per account in 24 hours, and a changed draft is never sent.
