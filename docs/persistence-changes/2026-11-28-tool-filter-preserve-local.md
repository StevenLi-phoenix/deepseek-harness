---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-28-tool-filter-preserve-local

English | [中文](2026-11-28-tool-filter-preserve-local.zh.md)

## Summary

Adds the optional `preserveLocal` flag to the tool filter a subagent descriptor records, so a job preset's delegated worker keeps the tools registered in its own layer.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-28-tool-filter-preserve-local
baseline: false
changes:
  - root: "event:subagent/descriptor"
    previous: "2026-09-11-initial"
    after: "7eb393a9b5fc3e8d3f55fd81fa64dd8614449b135e168548fc04ecb34c094e81"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The property is optional. A reader that predates it ignores the key and applies the allow and deny lists as before; a descriptor written without it reads as `preserveLocal` absent, which keeps the earlier behavior. No Session format version changes.

<a id="verification"></a>
## Verification

`pnpm run verify-persistence-changes` reports no unacknowledged change, and `packages/fork/tool-job-apply/tests/composition.spec.ts` checks that a worker delegated from a job preset inherits the same job tools.

<a id="dev-note"></a>
## Dev Note

None.
