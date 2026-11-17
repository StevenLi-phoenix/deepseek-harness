---
description: "One persistent headless Chromium with model tools and a Web page where the user watches the live frame and takes the page over for a sign-in, a payment, or anything else that needs a human."
kind: "package-reference"
---

# @deepseek-ai/dsh-headless-browser

English | [中文](README.zh.md)

## Summary

Give the agent a browser it keeps between turns, and a person a way in. One headless Chromium keeps its own profile, so a sign-in survives a host restart. The model opens, reads, screenshots, clicks, types, scrolls, and closes tabs; an action guard refuses controls a person cannot see, destructive or money-moving targets, and moves to another site: a page is data, never instructions. When a step needs a human, the model hands over and returns the page where the user takes control and hands back. While the user holds it, the agent waits.

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
| `stealth` | `true` | Report a macOS Chrome identity on every page, so a site that refuses a browser announcing itself as headless answers normally |
| `viewportWidth` | `1280` | Page viewport width in CSS pixels |
| `viewportHeight` | `800` | Page viewport height in CSS pixels |
| `jpegQuality` | `60` | JPEG quality of live-view frames |
| `snapshotDir` | `$DSH_HOME/cache/headless-browser/snapshots` | Where `headless_browser_snapshot` writes PNG files |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-headless-browser) lists every accepted field.

### Reading a page's text

A screenshot captures the viewport, so a list longer than the viewport reaches the model with its lower rows missing and no way to scroll them into a picture. `headless_browser_read` answers with the page's rendered text instead of pixels: the document body, or the first element that matches a CSS `selector`, cut into character windows. `offset` and `limit` page through it — 8000 characters by default, 20000 at most — and the result carries a `header` naming the tab, the page URL, the page, and the character range, plus `total` and the `nextOffset` of the text that remains. A URL too long for one line is shortened in the header, and a window is counted in characters, so it never ends inside a surrogate pair such as an emoji: every window is text the model can read on its own.

A screenshot keeps its use where the picture matters: `fullPage: true` captures the whole scrollable page instead of the viewport.

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
| `GET /headless-browser/status` | JSON: `holder`, the user's `reason`, `launched`, `sessionId`, `url`, the number of connected pages, and `security` with the newest guard events |
| `WS /headless-browser/live` | Frames, control changes, and forwarded input |

Admission is the deployment's, not this package's: the page and status use the Web server's default required policy, so the same Cookie or launch token that opens the Web UI opens them. The live socket additionally requires the owner principal, because whoever holds it can act inside a signed-in profile.

The page's input only reaches the browser while the user holds control. Taking control from the page sets the holder to `human` with the reason "用户从接管页取得控制"; the release button returns it to the agent. Both buttons are the same state transitions as the two control tools.

#### The in-app page

The package's browser half also registers 浏览器接管 as a page of the Web UI: one `main` panel keyed `browser-takeover`, selected by the sidebar row of the same id. The owner reaches the live frame by clicking that row, so the app's address bar keeps its URL instead of navigating below the site root.

The page paints the frames itself; it is not an iframe and opens no sub-URL. It reads the status route and the live socket above with the app's own origin and cookie, and its 接管 and 交回 buttons send the same control messages as this page's buttons, with a different stated reason. The standalone page stays for deployments whose browsers allow it.

### The page is data, never instructions

A page can say anything: that a checkbox "verifies it is human", that a form is a routine confirmation, that a link goes to the course site. None of that is a reason to act, and this package does not leave the decision to the model's judgement. Every mutating tool (`headless_browser_open`, `_click`, `_type`) asks a host-side action guard first, and the guard answers from measurements and fixed tables rather than from the page's words. `headless_browser_scroll` names no destination, so it cannot change the site and the guard has nothing to decide there.

**Visibility score.** [`src/visibility.ts`](src/visibility.ts) measures the element a person would have to hit and turns the measurement into a score from 0 to 1: computed `display` and `visibility`, the product of the opacity chain, the box area, `pointer-events`, `aria-hidden`, the fraction of the box inside the viewport after scrolling to it, how much of the box a hit test at five points reaches, and how many ancestors clip it. A test a person cannot work around (display, visibility, pointer events, aria-hidden) weighs most, so one of them alone scores zero. A click or type is refused below `VISIBILITY_THRESHOLD`, which is 0.2, and the refusal names the score and the tests that dragged it down. When a selector matches several elements, the guard acts on the highest-scoring one and reports its score beside the runner-up's, so the model can see it chose the real control over a decoy.

