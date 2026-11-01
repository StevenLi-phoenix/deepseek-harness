---
description: "Settings section for QQ: whether the QQ observer is connected, NapCat's login state, and, after QQ signs the account out, the login QR code to scan with the phone, renewed on the page by itself."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-qq-login

English | [中文](README.zh.md)

## Summary

Get QQ back after a sign-out from your phone, with no terminal. **Settings → QQ** gives one verdict ("QQ is connected", "Scan to log in", "NapCat is not answering") with the next step under it. When a scan is needed it draws the login QR code large enough to scan from another screen and follows NapCat's rotation; scan, confirm, and the verdict turns to "connected" within seconds. A second card lists the connection (since when, which attempt, last error) and NapCat's login; a third edits which groups are recorded.

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

Mount the row next to the QQ observer; the fork event bundle mounts it. It needs [`@deepseek-ai/dsh-fork-qq`](../fork-qq/README.md) (`ctx.forkQq`), the `connection` service on the Host, and the settings shell on the browser side, both of which the Web bundles compose. It has no configuration.

```yaml
- id: fork-qq-login
  name: '@deepseek-ai/dsh-fork-qq-login'
```

The QR code comes from NapCat's login through the login door (`fork/deploy/napcat/napcat.sh door`, started with `napcat.sh start`); see [fork-qq](../fork-qq/README.md#use-this-package) for `login.url` and `settingsUrl`. Without the door the section still shows the connection and says how to start it. The recovery steps are in the runbook ([QQ 掉线恢复](../../../fork/deploy/RUNBOOK.md#qq-recovery)).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half registers `GET /api/fork.qq` and `POST /api/fork.qq.refresh` on the connection, so the `/api` sign-in check (owner Peers only, with the Host/Origin fence that also covers the POST) guards both. It builds its answer from `ctx.forkQq`: the connection state, the login reading, and the recorded group count. The login link NapCat gives is turned into a module matrix with `uqr` on the Host and only the matrix is sent, so the browser draws the code from a path of `0`/`1` rows and never sees the link; nothing about the code is logged. `?fresh=1` skips the observer's shared reading (1.5 s, one minute while QQ is connected); the refresh route asks the door for a new code, which is refused while QQ is logged in and for ten minutes after, and otherwise allowed once every 10 s (the answer's `reason` says which).

The recorded-groups card is the one write this section makes. The `groups` field of `fork-qq` is volatile, so the card reads it from the plugin-settings form of the `fork-qq` entry (`ctx.configForms`) and writes the whole new list with `form.set('groups', …)`: the Host validates it, fences it by revision (a list changed elsewhere is refused, not overwritten), saves it to the profile patch, and the observer follows without a restart and backfills an added group. The card lists the groups on the list by name, offers the account's other groups (the busiest first, from the panel; at most 60) with one tap to add, accepts a typed number (3 to 20 digits), and asks twice before removing. Nothing is hand-edited.

The browser half registers one `settings.section` entry (`fork-qq`, after System status) through `ctx.slots.inject`. The shell mounts only the open section, so the section polls the document-relative `api/fork.qq` every 3 seconds while it is open and the page is visible and something needs attention, once a minute while QQ is connected (a connected account has nothing to watch, and every read reaches the account's host), and stops when it closes. One `QqLoader` shares a request in flight; a failed request keeps the last answer and the status line says when it was taken. The verdict is decided by `headline()`: the observer's own connection wins when it is up, otherwise NapCat's login state says what to do, and a door that cannot answer says how to bring it back. The code is an inline SVG (one path of horizontal bars with a two-module quiet zone), black on white whatever the theme, at most 320 px wide.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host half: the two routes |
| [`src/panel.ts`](src/panel.ts) | Answer assembly and the QR matrix |
| [`src/view.ts`](src/view.ts) | Answer types and route paths, shared by both halves |
| [`src/client/index.ts`](src/client/index.ts) | Browser entry: dictionaries, the loader, the Settings section registration |
| [`src/client/qq.ts`](src/client/qq.ts) | Store, loader, and the visibility-aware poller |
| [`src/client/cards.ts`](src/client/cards.ts) | The verdict, the detail rows, and the QR path from an answer |
| [`src/client/QqLogin.tsx`](src/client/QqLogin.tsx) | The section |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [QQ observer](../fork-qq/README.md) — the connection, the login door, and the owner notice this section complements
- [fork-sysmon](../fork-sysmon/README.md) — the System status section whose route and polling this one follows

-----

<a id="model-experience"></a>
## Model Experience

None, as the section is browser chrome; nothing here reaches a model request, and the login code is never given to the agent.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Needs the login door** — without it (`napcat.sh door`) there is no code to show; the section says so and still shows the connection.
- **A screen cannot scan itself** — on a phone, take a screenshot and pick it in QQ's Scan → Album.
- **Editing needs the settings form** — the `fork-qq` entry must be uniquely addressed in a writable layer; if the Host does not serve it (or a higher layer overrides `groups`), the card says so and the list stays in the profile patch.
- **Owner only** — the routes answer the signed-in owner Peer; anyone with the DSH page and its sign-in can scan the code, as they could use the rest of DSH.
- **QQ decides** — NapCat is not an official client, so QQ may ask for a new device check or refuse the login; the section shows NapCat's own error text and the phone shows QQ's.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The browser never talks to NapCat's WebUI: its token can open a shell in the container and read the QQ session, so only the login door (two endpoints) holds it. Rejected: publishing the WebUI port to the service user.
- A "log in again without scanning" button (NapCat's quick login) is not offered: the session that would make it work is the one QQ just signed out.

</details>
