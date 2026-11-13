---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-fork-message-sources

[English](2026-11-12-fork-message-sources.md) | 中文

## 概述

在用户和开发者消息来源里加入 fork 的七种消息来源 kind，按产生它们的 fork 包命名：time-gap、tool-monitor、tool-up、wechat、content-guard、owner-memory 和 speaking-style。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录保持有效，因为没有已有 kind 改变。每个新 kind 只携带它的字面 kind 和上下文形式字段，并算作署名：没有对应插件的构建保留 kind 和它的 JSON 元数据，按 role 和 content 还原记录的消息。产生方只在自己的去重和对实时 turn 分类时检查 kind，回放两者都不需要。fork 在包改名之前写下的 Session 带着旧前缀的这些 kind（`<prefix>-wechat`）；按同一策略它们算作署名，所以没有已有 Session 变得不可读，也不需要迁移。turn-taint 和 time-gap 是两个按 kind 或不可信请求 id 做判断的读取方，它们把 `tool-monitor` 和 `untrusted:` 的旧写法读成现在的写法（`sourceKind`、`untrustedOrigin`）。Session 格式版本不变。

<a id="verification"></a>
## 验证

pnpm --silent run verify-persistence-changes 通过。pnpm exec vitest run packages/fork 通过，包括 turn-taint 和 time-gap 针对旧写法的用例。

<a id="dev-note"></a>
## 开发备注

无。