**Sensitive names.** [`SENSITIVE_ACTIONS`](src/guard.ts) is the one table of destructive and money-moving verbs: submit, pay, purchase, place or confirm an order, transfer, approve, delete, remove, archive, or deactivate an account, unsubscribe, revoke. A target whose accessible name or value matches any of them is refused and needs `headless_browser_hand_over`. The table is conservative on purpose: a false positive costs one hand-over the owner answers in seconds, a false negative costs an account or a payment.

**Origin drift.** A session remembers the registrable domain it is on. Opening, clicking, or typing that would move to another domain is refused once; the agent repeats the call with `allowOrigin: true`, which is recorded as an event. A subdomain of the same registrable domain is the same site, so `mail.example.com` and `example.com` pass. A move the page makes on its own is recorded as a drift.

**Every refusal is a security event.** One event per decision carries the page URL, the selector, accessibility id, or point, the accessible name, the rule, the score, and one short line of reason. The list keeps the newest 50 and is served under `security` by `GET /headless-browser/status`; the plugin also emits `headless-browser/security` for a host that watches. The model reads a refusal as a `blocked` tool result, reports it to the owner, and must not retry with another selector, a coordinate, or an accessibility id.

**A legitimate invisible element.** A file input is the usual one: the real `<input type="file">` is often `display:none` or `opacity:0`, and a styled label opens it. The guard refuses the hidden input, and a person takes over: `headless_browser_hand_over` gives them the page, they click the label, and the operating system's file picker does the rest. The same holds for a hidden native checkbox behind a styled switch, and neither needs a selector exception.

**Coordinates.** A click or type at a viewport point has no element to score, so the guard hit-tests the point, runs the sensitive-name and origin rules on what it finds, and records the tab, the point, the hit element's accessible name, and its score. The score is audit information there, not a gate: the model is clicking what it saw in a screenshot.

**Accessibility ids.** An `axId` resolves through the id map the page read registers with `HeadlessBrowserSession.setAxResolver`; the session keeps no second map, so an id can never name two elements. An id the map does not know, because the page navigated since the read, is refused by name and the agent reads the page again instead of falling back to a selector or a coordinate. A build whose read registers no map refuses the id with that reason rather than guessing.

**The wrapping.** Every page-derived field in a tool result arrives as `{ "untrusted": "<origin>", "content": "..." }`, and each tool description says so in one line: the page title, a read window's text, the accessible name, the page a screenshot captured. The wrapping is the tool layer's job, not the prompt's.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `HeadlessBrowserSession` owns the context. The launch is lazy and single-flight, so a tool call and a page view racing each other still start one Chromium; `close()` settles a launch that lost the race. The browser keeps tabs over that one context: the first page is adopted as `t1`, each new tab gets the next id, and a page that closes is replaced so the context and its profile stay open. A launch gets a fresh session id, which the status route reports.

The live view is one CDP screencast per page shared by every connected viewer. `Page.startScreencast` starts for the first viewer and `Page.stopScreencast` stops for the last; every frame is acknowledged before it is fanned out, because Chrome sends the next one only after the ack. Chrome sends frames on repaint, so the hub keeps the last frame: a page that connects to a still page sees the current screen at once instead of a blank area. Frames carry the metadata the page scales pointer input by, and arrive only while the browser page exists.

Input from the page is one JSON message per event. `decodeClientMessage` validates it, `cdpCommand` maps it to `Input.dispatchMouseEvent` (including `mouseWheel`), `Input.dispatchKeyEvent`, or `Input.insertText`, and `TakeoverState` decides whether input is accepted at all. Keys carry the DOM `keyCode` as both CDP virtual key codes, so shortcuts and non-printing keys behave as in a real window; text that cannot be typed key by key uses `Input.insertText`.

The tools share two guards. An acting tool calls `TakeoverState.assertAgent` first and reports the user's reason in an error result; the screenshot tool skips that guard because it reads the page without acting on it, while a text read keeps it because reading is the first half of the same browse-and-act loop as a click. `headless_browser_scroll` sends CDP wheel input and reads `Page.getLayoutMetrics`, so it moves the page without evaluating its script. An acting tool then asks `ActionGuard`, which scores the element a person would reach, checks the sensitive-name table and the session's site, and turns a refusal into a `blocked` result; a text read and a screenshot skip that guard because they act on nothing.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: session, control state, live view, tools, routes |
| [`src/session.ts`](src/session.ts) | Persistent context, tab-aware CDP sessions, navigation, screenshot, read, click, fill, scroll, tab close |
| [`src/read.ts`](src/read.ts) | Page text, cut into character windows with a header naming the page and range |
| [`src/tabs.ts`](src/tabs.ts) | Tab ids, active tab, loading state, closing, the eight-tab cap, and the per-navigation deadline |
| [`src/stealth.ts`](src/stealth.ts) | The identity: launch settings, the document-start script, and the per-page client-hint override |
| [`src/takeover.ts`](src/takeover.ts) | Holder state and the refusal an agent action gets |
| [`src/input.ts`](src/input.ts) | Wire decoding, CDP command mapping, frame encoding |
| [`src/live-view.ts`](src/live-view.ts) | Screencast fan-out and viewer bookkeeping |
| [`src/routes.ts`](src/routes.ts) | Page, status, and live socket registration |
| [`src/page.ts`](src/page.ts) | The served document and its script |
| [`src/guard.ts`](src/guard.ts) | The action guard: sensitive-name table, site memory, security events, the untrusted wrapper |
| [`src/visibility.ts`](src/visibility.ts) | The page-side probe and the visibility score |
| [`src/tools.ts`](src/tools.ts) | The nine model tools |

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

