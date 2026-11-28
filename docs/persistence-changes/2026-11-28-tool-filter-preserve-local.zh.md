---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-28-tool-filter-preserve-local

[English](2026-11-28-tool-filter-preserve-local.md) | 中文

## 概述

为子 agent 描述记录的工具过滤器新增可选的 `preserveLocal` 标记，使求职 preset 委派出的 worker 保留在自身层注册的工具。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

该属性是可选的。早于它的读取方会忽略这个键，照旧应用 allow 和 deny 列表；不带它写入的描述按 `preserveLocal` 缺省读取，行为与之前相同。Session 格式版本不变。

<a id="verification"></a>
## 验证

`pnpm run verify-persistence-changes` 不再报告未确认的变更；`packages/fork/tool-job-apply/tests/composition.spec.ts` 检查从求职 preset 委派出的 worker 继承同一组求职工具。

<a id="dev-note"></a>
## 开发备注

无。
