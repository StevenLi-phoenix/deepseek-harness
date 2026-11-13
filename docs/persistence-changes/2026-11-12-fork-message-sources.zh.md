---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-fork-message-sources

[English](2026-11-12-fork-message-sources.md) | 中文

## 概述

把 2026-11-06-fork-message-sources 加入的 fork 七种消息来源 kind 随产生它们的 fork 包一起改名：time-gap、tool-monitor、tool-up、wechat、content-guard、owner-memory 和 speaking-style。

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
    previous: "2026-11-06-fork-message-sources"
    after: "dd5a878779d8202919b4edfde56d7bf0f11717cc550b0c977ca5aa2541247d1a"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-06-fork-message-sources"
    after: "ca38cdcf28a6b5381f761828bab91b21299bba5004c06a87deca2019254dd489"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-06-fork-message-sources"
    after: "f57b46625e7b43fc2a3adbd35e8ea1230b59e806b2153e011ed24f8e23337ad7"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-06-fork-message-sources"
    after: "2c92e16e156b904a4acf57e7c6704d6a79ccf2b058a4f960ec49bb1fab663ecb"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

改名之前写下的记录保留旧 kind。按那份记录说明的来源兼容策略，这些 kind 现在算作署名：读取方保留 kind 和它的 JSON 元数据，不从中推出任何行为，所以没有已有 Session 变得不可读，也不需要迁移。turn-taint 和 time-gap 是两个按 kind 或不可信请求 id 做判断的读取方，它们把 `tool-monitor` 和 `untrusted:` 的旧写法读成现在的写法（`sourceKind`、`untrustedOrigin`）。Session 格式版本不变。

<a id="verification"></a>
## 验证

pnpm --silent run verify-persistence-changes 通过。pnpm exec vitest run packages/fork 通过，包括 turn-taint 和 time-gap 针对旧写法的用例。

<a id="dev-note"></a>
## 开发备注

无。