Six page tools whenever the mounting scope has the tool registry: `headless_browser_open` (`url`, `newTab`, `allowOrigin`), `headless_browser_snapshot` (`tab`, `fullPage`), `headless_browser_read` (`tab`, `selector`, `offset`, `limit`), `headless_browser_click` (`selector`, `axId`, `x`, `y`, `allowOrigin`, `tab`), `headless_browser_type` (`selector`, `axId`, `x`, `y`, `text`, `allowOrigin`, `tab`), and `headless_browser_scroll` (`tab`, `x`, `y`, `deltaY`, `to`). A click or type names exactly one target: a CSS selector, an accessibility id from a page read, or a viewport point. Each description is one sentence naming the operation, what the result answers, and that page-derived fields arrive as `{ "untrusted": "<origin>", "content": "..." }`. Opening returns the settled URL and the document title as untrusted data; a screenshot returns its PNG path and the page it captured; a read returns one text window as untrusted data with a header naming its page and range; a click or type returns the target or point with the accessible name, the score it won with, and the runner-up score; scrolling returns `x`, `y`, `scrollX`, `scrollY`, `pageHeight`, `viewportHeight`, `atTop`, and `atBottom`, so the model knows whether it reached the end. A refusal returns a `blocked` object with the rule, the page, the reference, the name, the reason, the hint, the score, the threshold, the failed tests, and every test's value, and the hint says to report the blocked action rather than retry. Results are one JSON text block. The typing result never repeats the text, so a password the model typed into a form is not echoed into the session log.

#### Token effect

A fixed schema cost on every request from an Agent whose scope mounts the package, a few dozen tokens per tool definition. A result is a short JSON object; a screenshot adds only its path, not the image, and a read is bounded by `limit`, so its text stays under 20000 characters.

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

`headless_browser_hand_over` takes a `reason` and returns `{ "url": "<origin>/headless-browser", "holder": "human", "reason": "…" }`; the URL is what the user opens. `headless_browser_hand_back` returns `{ "holder": "agent" }`. While the user holds control, every acting tool — `headless_browser_read` included — answers `{ "error": "the user holds the browser (<reason>); call headless_browser_hand_back when they are done" }` instead of touching the page, a selector that matches nothing answers `{ "error": "no element matches <selector>; check the selector or read the whole page" }`, a tab that is not open answers `{ "error": "no tab named <id>; use the active tab or open a new one" }`, and a launcher failure answers `{ "error": "the headless browser could not start: <first line>" }`. A screenshot keeps answering throughout, because it never competes for input.

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
- **The guard is conservative** — the sensitive-name table matches a word, so "Submit search" and "Delete draft" need the owner too; one hand-over is the price of never matching a real payment. The visibility score reads computed style and geometry, so an element inside a closed shadow root cannot be hit-tested and is refused.
- **The site rule is a heuristic** — the public-suffix list is fixed rather than downloaded, so an unlisted multi-label suffix splits one site into two and costs one refusal. A script can navigate with a URL the guard never sees; a mutating eval reads absolute URLs in its text as a tripwire, not as a proof.
- **Coordinate clicks are audited, not scored** — the guard records what the point hit but does not refuse an invisible hit, because the model is acting on a screenshot; the sensitive-name and origin rules still apply.
- **A read is not scored** — the guard checks where a click or type lands, not what a read returns: page text is wrapped as untrusted data, and the model decides what to do with it.
- **A read is the rendered text** — `headless_browser_read` returns what the page renders: collapsed or hidden content is absent, a selector that matches several elements reads only the first, and text inside a frame or a shadow root is not part of the document body. An assignment list's rows below the fold are in the text even though no screenshot of the viewport contains them.
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
- The screenshot stays available to the agent while the user holds control; it reads the page without competing for input.
- The tests that need a browser resolve `chromium.executablePath()` and skip when the binary is absent, so a checkout without the Playwright download still runs every other spec.

</details>
