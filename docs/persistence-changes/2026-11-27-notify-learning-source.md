---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-27-notify-learning-source

English | [中文](2026-11-27-notify-learning-source.zh.md)

## Summary

Adds the notify-learning message source kind to user message sources, for the rules block the notify-learning plugin puts before a turn the owner did not start.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-27-notify-learning-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-12-fork-message-sources"
    after: "60b5d981644959b21c2f1c94f3422e3d57032649d7c5d28aa77e169d931c3589"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-12-fork-message-sources"
    after: "b2b2df094cec33e8c61569ca56d71d4fa3f73f062f45c737fb07dd7714749055"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-12-fork-message-sources"
    after: "b01ff04a684a0d7bbb310bc0c8447e9a46419756c6313d5e32b100e2dd75f1d8"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-12-fork-message-sources"
    after: "d64c1a5804987e6e267f1f47b425fa110a13aa8f0e01461317fe8c4592d7e12e"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records stay valid because no existing kind changed. The new kind carries only its literal kind and the context-form fields and qualifies as an attribution: a build without the notify-learning plugin keeps the kind and its JSON metadata and derives the recorded message from role and content. The plugin reads its own kind only to know which revision of the rules a Session was given, through a host-only Session projection, and replay needs neither. The Session format version stays the same.

<a id="verification"></a>
## Verification

pnpm --silent run verify-persistence-changes passes. pnpm exec vitest run packages/fork/notify-learning passes: 78 tests, including the block's source and its projection after a compaction.

<a id="dev-note"></a>
## Dev Note

None.
