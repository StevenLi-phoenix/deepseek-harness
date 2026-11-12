---
description: "Settings section 邮箱 for fork-gmail: the messages waiting for the owner's confirmation with confirm and discard, the connected accounts with their send policy, reconnect, and remove, adding an account through Google's sign-in, the OAuth client setup, the rules, and the activity; plus the page Google's sign-in returns to, outside /api."
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-gmail-settings

English | [中文](README.zh.md)

## Summary

Manage the Gmail accounts your agent uses in one place. Settings → 邮箱 shows the messages waiting for your confirmation first, each with its sender, every recipient (Bcc too), subject, attachments, the start of its text, and why it waits, with a button to send it and one to discard it. Below are your accounts with their send policy, sign-in again, and disconnect; a form adds an account through Google's own sign-in. The first time, the page walks you through creating the Google OAuth client and takes its JSON file; the secret never comes back to the browser.

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

Mount it at the root of a Web profile beside [`@deepseek-ai/dsh-fork-gmail`](../fork-gmail/README.md). The fork event bundle does; the section appears in Settings after 课程 DDL. Open Settings over https (or localhost): Google returns a sign-in only to such a page, at `<origin>/fork.gmail.oauth`, which is the redirect URI to register for the OAuth client.

```yaml
- id: fork-gmail-settings
  name: '@deepseek-ai/dsh-fork-gmail-settings'
```

It has no configuration; the limits and the trusted recipients belong to `fork-gmail`, whose All settings card ([`fork-config`](../fork-config/README.md)) sits at the foot of the section.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half registers `GET /api/fork.gmail` (the status from `ctx.forkGmail.status()`, mapped field by field to the wire types in `src/view.ts`, so a new service field never reaches the browser unreviewed) and `POST /api/fork.gmail` under `/api`, behind the Web UI sign-in. A POST must be `application/json`, so a cross-site form cannot send one; its body is one of `client`, `sign-in`, `policy`, `remove`, `confirm`, or `discard`, checked by a strict schema, and it answers the new status (and for `sign-in` the Google page to open). A refusal from the service answers 400 with its message; any other failure answers 500 with a generic text and logs the cause. `GET /fork.gmail.oauth` lies outside `/api`, because the DSH sign-in cookie is `SameSite=Strict` and Google's cross-site redirect arrives without it; the one-use `state` of a sign-in started from Settings authenticates it. That page is static HTML with every value escaped, no script, `Content-Security-Policy: default-src 'none'`, `Referrer-Policy: no-referrer` (the URL holds Google's one-use code), and `Cache-Control: no-store`. The browser half refreshes while the section is open and the page visible, keeps the last answer through a failed read, and keeps all copy in eight languages.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host half: the status and action routes, the wire mapping, the sign-in page route |
| [`src/view.ts`](src/view.ts) | Wire types and paths shared by both halves |
| [`src/page.ts`](src/page.ts) | The sign-in page's HTML and headers |
| [`src/client/index.ts`](src/client/index.ts) | Browser half: registers the section and its dictionaries in `settings.section` |
| [`src/client/GmailSection.tsx`](src/client/GmailSection.tsx) | The section: summary, held messages, accounts, OAuth client, rules, activity, the All settings card |
| [`src/client/Held.tsx`](src/client/Held.tsx) | Held messages with 发送 (restates the recipients, posts on the second click) and 丢弃; the resolved ones |
| [`src/client/Accounts.tsx`](src/client/Accounts.tsx) | Account cards (policy, 重新登录, 断开) and the add-account form |
| [`src/client/ClientCard.tsx`](src/client/ClientCard.tsx) | The OAuth client: the Google Cloud steps, the redirect URI, the JSON box |
| [`src/client/parts.tsx`](src/client/parts.tsx) | Props and small pieces the cards share |
| [`src/client/gmail.ts`](src/client/gmail.ts) | The store, the loader (one read and one action at a time), and the text helpers |
| [`src/client/polling.ts`](src/client/polling.ts) | Refresh while the section is open and the page visible |
| [`src/client/locales.ts`](src/client/locales.ts) | The copy in eight languages |
| [`src/client/GmailSection.module.css`](src/client/GmailSection.module.css) | The section's styles |

This is a fork-local package; see [`../UPSTREAM.md`](../UPSTREAM.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Gmail service](../fork-gmail/README.md) — policies, the send gate, held messages, sign-in

-----

<a id="model-experience"></a>
## Model Experience

None, as the section and the sign-in page are browser chrome; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Sign-ins live in memory** — a sign-in started before a DSH restart cannot finish; start it again.
- **No mail view** — the page shows held messages and the activity, not the mailboxes; Gmail itself is the place to read mail.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is non-authoritative working context: undecided directions and notes for maintainers. Shipped behavior and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

None.

</details>
