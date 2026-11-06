---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-lsy-message-sources

English | [中文](2026-11-06-lsy-message-sources.zh.md)

## Summary

Adds the fork's seven lsy message source kinds to user and developer message sources: lsy-time-gap, lsy-tool-monitor, lsy-tool-up, lsy-wechat, lsy-guard, lsy-memory, and lsy-style.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-lsy-message-sources
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "97fa75db3de96bd6c0d3650a9f2ca8d69527ad9187079729856148d22e3cb001"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "ff9f62ce2935a0d0376dc61964a15254ea15ba4a0d56dcceeb044710de5e277d"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "6599a5f8c5d9a8a5d6bb3f296b676f0252cc14a65099d90322a29181bf4fc383"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "da6159b4a5167bf6ddf0cc91621ac517d89b6d39ff383b6d59b6b86c88e34ba0"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records stay valid because no existing kind changed. Each new kind carries only its literal kind and the context-form fields, and qualifies as an attribution: a build without the producing plugin keeps the kind and its JSON metadata and derives the recorded message from role and content. Producers inspect a kind only for their own duplicate suppression and for classifying live turns, and replay needs neither. Session format version remains unchanged.

<a id="verification"></a>
## Verification

pnpm --silent run verify-persistence-changes passes. pnpm exec vitest run packages/lsy/lsy-time-gap packages/lsy/lsy-tool-monitor packages/lsy/lsy-tool-up packages/lsy/lsy-wechat packages/lsy/lsy-guard packages/lsy/lsy-memory packages/lsy/lsy-style packages/lsy/lsy-taint passes.

<a id="dev-note"></a>
## Dev Note

None.
