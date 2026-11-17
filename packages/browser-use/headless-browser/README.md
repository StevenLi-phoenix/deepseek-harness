---
description: "One persistent headless Chromium with model tools and a Web page where the user watches the live frame and takes the page over for a sign-in, a payment, or anything else that needs a human."
kind: "package-reference"
---

# @deepseek-ai/dsh-headless-browser

English | [中文](README.zh.md)

## Summary

Give the agent a browser it keeps between turns and a person a way into it. One headless Chromium runs with its own profile directory, so a sign-in survives a host restart. The model opens pages, reads their text, takes screenshots, clicks, types, scrolls, and closes tabs; when a step needs a human, it hands over and returns the page where the user takes control, sees what the agent sees, and hands back. While the user holds the page the agent is refused instead of competing with them.

## Table of Contents

- [Use this package](#use-this-package)
  - [Choosing how to look at a page](#choosing-how-to-look-at-a-page)
  - [Acting by accessibility id](#acting-by-accessibility-id)
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
| `stealth` | `true` | Report a macOS Chrome identity on every page, so a site that refuses a browser announcing itself as headless answers normally |
| `viewportWidth` | `1280` | Page viewport width in CSS pixels |
| `viewportHeight` | `800` | Page viewport height in CSS pixels |
| `jpegQuality` | `60` | JPEG quality of live-view frames |
| `snapshotDir` | `$DSH_HOME/cache/headless-browser/snapshots` | Where `headless_browser_snapshot` writes PNG files |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-headless-browser) lists every accepted field.

### Choosing how to look at a page

Each tool answers a different question. Reach for the cheapest one that answers the question in front of you, and prefer `look` when you need both the picture and the meaning.

| Tool | Answers | Cost |
|---|---|---|
| `headless_browser_look` | What does the page look like, and what does it say? One result: the picture and a capped accessibility digest of the same page | One round-trip; one image plus at most 60 nodes and 2000 characters |
| `headless_browser_ax` | Which elements can I act on, and what are their states? The accessibility tree as indented lines, with an id on every interactive node | Text only; the default cap is 300 nodes |
| `headless_browser_read` | What does the prose say? The rendered text of the body or one selector, in character windows | Text only; up to 20000 characters per window |
| `headless_browser_snapshot` | What did the page look like, with no reading? The picture alone, viewport or whole page | One image, no page text |
| `headless_browser_eval` | What does this expression evaluate to? JSON text, with the page's exceptions and console errors quoted verbatim | Text only; the expression is capped at 16 KiB and the result at 8000 characters |

`look` is the default for a page the agent has not seen: it returns the picture the model can look at and the accessibility digest in the same result, so it does not pay for a screenshot and then a read. `read` is for long prose that does not need the picture. `ax` is for forms, menus, and lists where the question is what to click, and it is the only read that hands back ids the acting tools accept. `snapshot` is the pixel fallback when text cannot describe the page, and the tool whose coordinates a later click can be derived from. `eval` is the last resort for a computed value, not a way to read a page.

#### The picture the model sees

`headless_browser_snapshot` and `headless_browser_look` return the PNG as an image content block the model can look at, together with its path, page URL, width, height, the `fullPage` flag they honoured, and a `scale`. The picture is bounded: a page longer than 1568 pixels on an edge, or larger than 1.2 million pixels, is captured clipped and scaled down, and the result says `downscaled: true` with a note naming the size it was reduced to, so a tall page arrives as a legible overview instead of an enormous image. The bytes also exist as a file under `snapshotDir`, which is what the take-over view and the owner read. When the composition mounts no attachment store, the result keeps the path and says so in a note instead of failing.

#### Reading a page's text

A screenshot captures the viewport, so a list longer than the viewport reaches the model with its lower rows missing and no way to scroll them into a picture. `headless_browser_read` answers with the page's rendered text instead of pixels: the document body, or the first element that matches a CSS `selector`, cut into character windows. `offset` and `limit` page through it — 8000 characters by default, 20000 at most — and the result carries a `header` naming the tab, the page URL, the page, and the character range, plus `total` and the `nextOffset` of the text that remains. A URL too long for one line is shortened in the header, and a window is counted in characters, so it never ends inside a surrogate pair such as an emoji: every window is text the model can read on its own.

### Acting by accessibility id

`headless_browser_ax` and the digest `headless_browser_look` returns print an id such as `e12` beside every node an agent can act on: a button, link, textbox, searchbox, combobox, checkbox, radio, menuitem (including its checkbox and radio variants), tab, slider, switch, or spinbutton, a file input included because it reports the button role. The id names the element, not a selector: the host keeps a per-page map from id to the DOM node behind it, so consecutive reads on the same page print the same id for the same element, and a capture in between changes nothing. The model reads a page once and then passes `axId` to `headless_browser_click`, `headless_browser_type`, or `headless_browser_scroll`, which resolves exactly that element and refuses below Playwright's actionability threshold rather than clicking something else.

Ids die on navigation, because the document and every node in it are gone; they also belong to one tab, since the allocator numbers ids for the whole browser. An id from another tab or from the previous document answers `{ "error": "axId e12 no longer names an element on this page (…); ids die on navigation, so read the page again with headless_browser_ax" }`, and an id no read ever printed answers `{ "error": "no element has axId e77; read the page with headless_browser_ax and use an id it printed" }`.

Resolving an id writes `data-dsh-axid="e12"` onto the element so one locator call finds exactly that node, including inside a shadow root; the attribute is a marker for that lookup, not page content.

### Understanding accessibility output

A line is `id role "name" value="…" [states]`, indented two spaces per level:

```
RootWebArea "Checkout"
  heading "Delivery"
  e3 textbox "Street" [required]
  e4 combobox "Country" value="United States" [expanded=false]
  e5 checkbox "Gift wrap" [checked]
  e6 button "Pay" [disabled]
  … 42 more nodes
```

Only the states that are on are printed — `checked`, `checked=mixed`, `disabled`, `required` — except `expanded`, which prints `expanded=true` or `expanded=false` because a combobox's closed state is itself the information. Hidden nodes are dropped and their children take their place, a node whose text only repeats its parent's name is dropped, and the walk stops at `maxNodes` (300 by default, 1000 at most) with one `… N more nodes` line that says what the cap hid. `selector` scopes the read to one element's subtree, which is how a model reads one form instead of the whole page.

### Evaluating an expression

`headless_browser_eval` runs one JavaScript expression in the page and answers `result` as JSON text: the value when JSON can carry it, and Chrome's own form for a value JSON cannot carry (`undefined`, `Infinity`, `5n`). A returned promise is awaited only when `awaitPromise` is true. Everything the page says while the expression runs is quoted, never paraphrased: each thrown exception keeps the page's own description and stack, and each console error keeps the page's own text. The expression is capped at 16384 characters, the result at 8000 characters with a marker naming what was cut, and a refusal answers with an error naming the cap instead of reaching the page.

This is the one tool that runs code the model wrote inside a signed-in profile. Its result is page data: a string an `eval` returns, a console line, or a thrown exception is what the page says about itself and never an instruction to follow. A page that knows the tool runs can observe or interfere with anything it evaluates, so use it for a value the agent already decided to ask for — not to have the page decide what to do next, and never by pasting page text into an expression as if it were code or commands.

### The browser binary

`playwright-core` does not download browsers, so the deployment supplies one Chromium build for the account that runs the Host. Install it once into the account's Playwright cache, or point `PLAYWRIGHT_BROWSERS_PATH` at a shared cache:

```sh
pnpm exec playwright-core install chromium
PLAYWRIGHT_BROWSERS_PATH=/srv/dsh/ms-playwright pnpm exec playwright-core install chromium
```

An unset variable uses the platform cache (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux). A missing binary fails the first tool call with the launcher diagnostic, not at load.

### Reading sites that refuse a headless browser

The `stealth` option, on by default, makes the browser describe the Chromium it actually is: a macOS arm64 Chrome of the version this package pins. Playwright's launch otherwise announces `HeadlessChrome` in `navigator.userAgentData.brands` and `navigator.userAgent`, leaves `navigator.webdriver` true, and sends client hints that disagree with the user-agent string. A site whose bot check keys on any of those refuses the page before its content matters, and the same Chromium on the same machine gets that page once the surface is aligned.

It changes three things together. The launch uses the full Chromium build rather than the headless shell, with `--disable-blink-features=AutomationControlled` and `--lang=en-US`. A document-start script in every page and frame replaces `navigator.userAgentData` (including `getHighEntropyValues`), `navigator.webdriver`, `navigator.plugins`, `navigator.languages`, `window.chrome`, and the WebGL vendor and renderer strings. A CDP `Emulation.setUserAgentOverride` per page keeps `Sec-CH-UA`, the full version list, architecture, bitness, and platform version in step with the same identity. A new tab, a page the site opens, and a page restored from the profile all get both halves.

It invents no font list, spoofs no certificate, and answers no challenge, and it leaves the page's content alone. A site that still refuses the page is the owner's to take over: the take-over page keeps working, and the challenge itself is where the owner takes it. Use this for reading pages the owner has a right to read. Set `stealth: false` to keep the browser's own surface.

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

The tools share one guard. An acting tool calls `TakeoverState.assertAgent` first and reports the user's reason in an error result; the screenshot tool skips that guard because it reads the page without acting on it, while a text read keeps it because reading is the first half of the same browse-and-act loop as a click. `headless_browser_scroll` sends CDP wheel input and reads `Page.getLayoutMetrics`, so it moves the page without evaluating its script.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: session, control state, live view, tools, routes |
| [`src/session.ts`](src/session.ts) | Persistent context, tab-aware CDP sessions, navigation, bounded capture, read, evaluate, accessibility read, click, fill, scroll, tab close |
| [`src/read.ts`](src/read.ts) | Page text, cut into character windows with a header naming the page and range |
| [`src/inspect.ts`](src/inspect.ts) | The reading rules: eval result text and diagnostics, accessibility text, caps, and PNG size |
| [`src/ax-ids.ts`](src/ax-ids.ts) | Stable per-page ids, the action attribute, and the refusals a dead id gets |
| [`src/tabs.ts`](src/tabs.ts) | Tab ids, active tab, loading state, closing, the eight-tab cap, and the per-navigation deadline |
| [`src/stealth.ts`](src/stealth.ts) | The identity: launch settings, the document-start script, and the per-page client-hint override |
| [`src/takeover.ts`](src/takeover.ts) | Holder state and the refusal an agent action gets |
| [`src/input.ts`](src/input.ts) | Wire decoding, CDP command mapping, frame encoding |
| [`src/live-view.ts`](src/live-view.ts) | Screencast fan-out and viewer bookkeeping |
| [`src/routes.ts`](src/routes.ts) | Page, status, and live socket registration |
| [`src/page.ts`](src/page.ts) | The served document and its script |
| [`src/tools.ts`](src/tools.ts) | The twelve model tools |

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

Nine page tools whenever the mounting scope has the tool registry: `headless_browser_open` (`url`, `newTab`), `headless_browser_snapshot` (`tab`, `fullPage`), `headless_browser_read` (`tab`, `selector`, `offset`, `limit`), `headless_browser_look` (`tab`, `fullPage`, `text`), `headless_browser_ax` (`tab`, `selector`, `maxNodes`), `headless_browser_eval` (`tab`, `expression`, `awaitPromise`), `headless_browser_click` (`selector` or `axId`, `tab`), `headless_browser_type` (`selector` or `axId`, `text`, `tab`), and `headless_browser_scroll` (`tab`, `axId` or `x`, `y`, `deltaY`, `to`). Each description is one sentence naming the operation and what the result answers: opening returns the settled URL and document title, a screenshot returns the picture with its path and size, a read returns one text window with the header naming its page and range, a look returns the picture plus the digest in one result, an accessibility read returns the indented tree, an eval returns JSON text with its diagnostics, a click returns the selector or id and page URL, typing returns the selector or id without repeating the text, and scrolling returns `x`, `y`, `scrollX`, `scrollY`, `pageHeight`, `viewportHeight`, `atTop`, and `atBottom`, so the model knows whether it reached the end. Results are one text block; a picture's block carries the metadata first and the image after it.

#### Token effect

A fixed schema cost on every request from an Agent whose scope mounts the package, a few dozen tokens per tool definition. A read is bounded by `limit`, so its text stays under 20000 characters; an accessibility text prints at most 300 nodes by default, and a digest at most 60 nodes and 2000 characters; an eval result is capped at 8000 characters. A screenshot or look spends one image, bounded to 1568 pixels on its long edge and 1.2 million pixels, which is the point: a model that looks once should not pay for a screenshot and a separate read.

#### KV Cache effect

Prefix-stable while the tool definitions and the descriptions are unchanged; results are appended after the reusable prefix.

### Tab tools

#### What the model sees

`headless_browser_close` takes an optional `tab` and returns `{ "closed": "t2", "replaced": false, "tabs": [...] }`: every remaining tab's id, title, URL, loading flag, and active flag. Closing the last tab reports `"replaced": true`, because a blank tab takes its place and the browser, its context, and its profile stay open. The eight-tab cap remains; opening a ninth answers `{ "error": "opening <url> failed: the browser allows at most 8 tabs; close one with headless_browser_close before opening another" }`. Closing is an acting tool, so it is refused while the user holds the browser.

#### Token effect

One small definition; a result repeats the remaining tab list, at most eight short entries.

#### KV Cache effect

Append-only: results enter the history after the reusable prefix.

### Control tools

#### What the model sees

`headless_browser_hand_over` takes a `reason` and returns `{ "url": "<origin>/headless-browser", "holder": "human", "reason": "…" }`; the URL is what the user opens. `headless_browser_hand_back` returns `{ "holder": "agent" }`. While the user holds control, every acting tool — `headless_browser_read`, `_look`, `_ax`, and `_eval` included — answers `{ "error": "the user holds the browser (<reason>); call headless_browser_hand_back when they are done" }` instead of touching the page, a selector that matches nothing answers `{ "error": "no element matches <selector>; check the selector or read the whole page" }`, an unknown or stale `axId` names the id and the read that fixes it, a tab that is not open answers `{ "error": "no tab named <id>; use the active tab or open a new one" }`, and a launcher failure answers `{ "error": "the headless browser could not start: <first line>" }`. A screenshot keeps answering throughout, because it never competes for input; `headless_browser_look` does not, because it also reads the page the user is working in.

#### Token effect

Two small definitions; a refusal is one short line, and the reason is bounded by what the user typed on the page.

#### KV Cache effect

Append-only: results and refusals enter the history after the reusable prefix and rewrite nothing earlier.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One browser, one mounting scope** — the routes are fixed paths, so a Host mounts the package once; a second mount collides on `/headless-browser`. The browser is one Chromium with one tab model, not one per Session, so parallel agents share its tabs.
- **The browser binary is the deployment's** — `playwright-core` ships no browser, and this package does not download one. Without `PLAYWRIGHT_BROWSERS_PATH` or an install into the account's cache, every tool call fails with the launcher diagnostic.
- **Headless is the supported mode** — `headless: false` needs a logged-in desktop session; a service account cannot open a window.
- **A refusal stays a refusal** — the identity fixes what the browser says about itself, not what the site decides: a site that scores the address, the profile, or the request can still refuse the page, and this package answers no challenge.
- **A read is the rendered text** — `headless_browser_read` returns what the page renders: collapsed or hidden content is absent, a selector that matches several elements reads only the first, and text inside a frame or a shadow root is not part of the document body. An assignment list's rows below the fold are in the text even though no screenshot of the viewport contains them.
- **An id lives as long as its document** — `headless_browser_ax`'s ids resolve on the page that printed them. A navigation, a closed tab, or a tab you never read answers with the id and asks for a fresh read; resolving an id writes a `data-dsh-axid` attribute onto its element, because a selector that names exactly one node is what a locator needs.
- **The accessibility tree is the main frame's** — a `selector` for `headless_browser_ax` is resolved in the main document, so a node inside an iframe is reachable only by reading the frame's page directly. Nodes with no role and no text are dropped, and the cap reports what it hid instead of truncating silently.
- **Evaluating runs the model's code in the page** — `headless_browser_eval` has the page's own credentials and can change the page, and everything it returns is page data rather than an instruction. Its expression cap and result cap bound the size of that exchange, not what the code may do.
- **A capture is scaled, not pixel-exact above the bound** — a full-page capture of a very long page is scaled down to stay under 1568 pixels on its long edge and 1.2 million pixels, and the result says so with `downscaled`, `scale`, and the size it was reduced to.
- **Tabs are ours, not the site's** — the tab model covers tabs the tools or the take-over view open; a popup the site opens for itself is not adopted. The browser keeps at most eight tabs; `headless_browser_close` frees one, and the cap error names that tool. Every navigation has a 20-second deadline.
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
- The screenshot stays available to the agent while the user holds control; it reads the page without competing for input. `look` does not: it reads the page the user is working in, so it sits behind the same gate as the other page tools.
- `ax` ids are allocated as nodes are printed, so a capped read hands out ids only for what the model saw; a later read continues the sequence and never reuses an id for a different node.
- The tests that need a browser resolve `chromium.executablePath()` and skip when the binary is absent, so a checkout without the Playwright download still runs every other spec.

</details>
