---
description: "One persistent headless Chromium with model tools and a Web page where the user watches the live frame and takes the page over for a sign-in, a payment, or anything else that needs a human."
kind: "package-reference"
---

# @deepseek-ai/dsh-headless-browser

English | [中文](README.zh.md)

## Summary

Give the agent a browser it keeps between turns, and a person a way in. One headless Chromium keeps its own profile, so a sign-in survives a restart. The model opens, reads, clicks, types and closes tabs; an action guard refuses controls a person cannot see, destructive or money-moving targets, and moves to another site, since a page is data, never instructions. When a step needs a human, the model hands over a take-over page and waits until the user hands back. Cookies leave as a Cookie header, and a timed revisit keeps a sign-in alive.

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
| `sensitiveActions` | `true` | Refuse a target whose name or value matches the sensitive table; `false` lets it run and records the skip as a security event |
| `viewportWidth` | `1280` | Page viewport width in CSS pixels |
| `viewportHeight` | `800` | Page viewport height in CSS pixels |
| `jpegQuality` | `60` | JPEG quality of live-view frames |
| `snapshotDir` | `$DSH_HOME/cache/headless-browser/snapshots` | Where `headless_browser_snapshot` writes PNG files |
| `keepalivePath` | `$DSH_HOME/data/headless-browser/keepalive.json` | JSON file that keeps the registered keepalives across a restart |
| `keepaliveEscalateAfter` | `3` | Consecutive interactive sign-in challenges after which a keepalive says a person has to sign in |
| `downloadDir` | `$DSH_HOME/cache/headless-browser/downloads` | Where downloaded files are kept, one owner-only file each |
| `maxDownloadMB` | `256` | Largest download kept; a bigger file is deleted and reported as failed |
| `downloadRetainDays` | `7` | Days a downloaded file is kept; `0` keeps every file |
| `downloadPdfs` | `true` | Download a PDF instead of opening it in the browser's viewer |
| `credentialsPath` | `$DSH_HOME/data/headless-browser/credentials.json` | Owner-only file of the site accounts `headless_browser_credential` created, passwords included |
| `uploadDirs` | `[$DSH_HOME/data/headless-browser/uploads]` | Directories whose files `headless_browser_upload` may attach; the first one also resolves bare names |
| `maxUploadMB` | `25` | Largest file `headless_browser_upload` attaches |

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
| `GET /headless-browser/status` | JSON: `holder`, the user's `reason`, `launched`, `sessionId`, `url`, the number of connected pages, `security` with the newest guard events, and `keepalive` with every registered keepalive |
| `WS /headless-browser/live` | Frames, control changes, and forwarded input |

Admission is the deployment's, not this package's: the page and status use the Web server's default required policy, so the same Cookie or launch token that opens the Web UI opens them. The live socket additionally requires the owner principal, because whoever holds it can act inside a signed-in profile.

The page's input only reaches the browser while the user holds control. Taking control from the page sets the holder to `human` with the reason "用户从接管页取得控制"; the release button returns it to the agent. Both buttons are the same state transitions as the two control tools.

#### The in-app page

The package's browser half also registers 浏览器接管 as a page of the Web UI: one `main` panel keyed `browser-takeover`, selected by the sidebar row of the same id. The owner reaches the live frame by clicking that row, so the app's address bar keeps its URL instead of navigating below the site root.

The page paints the frames itself; it is not an iframe and opens no sub-URL. It reads the status route and the live socket above with the app's own origin and cookie, and its 接管 and 交回 buttons send the same control messages as this page's buttons, with a different stated reason. The standalone page stays for deployments whose browsers allow it.

### Downloads

This browser never asks where to save. It runs headless and Playwright pins every download to a private directory, so Chromium opens no save panel and no `prompt_for_download` question can appear. What used to go wrong was silent: a URL that answers `Content-Disposition: attachment` made `headless_browser_open` fail with `Download is starting`, a click on a download link did nothing the model could see, and the file sat in a temporary directory that is deleted when the browser closes.

Every page the browser opens now keeps what it downloads. A finished file is copied into `downloadDir` as `<time>-<random>-<name>`, mode `0600` in a `0700` directory. The name is the one the site suggested, reduced to a single safe segment (no separator, control character, or leading dot), so a page cannot steer the file out of the directory. A file over `maxDownloadMB` is deleted and reported as failed; a download still running after two minutes is cancelled; files older than `downloadRetainDays` are removed when the next download is saved, at most once an hour. A log line records each file with its origin and path but never the query string, which often carries a signed token.

