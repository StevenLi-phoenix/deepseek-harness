---
description: "The owner's Gmail accounts in DSH as ctx.gmail: one Google sign-in per account (work, personal, a bot), the refresh tokens in the credential store, the Gmail REST client, mail composition, and the send gate that holds a message as a Gmail draft and asks the owner on WeChat with a code when the account's policy and the turn's origin say so."
kind: "package-reference"
---

# @deepseek-ai/dsh-gmail

English | [中文](README.zh.md)

## Summary

Let your agent read, draft, and send mail from each Gmail account you connect, so that no stranger's email can make it send anything. Each account has a policy: read-only, confirm all, confirm risky ones, or send at once. A message is risky when you did not start the turn alone, the agent read mail or a web page in it, or a recipient is new. It stays a Gmail draft that DSH, by fixed rules, shows you on WeChat with a code; it goes out only when you answer `发送 CODE` or confirm it in Settings → 邮箱.

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

Mount it at the root of a process that also mounts the storage domain facility, the credential store, and a notifier such as [`@deepseek-ai/dsh-wechat`](../wechat/README.md). The fork event bundle mounts it with its defaults beside [`gmail-settings`](../gmail-settings/README.md), which serves the page Google's sign-in returns to; the tools are [`tool-gmail`](../tool-gmail/README.md).

```yaml
- id: gmail
  name: '@deepseek-ai/dsh-gmail'
```

To connect accounts, create a Google Cloud project with the Gmail API enabled, an OAuth consent screen, and an OAuth client of type Web application whose redirect URI is `<DSH origin>/gmail.oauth` (Settings shows the exact value). Paste the client's JSON file in Settings → 邮箱; the id and secret go to the credential store under `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`. Then add each account with an id of your choice (`work`, `personal`, `bot`) and sign in as that address. The one permission asked for is `gmail.modify`: read, draft, send, and change labels, never permanent deletion. An app left in Testing mode loses its sign-ins after seven days, so publish the consent screen to In production.

