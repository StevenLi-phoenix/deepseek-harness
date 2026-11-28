---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-27-notify-learning-source

[English](2026-11-27-notify-learning-source.md) | 中文

## 概述

在 user 消息来源中加入 notify-learning 来源类型，用于 notify-learning 插件在不是 owner 开启的回合之前放入的规则块。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效，因为没有改动任何已有类型。新类型只带它的字面类型和 context-form 字段，属于归属信息：没有 notify-learning 插件的构建会保留该类型及其 JSON 元数据，并按角色和内容还原记录下的消息。插件读取自己的类型只是为了通过一个只在 Host 上的 Session projection 得知某个 Session 收到过哪个版本的规则，回放两者都不需要。Session 格式版本保持不变。

<a id="verification"></a>
## 验证

pnpm --silent run verify-persistence-changes 通过。pnpm exec vitest run packages/fork/notify-learning 通过：78 个测试，包括规则块的来源和压缩之后的 projection。

<a id="dev-note"></a>
## 开发备注

无。
