---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-fork-message-sources

English | [中文](2026-11-12-fork-message-sources.zh.md)

## Summary

Adds the fork's seven message source kinds to user and developer message sources, named after the fork packages that produce them: time-gap, tool-monitor, tool-up, wechat, content-guard, owner-memory, and speaking-style.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-fork-message-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "dd5a878779d8202919b4edfde56d7bf0f11717cc550b0c977ca5aa2541247d1a"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "ca38cdcf28a6b5381f761828bab91b21299bba5004c06a87deca2019254dd489"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "f57b46625e7b43fc2a3adbd35e8ea1230b59e806b2153e011ed24f8e23337ad7"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "2c92e16e156b904a4acf57e7c6704d6a79ccf2b058a4f960ec49bb1fab663ecb"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records stay valid because no existing kind changed. Each new kind carries only its literal kind and the context-form fields, and qualifies as an attribution: a build without the producing plugin keeps the kind and its JSON metadata and derives the recorded message from role and content. Producers inspect a kind only for their own duplicate suppression and for classifying live turns, and replay needs neither. Sessions the fork wrote before its packages were renamed carry these kinds with an older prefix (`<prefix>-wechat`); they are attributions under the same policy, so no existing Session becomes unreadable and none needs a migration. turn-taint and time-gap, the two readers whose decisions depend on the kind or on the untrusted request id, read the older spellings of `tool-monitor` and `untrusted:` as the current ones (`sourceKind`, `untrustedOrigin`). The Session format version stays the same.

<a id="verification"></a>
## Verification

pnpm --silent run verify-persistence-changes passes. pnpm exec vitest run packages/fork passes, including the turn-taint and time-gap cases for the older spellings.

<a id="dev-note"></a>
## Dev Note

None.