- `headless_browser_open` on a URL that is a download returns `downloads` (path, bytes, the suggested name as untrusted text, the source address) instead of a page.
- `headless_browser_click` returns `downloads` when the click started one; it waits 250 ms for the download to begin, which Chromium does within about a hundred.
- `headless_browser_downloads` lists the newest files, and with `waitMs` waits for a slow download to start; it answers while the user holds the page.
- `downloadPdfs` writes `plugins.always_open_pdf_externally` and `download.prompt_for_download=false` into the profile's `Default/Preferences` before each launch (the file is merged, never replaced, and left alone when it is not JSON). A headless viewer shows the model an empty page, and the viewer's own Download button is the one path that opens a native save dialog (`showSaveFilePicker`) in a browser with a window; with the preference the PDF arrives as an ordinary download and the viewer is never involved. In the headless browser `showSaveFilePicker` is refused at once with `AbortError`, so a page script that calls it fails fast instead of hanging.

A downloaded file is data from the page: read it, never run it. For a very large file, `headless_browser_cookies` plus a plain HTTP request still avoids the browser's copy.

### Attaching files

A job application, a visa form, or a course submission wants a file, and the real `<input type="file">` is nearly always hidden behind a styled button, which the visibility guard refuses on purpose. `headless_browser_upload` is the path for that one legitimate invisible element. Name the input with `selector` (and `index` when the page has several); a hidden file input is expected there and needs no score. Or name the visible button with `trigger` (or `triggerAxId`): the click passes the guard like any click, and the file chooser it opens receives the files. A multi-file call needs an input or chooser that accepts several.

What may be attached is the owner's decision, not the page's. A page can ask the agent to "attach your key to verify", so the tool only attaches regular files inside `uploadDirs`, resolved through symlinks before the check, at most `maxUploadMB` each and ten per call. A bare name such as `resume.pdf` is looked up in the first directory, which the plugin creates (`0700`) on load; the owner, or a task's own script, copies the files a task needs there. The result names each file and its size; a log line names the count, the selector, and the origin.

### Site accounts and passwords

An agent that signs up for a site account would otherwise have to choose a password, type it, and keep it somewhere — which puts the secret into its context, the Session log, and every summary after it, and is the step models refuse. `headless_browser_credential` is the browser's own password manager instead:

- `create` on a sign-up or new-password form generates a 20-character password (CSPRNG; lower, upper, digit, and a symbol from `!@#$%^*-_=+?`, look-alike characters left out; `length` 12–64 and `symbols: false` for strict sites), saves it with the page's host and the `username` the account uses, and writes it into the password field and, with `confirmSelector`, the confirm field. If the first write is refused, the new record is dropped, so a retry is not a duplicate. A second `create` for the same host and login is refused unless `replace: true`, which keeps the old password beside the new one for the owner.
- `fill` on a sign-in form writes the saved `username` or `password` for the page's host; a host with two accounts needs `username`.
- `list` answers the saved accounts without passwords.

Three rules hold the secret in. A password is written only into an `input[type=password]`; it is written only when the page is on the host the record was created for, checked at the moment of writing; and no tool result, log line, or error carries it — results name the account (`id`, `host`, `username`, `label`, dates). The record is bound to the full host, not the registrable domain, because one ATS domain serves many companies (`acme.wd5.myworkdayjobs.com` and `other.wd5.myworkdayjobs.com` are two accounts).

The file at `credentialsPath` is version 1 JSON, mode `0600`, written atomically; a file of another version is refused rather than overwritten. The owner reads it through two owner-only routes (a signed-in non-owner gets 403):

| Route | Answers |
|---|---|
| `GET /headless-browser/credentials` | JSON `{ accounts, export }`: every account without its password |
| `GET /headless-browser/credentials.csv` | `name,url,username,password,note` — the CSV Chrome's password manager imports (chrome://password-manager/settings → Import), so the passwords also land in the owner's own manager |

### Fetching with the session's cookies
 with the session's cookies