| Field | Default | Meaning |
|---|---|---|
| `clientIdEnv` / `clientSecretEnv` | `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | Names of the OAuth client id and secret in the credential store or `$DSH_HOME/.env` |
| `redirectUri` | `''` | Redirect URI registered at Google; empty derives `<Settings origin>/gmail.oauth`, which must be https or localhost |
| `trustedRecipients` | `[]` | Addresses every account sends to at once, besides the connected accounts' own; checked at load |
| `maxSendsPerDay` | `50` | Messages one account may send in 24 hours; more are refused |
| `confirmTtlHours` | `72` | Hours a held message waits for the owner before it expires |
| `requestTimeoutMs` | `30000` | Timeout of one call to Google |
| `maxSearchResults` | `20` | Threads one search returns at most (at most 50) |
| `maxBodyChars` / `maxHtmlChars` | `20000` / `500000` | Characters of one body shown to the model, and of an HTML body read at most |
| `maxThreadMessages` | `10` | Newest messages of one thread shown; older ones are only counted |
| `maxAttachmentBytes` / `maxDownloadBytes` | 18 MiB / 25 MiB | All attachments of one outgoing message, and one received attachment saved |

### Policies

| Policy | Sends |
|---|---|
| `read-only` | Nothing: search and read only; drafts, sends, and label changes are refused |
| `confirm-all` | Every message waits for the owner |
| `confirm-untrusted` (default for a new account) | At once when every recipient is one of the owner's own addresses or `trustedRecipients`; otherwise at once only in a clean turn (the owner started it alone and no tool read strangers' words in it) and when each recipient was named in the owner's own words in this turn or got mail from this account before (its Sent folder); otherwise it waits |
| `direct` | At once; for a bot account |

### Rules

- **Turn facts** — whether a turn is clean, its origin, and the owner's own words come from the Session log through [`turn-taint`](../turn-taint/README.md); the model supplies none of them. Reading mail (`gmail_search`, `gmail_read`, `gmail_attachment`) makes the turn not clean.
- **Held** — a held message is kept as a Gmail draft and gets a six-character code; the owner's WeChat notice lists From, To, Cc, Bcc, the subject, the attachments, why it waits, and the first 400 characters of the text. The gate decides on, and the notice shows, the draft as Gmail stores it (its RFC 5322 text), and its SHA-256 is kept.
- **Confirm** — from Settings, or from a clean turn whose owner message holds the code as a word, in which the agent calls `gmail_send` with the code before it reads any mail or web page. The draft is read again: a changed draft is discarded and not sent, a deleted one is dropped, and a read-only account sends nothing.
- **Expiry** — an unconfirmed message expires after `confirmTtlHours`; its draft stays in Gmail. A held draft cannot be changed or sent by the agent.
- **Cap** — every send, confirmed ones included, counts toward the account's rolling 24-hour cap; a send over it is refused.
- **Attachments** — a file to attach must resolve (links followed) to a regular file in the Session's working directory or the system temporary directory, outside hidden directories other than `.gmail-inbox/`, with a name that does not look like a key or credential. A received attachment is saved to `<cwd>/.gmail-inbox/` (directory 0700, file 0600, ignored by git).
- **Reconnect** — when Google refuses a refresh token, the account is marked, every call on it fails, and the owner gets one WeChat notice to sign in again in Settings.
- **Remove** — revokes the token at Google, deletes it, and discards the account's held messages.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The sign-in is an authorization-code request with PKCE (S256), offline access, and forced consent so Google returns a refresh token; its `state` lives in memory for ten minutes and is used once, at most 20 at a time. The refresh token is a grant record in `ctx.credentials` (`gmail/<account>`); access tokens stay in memory, refreshed a minute before they expire, one refresh per account at a time, and a rotated refresh token is stored. The REST client drops a token on 401 and retries once, retries 429 after a pause, and retries 5xx or a broken connection only for calls safe to repeat, so a send is never sent twice. A new message is composed as RFC 5322 text (base64 UTF-8 text, RFC 2047 headers, RFC 2231 file names, `In-Reply-To` and `References` for a reply) from addresses checked to the simple dot-atom form, and a header value with a line break is refused, so no argument adds a header or a hidden recipient. Received bodies are the `text/plain` parts, or the HTML converted in one linear pass without a DOM, decoded by each part's charset, with the quoted history cut off. Bcc of a draft is read from `format=raw`, since the parsed draft may leave it out. Confirmations, discards, finished sign-ins, removals, and policy changes run one at a time. Every operation logs its account, duration, and outcome; tokens, codes from Google, and the secret are never logged.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service `ctx.gmail`: configuration, accounts, tokens, reading, drafts, the send flow, held messages, sign-in, Settings status |
| [`src/gate.ts`](src/gate.ts) | The send decision, the owner's named addresses, and the confirmation by code |
| [`src/oauth.ts`](src/oauth.ts) | Google OAuth: PKCE, consent URL, code exchange, refresh, revocation |
| [`src/api.ts`](src/api.ts) | Gmail REST client: retries, uploads, typed failures |
| [`src/mime.ts`](src/mime.ts) | Composition of an outgoing message |
| [`src/address.ts`](src/address.ts) | Recipient parsing and checks |
| [`src/message.ts`](src/message.ts) | Received messages as headers, text, and attachments |
| [`src/html.ts`](src/html.ts) | HTML bodies as plain text |
| [`src/attachments.ts`](src/attachments.ts) | Files to attach and received attachments to save |
| [`src/storage.ts`](src/storage.ts) | Storage domain `gmail`: accounts, held and resolved messages, sends, activity |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Gmail tools](../tool-gmail/README.md) — what the main agent calls
- [Settings → 邮箱](../gmail-settings/README.md) — the client, the accounts, the held messages, and the sign-in page
- [Turn origin](../turn-taint/README.md) — how a turn is classified

-----

<a id="model-experience"></a>
## Model Experience

### Notices in the chat Session

#### What the model sees

Nothing is registered for a model. The WeChat channel keeps a copy of each notice in the owner's chat Session as a notice from another Session, whose `origin` says it comes from the Gmail send gate (fixed rules, not a model) and that a held message goes out only when the owner's own next message holds its code and the agent then calls `gmail_send` with it, or when the owner confirms it in Settings. A held message's notice is titled `✉️ 待你确认：<account> 发给 <first recipient>[ 等]` and lists the sender, recipients, subject, attachments, the reason, the start of the text, and `要发就回复「发送 <code>」`. A reconnect notice is titled `⚠️ Gmail <account>（<address>）要重新登录`.

#### Token effect

The notice text once per held message, typically 200 to 700 characters, and once per refused sign-in, in the owner's chat Session only.

#### KV Cache effect

Append-only; the notice follows the reusable request prefix and does not invalidate existing KV Cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The gate guards the tools, not the machine** — the refresh tokens sit in the credential store of the DSH user, so a shell or code tool running as that user could read them and call Google directly; real isolation needs the tokens under another user.
- **No new-mail trigger** — the agent reads mail when asked or when a schedule runs; Gmail push (Pub/Sub watch) is not wired.
- **Earlier turns** — a clean turn may still carry words read in an earlier turn in the model's context; the named-or-written-before rule for recipients limits what such words can do.
- **Workspace accounts** — an organization's Google Workspace admin can block an app that Google has not verified.
- **Accepted is not delivered** — a held message's notice queues while the WeChat reply window is closed; Settings shows every held message either way.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

- The Gmail MCP connectors (claude.ai's, or a community server) were not used: DSH needs several accounts in one process, a send gate the model cannot bypass, and no third party holding the tokens.

</details>
