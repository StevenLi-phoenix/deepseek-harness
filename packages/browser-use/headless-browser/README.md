---
description: "One persistent headless Chromium with model tools and a Web page where the user watches the live frame and takes the page over for a sign-in, a payment, or anything else that needs a human."
kind: "package-reference"
---

# @deepseek-ai/dsh-headless-browser

English | [中文](README.zh.md)

## Summary

Give the agent a browser it keeps between turns and a person a way into it. One headless Chromium runs with its own profile directory, so a sign-in survives a host restart. The model opens pages, takes screenshots, clicks, and types; when a step needs a human, it hands over and returns the page where the user takes control, sees what the agent sees, and hands back. While the user holds the page the agent is refused instead of competing with them.

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

Mount the row once in a Host composition that has the Web server and the tool registry; the browser stays closed until the first tool call or the first opened take-over page.

```yaml
- id: headless-browser
  name: '@deepseek-ai/dsh-headless-browser'
```

| Field | Default | Meaning |
|---|---|---|
| `profileDir` | `$DSH_HOME/data/headless-browser/profile` | Chromium profile directory; cookies, sign-ins, and local storage live here |
| `headless` | `true` | Run without a window; `false` needs a logged-in desktop session |
| `viewportWidth` | `1280` | Page viewport width in CSS pixels |
| `viewportHeight` | `800` | Page viewport height in CSS pixels |
| `jpegQuality` | `60` | JPEG quality of live-view frames |
| `snapshotDir` | `$DSH_HOME/cache/headless-browser/snapshots` | Where `headless_browser_snapshot` writes PNG files |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-headless-browser) lists every accepted field.

### The browser binary

`playwright-core` does not download browsers, so the deployment supplies one Chromium build for the account that runs the Host. Install it once into the account's Playwright cache, or point `PLAYWRIGHT_BROWSERS_PATH` at a shared cache:

```sh
pnpm exec playwright-core install chromium
PLAYWRIGHT_BROWSERS_PATH=/srv/dsh/ms-playwright pnpm exec playwright-core install chromium
```

An unset variable uses the platform cache (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux). A missing binary fails the first tool call with the launcher diagnostic, not at load.

### The take-over page

`headless_browser_hand_over` retakes the URL of `/headless-browser` on the deployment's own server. The page shows the shared page's live frame, the current holder, and the user's controls.

| Route | Purpose |
|---|---|
| `GET /headless-browser` | The page: live frame, holder, take and release buttons, a text field for text that cannot be typed key by key |
| `GET /headless-browser/status` | JSON: `holder`, the user's `reason`, `launched`, `sessionId`, `url`, and the number of connected pages |
| `WS /headless-browser/live` | Frames, control changes, and forwarded input |

Admission is the deployment's, not this package's: the page and status use the Web server's default required policy, so the same Cookie or launch token that opens the Web UI opens them. The live socket additionally requires the owner principal, because whoever holds it can act inside a signed-in profile.

The page's input only reaches the browser while the user holds control. Taking control from the page sets the holder to `human` with the reason "用户从接管页取得控制"; the release button returns it to the agent. Both buttons are the same state transitions as the two control tools.

#### The in-app page

The package's browser half also registers 浏览器接管 as a page of the Web UI: one `main` panel keyed `browser-takeover`, selected by the sidebar row of the same id. The owner reaches the live frame by clicking that row, so the app's address bar keeps its URL instead of navigating below the site root.

The page paints the frames itself; it is not an iframe and opens no sub-URL. It reads the status route and the live socket above with the app's own origin and cookie, and its 接管 and 交回 buttons send the same control messages as this page's buttons, with a different stated reason. The standalone page stays for deployments whose browsers allow it.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `HeadlessBrowserSession` owns the context. The launch is lazy and single-flight, so a tool call and a page view racing each other still start one Chromium; `close()` settles a launch that lost the race. The browser keeps tabs over that one context: the first page is adopted as `t1`, each new tab gets the next id, and a page that closes is replaced so the context and its profile stay open. A launch gets a fresh session id, which the status route reports.

The live view is one CDP screencast per page shared by every connected viewer. `Page.startScreencast` starts for the first viewer and `Page.stopScreencast` stops for the last; every frame is acknowledged before it is fanned out, because Chrome sends the next one only after the ack. Chrome sends frames on repaint, so the hub keeps the last frame: a page that connects to a still page sees the current screen at once instead of a blank area. Frames carry the metadata the page scales pointer input by, and arrive only while the browser page exists.

Input from the page is one JSON message per event. `decodeClientMessage` validates it, `cdpCommand` maps it to `Input.dispatchMouseEvent` (including `mouseWheel`), `Input.dispatchKeyEvent`, or `Input.insertText`, and `TakeoverState` decides whether input is accepted at all. Keys carry the DOM `keyCode` as both CDP virtual key codes, so shortcuts and non-printing keys behave as in a real window; text that cannot be typed key by key uses `Input.insertText`.

