---
description: "Profile layer for the event service's GitHub integration: the App webhook route and the sensor that turns deliveries and polling into bus events."
kind: "package-bundle"
---

# @deepseek-ai/github

English | [中文](README.zh.md)

## Summary

This layer mounts the GitHub end of the event service. GitHub posts to the App route, whose HMAC check is the only trust boundary, and the sensor turns deliveries and its polling into bus events. The bus then decides what reaches a Session; the layer adds no subscription itself.

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
| `webhook-github` | `@deepseek-ai/dsh-webhook-github` | the `POST /hooks/github` route: source `github-app`, secret `GITHUB_WEBHOOK_SECRET` |
| `github-sensor` | `@deepseek-ai/dsh-github-sensor` | deliveries and polling turned into bus events |

### What it needs

The event bus, which the sensor publishes to, and the `GITHUB_WEBHOOK_SECRET`, `GITHUB_SENSOR_TOKEN` and optional `GITHUB_SENSOR_NOTIFICATIONS_TOKEN` secrets the plugin reads from the credential store or `$DSH_HOME/.env`.

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

- [GitHub sensor package](../../../packages/fork/github-sensor/README.md)
- [Event bundle](../event/README.md)

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Without the secret the route refuses every delivery; the sensor keeps polling for what it can read.