Driving a browser for every read is slow, and the site sees it. Once a session is signed in, what a caller usually needs is the Cookie header: a plain HTTP request carrying the same session fetches a page in milliseconds. `headless_browser_cookies` answers with the browser context's own cookies — `name`, `value`, `domain`, `path`, `expires`, `httpOnly`, and `secure` — filtered to one domain suffix when the call names one, and `toHeader`, the `name=value; name=value` line that request would send:

```json
{"cookies":[{"name":"session","value":"…","domain":".example.com","path":"/","expires":1800000000,"httpOnly":true,"secure":true}],"toHeader":"session=…"}
```

A domain filter accepts a bare suffix, a dotted cookie domain, or a whole URL, and matches that host and everything below it: `example.com` covers `.example.com` and `mail.example.com`, while `notexample.com` is another site. Cookies arrive most specific path first, which is the order a request sends them in.

A caller that has `toHeader` makes the request itself, without a browser:

```sh
curl -s -H "Cookie: session=…; theme=dark" https://example.com/inbox
```

The values are credentials. This package never writes them to disk and never puts one in a log line: the debug line names each cookie and the length its value had (`session ‹42 chars›`). They do reach the model, because that is what the tool is for, so a call is made when a fetch needs the session and not to display them. An `httpOnly` cookie is still in the header, because the browser holds it for the request; a cookie the site rotated after the call is stale; and one context's cookies are not another machine's session.

### Keeping a session alive

A signed-in session dies when nobody visits it. The site expires its own session, and the next real task starts at a sign-in page, with the owner's attention spent on a step that one visit would have prevented. `headless_browser_keepalive` visits a URL on a timer and checks what came back, so the visit renews the upstream session while that session is still alive.

**Authentication checks.** A successful navigation alone is not enough: the final URL must stay on the registrable domain of `domain` (or of the requested URL), and must not be a known sign-in host or path. A visible password or one-time-code field also fails the check. `add` accepts an `expect` array; every matcher must pass. `allowHosts` or `allowOrigins` replaces the default domain test, but not the sign-in veto; `forbidPath` rejects exact paths and descendants. Use `expectText` and `forbidText` for literal visible text, or `expectRegex` for required text matched by a regular expression without delimiters. `waitForTextMs` optionally waits for asynchronous content; an expired wait remains `recovering` with reason `timeout`. The optional plugin config `keepaliveExpect` maps existing ids to replacement matcher arrays and schedules a fresh check if those rules change.

**A dead session is the plugin's problem.** A failed check moves the entry to `recovering` and retries on a 5-minute, 15-minute, then hourly backoff, because many outages are the site's own and a visit that renews the session ends them. Repeated authentication failures mean a person may have to sign in: after `keepaliveEscalateAfter` consecutive failures (3 by default) the entry says `needs-human` and repeats a notice at most once an hour, always with since when, how many attempts, the last URL, and the step that blocked. The moment a check passes, the entry is `ok`, its counters are zero, and one `recovered` event goes out. A visit that could not run at all — a dead browser, a refused connection — says `error` and never escalates, because signing in would not fix it.

**One event per transition.** Every change of state publishes exactly one event through the plugin's event bus, `headless-browser/keepalive`, and an entry that stays `needs-human` publishes at most one `reminder` an hour. A host that wants the owner told subscribes there; the package itself sends no message.

**The timer, the file, and the tab cap.** The interval is 5 minutes through 24 hours, and `add` refuses anything outside it, a duplicate URL, a URL carrying credentials, and a site that names no host. Records persist in `$DSH_HOME/data/headless-browser/keepalive.json` and are re-armed when the plugin loads, so a restart does not forget a session. A check visits the URL in its own offscreen page: the page pool keeps at most two, the page never enters the tab model, and the tab the agent or the owner is on stays the active one. A keepalive therefore never counts against the eight-tab cap.

```text
headless_browser_keepalive {"action":"add","url":"https://example.com/inbox","everyMinutes":30,"label":"inbox"}
headless_browser_keepalive {"action":"list"}
headless_browser_keepalive {"action":"check","id":"k1"}
headless_browser_keepalive {"action":"remove","id":"k1"}
```

`list` answers with `id`, `label`, `url`, `everyMinutes`, `state` (`ok`, `recovering`, `needs-human`, or `error`), `consecutiveFailures`, `firstFailureAt`, `lastOkAt`, `lastCheckAt`, `lastAttemptAt`, `nextAttemptAt`, `lastUrl`, `blockedStep`, `lastError`, and machine-readable `reason` (such as `sso_redirect:<host>`, `missing_text:<matcher>`, `forbidden_text`, `network`, or `timeout`), and `GET /headless-browser/status` carries the same list under `keepalive`. `check` runs one attempt at once, before the timer is due, and answers with the same fields.