The tools share one guard. An acting tool calls `TakeoverState.assertAgent` first and reports the user's reason in an error result; the screenshot tool skips that guard because it reads the page without acting on it.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: session, control state, live view, tools, routes |
| [`src/session.ts`](src/session.ts) | Persistent context, tab-aware CDP sessions, navigation, screenshot, click, fill |
| [`src/tabs.ts`](src/tabs.ts) | Tab ids, active tab, loading state, the eight-tab cap, and the per-navigation deadline |
| [`src/takeover.ts`](src/takeover.ts) | Holder state and the refusal an agent action gets |
| [`src/input.ts`](src/input.ts) | Wire decoding, CDP command mapping, frame encoding |
| [`src/live-view.ts`](src/live-view.ts) | Screencast fan-out and viewer bookkeeping |
| [`src/routes.ts`](src/routes.ts) | Page, status, and live socket registration |
| [`src/page.ts`](src/page.ts) | The served document and its script |
| [`src/tools.ts`](src/tools.ts) | The six model tools |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Browser use](../browser-use/README.md) — the provider slot other browser backends register into.
- [Playwright MCP provider](../../experimental/browser-use-playwright-mcp/README.md) — per-Session browsers through upstream Playwright MCP.
- [Web server](../../host/webserver/README.md) — route admission, upgrades, and the auth policy these routes inherit.
- [Tools](../../core/tools/README.md) — the registry and the schema DSL the tools use.

-----

<a id="model-experience"></a>
## Model Experience

### Page tools

#### What the model sees

Four tool definitions whenever the mounting scope has the tool registry: `headless_browser_open` (`url`), `headless_browser_snapshot` (no arguments), `headless_browser_click` (`selector`), and `headless_browser_type` (`selector`, `text`). Each description is one sentence naming the operation and what the result answers: opening returns the settled URL and document title, a screenshot returns its PNG path and page URL, a click returns the selector and page URL, and typing returns the selector. Results are one JSON text block. The typing result never repeats the text, so a password the model typed into a form is not echoed into the session log.

#### Token effect

A fixed schema cost on every request from an Agent whose scope mounts the package, a few dozen tokens per tool definition. A result is a short JSON object; a screenshot adds only its path, not the image.

#### KV Cache effect

Prefix-stable while the tool definitions and the descriptions are unchanged; results are appended after the reusable prefix.

### Control tools

#### What the model sees

`headless_browser_hand_over` takes a `reason` and returns `{ "url": "<origin>/headless-browser", "holder": "human", "reason": "…" }`; the URL is what the user opens. `headless_browser_hand_back` returns `{ "holder": "agent" }`. While the user holds control, every acting tool answers `{ "error": "the user holds the browser (<reason>); call headless_browser_hand_back when they are done" }` instead of touching the page, and a launcher failure answers `{ "error": "the headless browser could not start: <first line>" }`.

#### Token effect

Two small definitions; a refusal is one short line, and the reason is bounded by what the user typed on the page.

#### KV Cache effect

Append-only: results and refusals enter the history after the reusable prefix and rewrite nothing earlier.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One browser, one mounting scope** — the routes are fixed paths, so a Host mounts the package once; a second mount collides on `/headless-browser`. The browser is one Chromium with one tab model, not one per Session, so parallel agents share its tabs.
- **The browser binary is the deployment's** — `playwright-core` ships no browser, and this package does not download one. Without `PLAYWRIGHT_BROWSERS_PATH` or an install into the account's cache, every tool call fails with the launcher diagnostic.
- **Headless is the supported mode** — `headless: false` needs a logged-in desktop session; a service account cannot open a window.
- **Tabs are ours, not the site's** — the tab model covers tabs the tools or the take-over view open; a popup the site opens for itself is not adopted. The browser keeps at most eight tabs, and every navigation has a 20-second deadline.
- **Streaming is live-only** — frames arrive only while a take-over page is connected, are not recorded, and can drop frames when Chrome is busy. A still page sends no new frames, so a page that connects later shows the last painted frame. A renderer that crashes ends the cast, and the picture returns only after the page is reloaded and the user reconnects.
- **The hand-over URL needs a Web server** — in a composition without one, `headless_browser_hand_over` returns `/headless-browser` alone, which the user cannot open.
- **The generated catalogs follow the mount** — `docs/tool-catalog.md` and `docs/config-catalog.md` list this package's tools and fields only after a composition mounts it and the generators run.
- **The page is not localized** — the served page has fixed Chinese copy, unlike Client plugins whose text is locale-owned; it is not part of any Client bundle.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers.

- The page deliberately loads no Client bundle: the Host serves one static document, so the plugin works in a composition whose Web UI is not otherwise extended.
- Input is accepted only while the user holds control. An idle page therefore never moves the agent's browser, and the agent never moves the page under the user's cursor.
- The screenshot stays available to the agent while the user holds control; it reads the page without competing for input.
- The tests that need a browser resolve `chromium.executablePath()` and skip when the binary is absent, so a checkout without the Playwright download still runs every other spec.

</details>
