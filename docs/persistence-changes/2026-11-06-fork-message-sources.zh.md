---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-fork-message-sources

[English](2026-11-06-fork-message-sources.md) | 中文

## 概述

在 user 和 developer 消息来源中加入分支的七个 fork 来源类型：fork-time-gap、fork-tool-monitor、fork-tool-up、fork-wechat、fork-guard、fork-memory 和 fork-style。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-fork-message-sources
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
## 兼容性

已有记录仍然有效，因为已有类型都没有变化。每个新类型只带字面 kind 和上下文形式字段，并按 attribution 声明：没有对应插件的构建保留该 kind 及其 JSON 元数据，并从角色和内容推导记录的消息。生产方只在自身去重和对实时轮次分类时读取 kind，回放不依赖这两者。Session 格式版本不变。

<a id="verification"></a>
## 验证

pnpm --silent run verify-persistence-changes 通过。pnpm exec vitest run packages/fork/fork-time-gap packages/fork/fork-tool-monitor packages/fork/fork-tool-up packages/fork/fork-wechat packages/fork/fork-guard packages/fork/fork-memory packages/fork/fork-style packages/fork/fork-taint 通过。

<a id="dev-note"></a>
## 开发备注

无。