### The page is data, never instructions

A page can say anything: that a checkbox "verifies it is human", that a form is a routine confirmation, that a link goes to the course site. None of that is a reason to act, and this package does not leave the decision to the model's judgement. Every mutating tool (`headless_browser_open`, `_click`, `_type`) asks a host-side action guard first, and the guard answers from measurements and fixed tables rather than from the page's words. `headless_browser_scroll` names no destination, so it cannot change the site and the guard has nothing to decide there.

**Visibility score.** [`src/visibility.ts`](src/visibility.ts) measures the element a person would have to hit and turns the measurement into a score from 0 to 1: computed `display` and `visibility`, the product of the opacity chain, the box area, `pointer-events`, `aria-hidden`, the fraction of the box inside the viewport after scrolling to it (an instant scroll, so a page with `scroll-behavior: smooth`, as Greenhouse's job boards set, is measured where the field lands rather than mid-animation), how much of the box a hit test at five points reaches (followed down through open shadow roots, so a field nested inside custom elements, as SmartRecruiters builds its forms, is not taken for covered), and how many ancestors clip it (the element's own `overflow` clips only its content, so it never counts). A test a person cannot work around (display, visibility, pointer events, aria-hidden) weighs most, so one of them alone scores zero. A click or type is refused below `VISIBILITY_THRESHOLD`, which is 0.2, and the refusal names the score and the tests that dragged it down. When a selector matches several elements, the guard acts on the highest-scoring one and reports its score beside the runner-up's, so the model can see it chose the real control over a decoy. A match that is `aria-hidden` or covered brings one more candidate: the interactive element at its centre, when that element carries the same accessible name. Workday hides each real `<button>` under a transparent `role="button"` overlay with the same label, and that overlay is what a person's click reaches. Its sign-in is the one exception to the label: the hidden `<button type="submit">Sign In</button>` sits under an overlay named "Submit", so an overlay named "Submit" over a `type="submit"` control counts as the same control. Any other covered element under a differently named one finds no candidate and stays refused. The area test measures a searchable dropdown's input (a combobox input, as react-select renders every Greenhouse choice) by the control around it, since the input is a caret wide until text arrives; a plain input that small is still refused. A styled checkbox or radio keeps the real input on top at opacity 0 over the box it paints (Workday's terms box), so the opacity test reads the painted box right under the input, or else the input's visible label; an opacity-0 checkbox with neither is still refused.

**Sensitive names.** [`SENSITIVE_ACTIONS`](src/guard.ts) is the one table of destructive and money-moving verbs: submit, pay, purchase, place or confirm an order, transfer, approve, delete, remove, archive, or deactivate an account, unsubscribe, revoke. A target whose accessible name or value matches any of them is refused and needs `headless_browser_hand_over`. The table is conservative on purpose: a false positive costs one hand-over the owner answers in seconds, a false negative costs an account or a payment.

**Turning the name rule off.** `sensitiveActions: false` switches off only that rule: a target whose name or value matches the table runs, and the decision is still recorded as a security event with `rule: 'sensitive-name'` and `skipped: true`, so the audit trail keeps every target the rule would have refused. It exists for a task the owner is supervising directly — the owner read the form and wants the agent to press Submit — and it leaves the visibility score and the origin rule exactly as they are, because those measure whether a person could hit the target and whether the action leaves the site, not whether the owner already agreed to this one click.

**Origin drift.** A click or type is judged against the registrable domain of the page it runs in, so a form in one tab is not a site change because another tab was last on Handshake; a fresh tab with no site of its own, and the drift log, use the last site the session was on. Opening, clicking, or typing that would move to another domain is refused once; the agent repeats the call with `allowOrigin: true`, which is recorded as an event. A subdomain of the same registrable domain is the same site, so `mail.example.com` and `example.com` pass. A move the page makes on its own is recorded as a drift.

