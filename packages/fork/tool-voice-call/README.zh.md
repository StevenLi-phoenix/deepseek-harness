---
description: "面向模型的 call_owner 工具：agent 经 ctx.voiceCall 给 owner 打电话，由另一个通话 Session 和 owner 对话，通话结束后工具返回结果、时长和通话记录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-voice-call

[English](README.md) | 中文

## 概述

消息不够用的时候，让 agent 给你打电话。agent 调用 `call_owner`，写下这通电话要说的全部内容；你的 iPhone 经 DSH Call app 响铃，另一个通话 agent 和你出声对话。你挂断后，工具返回通话结果和说过的话，打电话的 agent 就能按你的回答去办。你拒接、没接，或者电话被拒绝（这一小时打得太多，或者你在睡觉而这事不紧急），都会如实返回，由 agent 决定要不要改发消息。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个包

把这一行加到允许打电话的 agent preset 的插件列表里，同一进程还要挂 [`@deepseek-ai/dsh-voice-call`](../voice-call/README.zh.md)。fork 的事件 profile 在 `unattended` preset 里挂了它；`ctx.voiceCall` 存在后工具才注册，所以 voice-call 那一行禁用时它不会出现。

```yaml
- id: tool-voice-call
  name: '@deepseek-ai/dsh-tool-voice-call'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxTranscriptLines` | `60` | 返回给 agent 的通话记录行数，保留最新的；其余的计入 `omittedLines` |

限额、睡眠和线路本身归 `voice-call` 管。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

工具调用 `ctx.voiceCall.ring({ reason, urgent }, signal)` 并等待；工具调用的 abort signal 会取消还在响铃的电话，或挂断正在进行的电话。`callOutput` 把结果变成工具输出：一个拒绝，或者结果、说明、通话秒数（没接通时为 0）和最新的几行通话记录。每次调用记录结果、时长和行数，从不记录说了什么。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：工具定义和 `callOutput` |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [语音通话线路](../voice-call/README.zh.md)——推送、通话 Session、语音和限额
- [`speak`](../tool-voice/README.zh.md)——在微信上发音频文件，而不是打电话

-----

<a id="model-experience"></a>
## 模型体验

### 打电话工具

#### 模型看到什么

调用方 Agent 的 preset 挂了这个包、并且 `ctx.voiceCall` 存在时，有一个工具 schema：`call_owner`，必填字符串 `reason`，可选布尔值 `urgent`（默认 false）。说明写着：owner 的 iPhone 会像普通来电一样响铃，由另一个通话 agent 和 owner 对话；只有语音对话明显比消息好时才打，因为电话会打断 owner；通话 agent 只知道 `reason`，所以要写清事实、需要 owner 做什么和可选项，并用通话的语言写；每小时有限额，owner 睡觉时只有 `urgent` 的电话会响，被拒、没接或拒接都不算回答。

#### Token 影响

挂了这个包的 preset 下，Agent 的每个请求都有固定的 schema 开销；其他 preset 下的 Agent 不付任何代价。

#### KV Cache 影响

工具定义和可见性不变时前缀稳定；挂载或卸载可能让从第一个变化的 schema token 起的复用失效。

### 通话结果

#### 模型看到什么

每通电话结束后一个 JSON 文本块：`{ "outcome": "completed" | "declined" | "missed" | "failed" | "cancelled", "detail"?, "durationS", "transcript": [{ "role": "owner" | "agent", "text" }], "omittedLines"? }`，或者 `{ "refused": "<原因>" }`，例如 `another call is in progress`、`no phone is registered; …`、`already 4 calls in the last hour (limit 4)` 或 `the owner is asleep; call again with urgent only if it cannot wait`。通话记录是 owner 说的话和通话 agent 的回答。

#### Token 影响

拒绝或未接是几十个 token，长通话最多 `maxTranscriptLines` 行那么大，保留在 Session 历史里直到压缩。

#### KV Cache 影响

只追加；新可见的内容跟在可复用的请求前缀之后，不会让已有的 KV Cache 条目失效。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **会阻塞**——工具要等整通电话结束（默认最长 15 分钟），发起调用的那一轮也跟着等。
- **不能中途插话**——打电话的 agent 没法往通话里说话；通话 agent 只凭 `reason` 工作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 接通后马上返回、通话记录之后作为 Session 输入送达，这种方式还没决定。

</details>
