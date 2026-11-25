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
    previous: "2026-11-19-cua-input-notices"
    after: "79a56e5943e5fb5f86a23e5e9f8356bcbd721e38dd00633a504ea4ca7263139a"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "743fc214e30e61140d5ed08798086282f2a5032ebb6cd8ceae7d48e971f10f03"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "1727b1c2adfbe7bd64895ef86e33b1615b77a314ed61610a6af0e07b98dc2502"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "f638e6da07a1cb69c06f40336571fea828b1481782fd12f5da20dcdb59ff964f"
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