**Every refusal is a security event.** One event per decision carries the page URL, the selector, accessibility id, or point, the accessible name, the rule, the score, and one short line of reason. The list keeps the newest 50 and is served under `security` by `GET /headless-browser/status`; the plugin also emits `headless-browser/security` for a host that watches. The model reads a refusal as a `blocked` tool result, reports it to the owner, and must not retry with another selector, a coordinate, or an accessibility id.

**A legitimate invisible element.** A file input is the usual one: the real `<input type="file">` is often `display:none` or `opacity:0`, and a styled label opens it. The guard refuses the hidden input, and a person takes over: `headless_browser_hand_over` gives them the page, they click the label, and the operating system's file picker does the rest. A hidden native checkbox behind a styled switch that the input does not sit on top of is the same case, and neither needs a selector exception.

**Coordinates.** A click or type at a viewport point has no element to score, so the guard hit-tests the point, runs the sensitive-name and origin rules on what it finds, and records the tab, the point, the hit element's accessible name, and its score. The score is audit information there, not a gate: the model is clicking what it saw in a screenshot.

**Accessibility ids.** An `axId` resolves through the id map the page read registers with `HeadlessBrowserSession.setAxResolver`; the session keeps no second map, so an id can never name two elements. An id the map does not know, because the page navigated since the read, is refused by name and the agent reads the page again instead of falling back to a selector or a coordinate. A build whose read registers no map refuses the id with that reason rather than guessing.

**The wrapping.** Every page-derived field in a tool result arrives as `{ "untrusted": "<origin>", "content": "..." }`, and each tool description says so in one line: the page title, a read window's text, the accessible name, the page a screenshot captured. The wrapping is the tool layer's job, not the prompt's.

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `HeadlessBrowserSession` owns the context. The launch is lazy and single-flight, so a tool call and a page view racing each other still start one Chromium; `close()` settles a launch that lost the race. The browser keeps tabs over that one context: the first page is adopted as `t1`, each new tab gets the next id, and a page that closes is replaced so the context and its profile stay open. A launch gets a fresh session id, which the status route reports.

The live view is one CDP screencast per page shared by every connected viewer. `Page.startScreencast` starts for the first viewer and `Page.stopScreencast` stops for the last; every frame is acknowledged before it is fanned out, because Chrome sends the next one only after the ack. Chrome sends frames on repaint, so the hub keeps the last frame: a page that connects to a still page sees the current screen at once instead of a blank area. Frames carry the metadata the page scales pointer input by, and arrive only while the browser page exists.

Input from the page is one JSON message per event. `decodeClientMessage` validates it, `cdpCommand` maps it to `Input.dispatchMouseEvent` (including `mouseWheel`), `Input.dispatchKeyEvent`, or `Input.insertText`, and `TakeoverState` decides whether input is accepted at all. Keys carry the DOM `keyCode` as both CDP virtual key codes, so shortcuts and non-printing keys behave as in a real window; text that cannot be typed key by key uses `Input.insertText`.

One `KeepaliveService` owns the keepalives, their timers, and the offscreen page pool. A check borrows a page, visits the URL, evaluates the challenge probe, and settles the entry; a per-entry in-flight promise makes a timer and a forced `check` share one attempt, a two-slot semaphore caps concurrent visits, and every attempt writes the file before it re-arms. The events leave through `ctx.emit`, the same bus the action guard publishes to, so a host watches both with one subscription style.

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
| [`src/keepalive.ts`](src/keepalive.ts) | The keepalive store, timers, backoff, notices, offscreen page pool, and its JSON file |
| [`src/challenge.ts`](src/challenge.ts) | The generic sign-in test: the page-side probe and the rule that classifies a blocked visit |
| [`src/cookies.ts`](src/cookies.ts) | Cookie filtering, the Cookie header, and the log-safe summary |
| [`src/tools.ts`](src/tools.ts) | The eleven model tools |

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

Seven page tools whenever the mounting scope has the tool registry: `headless_browser_open` (`url`, `newTab`, `allowOrigin`), `headless_browser_snapshot` (`tab`, `fullPage`), `headless_browser_downloads` (`limit`, `waitMs`), `headless_browser_read` (`tab`, `selector`, `offset`, `limit`), `headless_browser_click` (`selector`, `axId`, `x`, `y`, `allowOrigin`, `tab`), `headless_browser_type` (`selector`, `axId`, `x`, `y`, `text`, `enter`, `allowOrigin`, `tab`), and `headless_browser_scroll` (`tab`, `x`, `y`, `deltaY`, `to`). A click or type names exactly one target: a CSS selector, an accessibility id from a page read, or a viewport point. Each description is one sentence naming the operation, what the result answers, and that page-derived fields arrive as `{ "untrusted": "<origin>", "content": "..." }`. Opening returns the settled URL and the document title as untrusted data; a screenshot returns its PNG path and the page it captured; a read returns one text window as untrusted data with a header naming its page and range; a click or type returns the target or point with the accessible name, the score it won with, and the runner-up score; scrolling returns `x`, `y`, `scrollX`, `scrollY`, `pageHeight`, `viewportHeight`, `atTop`, and `atBottom`, so the model knows whether it reached the end. A refusal returns a `blocked` object with the rule, the page, the reference, the name, the reason, the hint, the score, the threshold, the failed tests, and every test's value, plus `coveredBy` for a covered target: what a click at its centre reaches instead (tag, id, two classes, role, the start of its label), as page data. The hint says not to reach the element another way; for a covered target it says to close the cookie banner or dialog on top with its own visible button first and then retry, since a consent backdrop such as OneTrust's covers a whole careers page until it is answered. Results are one JSON text block. The typing result never repeats the text, so a password the model typed into a form is not echoed into the session log.

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

### Session tools

#### What the model sees

`headless_browser_cookies` (`domain`) answers `{ "cookies": [ … ], "toHeader": "session=…; theme=dark" }`, one object per cookie with `name`, `value`, `domain`, `path`, `expires`, `httpOnly`, and `secure`. `headless_browser_keepalive` takes an `action` and answers `{ "keepalive": { … } }` for `add` and `check`, `{ "keepalives": [ … ] }` for `list`, and `{ "removed": "k1" }` for `remove`; a refused request answers `{ "error": "everyMinutes must be 5 through 1440: 5 minutes through 24 hours" }` or `{ "error": "k1 (inbox) already visits https://example.com/inbox" }` instead of storing anything.

#### Token effect

Two more definitions on every request whose scope mounts the package: a cookie list is one short object per cookie, a keepalive list is one object per entry, and both are called rarely — a session warmed on a timer does not need the model to look at it every turn.

#### KV Cache effect

Prefix-stable while the definitions are unchanged; results append after the reusable prefix.

### Form tools

#### What the model sees

`headless_browser_upload` (`files`, and `selector` with `index` or `trigger`/`triggerAxId`) answers `{ "attached": [{ "name": "resume.pdf", "bytes": 81234 }], "ref": "#resume", "url": "…", "inputs": 1 }`, or `{ "error": "/etc/passwd is outside the upload directories (…); copy the file there first" }`. `headless_browser_credential` takes an `action`: `create` and `fill` answer `{ "action": "create", "account": { "id": "c1a2b3c4d5e6", "host": "acme.wd5.myworkdayjobs.com", "username": "cv@example.com", "createdAt": "…" }, "wrote": ["#password", "#confirm"], "url": "…", "target": { … } }`, `list` answers `{ "action": "list", "accounts": [ … ] }`, and no answer ever contains a password.

#### Token effect

Two more definitions on every request whose scope mounts the package; results are one short object, and the password never enters the context at all.

#### KV Cache effect

Prefix-stable while the definitions are unchanged; results append after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One browser, one mounting scope** — the routes are fixed paths, so a Host mounts the package once; a second mount collides on `/headless-browser`. The browser is one Chromium with one tab model, not one per Session, so parallel agents share its tabs.
- **The browser binary is the deployment's** — `playwright-core` ships no browser, and this package does not download one. Without `PLAYWRIGHT_BROWSERS_PATH` or an install into the account's cache, every tool call fails with the launcher diagnostic.
- **A download is checked after it finishes** — the size cap applies to the finished file, so a very large download still occupies the browser's temporary directory until it completes or the two-minute limit cancels it; downloads of a keepalive's offscreen page are not kept.
- **Headless is the supported mode** — `headless: false` needs a logged-in desktop session; a service account cannot open a window.
- **A refusal stays a refusal** — the identity fixes what the browser says about itself, not what the site decides: a site that scores the address, the profile, or the request can still refuse the page, and this package answers no challenge.
- **The guard is conservative** — the sensitive-name table matches a word, so "Submit search" and "Delete draft" need the owner too; one hand-over is the price of never matching a real payment. The visibility score reads computed style and geometry, so an element inside a closed shadow root cannot be hit-tested and is refused.
- **The site rule is a heuristic** — the public-suffix list is fixed rather than downloaded, so an unlisted multi-label suffix splits one site into two and costs one refusal. A script can navigate with a URL the guard never sees; a mutating eval reads absolute URLs in its text as a tripwire, not as a proof.
- **Coordinate clicks are audited, not scored** — the guard records what the point hit but does not refuse an invisible hit, because the model is acting on a screenshot; the sensitive-name and origin rules still apply.
- **A read is not scored** — the guard checks where a click or type lands, not what a read returns: page text is wrapped as untrusted data, and the model decides what to do with it.
- **A native select takes its option's text** — `headless_browser_type` on a `<select>` chooses the enabled option whose label, then value, equals the text (case and spacing folded), else the one option the text uniquely starts or appears in, and returns its label in `selected`; an ambiguous or unknown text is refused with a pointer to read the select's options. On a searchable dropdown's input (`role="combobox"` or `aria-autocomplete="list"`) the text goes in as keystrokes, because a written value never opens react-select's list; the one visible option of the list it opens (`aria-controls`) that the text names is clicked after the guard clears it and returned in `selected`, and otherwise the list stays open for the model to click. With `enter: true` the type presses Enter in the field after the text, for a search box that lists its matches only on Enter (Workday's School or University and Field of Study prompts); a combobox then reads and chooses from the list as above, and a plain input leaves the list open for a click. The guard clears the field first, so Enter never reaches a field the type would refuse.
- **A read is the rendered text** — `headless_browser_read` returns what the page renders: collapsed or hidden content is absent, a selector that matches several elements reads only the first, and text inside a shadow root is not part of the document body. A whole-page read lists in `frames` (`url`, `width`, `height`) each embedded http(s) page of at least 200 × 100 pixels, five at most, and appends each one's text after a `[frame <url>]` line: iCIMS shows its whole application inside a same-site iframe, and opening that iframe's address on its own only redirects back to the outer page. A selector the page does not match is looked up in those embedded pages, in order, for a read, click, type, upload or saved credential; the guard then judges the target against the embedded page's address, and a saved credential belongs to that page's host. An assignment list's rows below the fold are in the text even though no screenshot of the viewport contains them.
- **A site's popup becomes a tab** — a window a page opens itself (a "Continue with Google" sign-in, a `target=_blank` link) is adopted as a tab and made active, in the take-over view as well, even past the tab cap; `headless_browser_click` names it in `popups` (`tab`, `opener`, `url`) after waiting 250 ms for it, and when it closes itself its opener is active again. Otherwise the browser keeps at most eight tabs; `headless_browser_close` frees one, and the cap error names that tool. Every navigation has a 20-second deadline.
- **Streaming is live-only** — frames arrive only while a take-over page is connected, are not recorded, and can drop frames when Chrome is busy. A still page sends no new frames, so a page that connects later shows the last painted frame. A renderer that crashes ends the cast, and the picture returns only after the page is reloaded and the user reconnects.
- **The hand-over URL needs a Web server** — in a composition without one, `headless_browser_hand_over` returns `/headless-browser` alone, which the user cannot open.
- **The generated catalogs follow the mount** — `docs/tool-catalog.md` and `docs/config-catalog.md` list this package's tools and fields only after a composition mounts it and the generators run.
- **The page is not localized** — the served page has fixed Chinese copy, unlike Client plugins whose text is locale-owned; it is not part of any Client bundle.
- **The sign-in test is a heuristic** — it reads structure, not meaning: a same-origin page with no password field and no one-time code passes even when it is not the page the owner wanted, and a challenge that shows only a captcha looks like a page. The visit still renews whatever the site allows.
- **A keepalive cannot sign in** — the visit renews a session the site still accepts. Once the site's own session is gone, only a person can restore it: the entry says `needs-human`, repeats at most one notice an hour through the event bus, and the package sends no message by itself.
- **A keepalive is invisible** — its offscreen page is not in the tab strip and cannot be watched on the take-over page; the pool keeps at most two, and a site that opens a dialog leaves the check on whatever page it landed on.
- **Cookies reach the session transcript** — a cookie call's values are in the model's history and therefore in the session log on disk, because the caller asked for them; the package itself never writes or logs a value.

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
