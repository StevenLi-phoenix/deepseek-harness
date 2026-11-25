---
description: "fork 各常驻服务和工具共用的 Host 端帮助代码：被跟踪的后台工作和可中止的等待、频道打开并交给主人中继的 Session、JSON 设置路由的请求体与错误、一次不经 Session 的模型调用，以及 JSON 工具的输出。"
kind: "package-library"
---

# @deepseek-ai/dsh-service-kit

[English](README.md) | 中文

## 概述

fork 的频道服务（B 站、微信、QQ 机器人、QQ 观察者）、事件总线和它们的工具做着同样的底层活，所以共用这一份代码。后台工作被跟踪，在存储关闭前等它们结束；重试等待可以随时提前结束；聊天 Session 按预设打开并由主人中继认领；设置路由用同样的方式读取 JSON 动作；内容守卫和梗挖掘器通过同一段代码完成各自的那一次模型调用。

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

在 Host 代码里导入它，并和 fork 的其他工作区依赖列在一起。它不是插件，从不挂载。它的导出没有模块级状态，也不做身份检查，所以依赖策略把它列为重复安装也安全的包，这让带浏览器面的 `bili` 能在 Host 端导入它。

```ts
import { BackgroundWork, openPresetSession, pause, readJsonAction } from '@deepseek-ai/dsh-service-kit'

private readonly background = new BackgroundWork((error) => { this.ctx.logger.warn(`svc: background work failed: ${String(error)}`) })
// teardown: await this.background.drain()
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

`BackgroundWork` 维护一条串行的存储写入链（某次失败交给它的调用方，链继续往下走）、失败只交给回调的被跟踪工作，以及结果仍归调用方的被持有工作；`drain()` 等它们全部结束。`pause(ms, signal, slot)` 在定时到点、中止或调用 `slot.wake` 时结束，结束时清掉 `slot.wake`，除非后来的等待已经占用它。`unavailableReason` 保留仍能解析的已存 Session，在 agent 忙或写入者被占用时抛出；`openPresetSession` 在创建任何东西之前先检查权限预设；`forgetOldest` 丢掉最早记住的 Session；`joinRelay` 在存储打开后认领已存的 Session，频道离开后不再认领。`readJsonAction` 回答 415 或 400，不复述请求体。`callModelOnce` 以温度 0 运行，在显式路由上使用模型提供的最轻推理强度。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 导出 |
| [`src/work.ts`](src/work.ts) | `BackgroundWork`、`pause` |
| [`src/chat-session.ts`](src/chat-session.ts) | `unavailableReason`、`openPresetSession`、`forgetOldest`、`joinRelay` |
| [`src/json-route.ts`](src/json-route.ts) | `readJsonAction`、`readJsonBody`、`jsonFailure`、`NO_STORE` |
| [`src/model-call.ts`](src/model-call.ts) | `callModelOnce` |
| [`src/tool-output.ts`](src/tool-output.ts) | `ERROR_SCHEMA`、`renderJson`、`renderWrapped` |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [fork 的包](../README.zh.md) —— 导入它的服务和工具

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过调用它的包：`callModelOnce` 发出内容守卫和梗挖掘器的提示词，工具渲染函数决定 fork 工具返回内容的形式。

#### KV Cache 影响

它自己没有影响；每个调用方的请求都是一次不经 Session 的调用，不共享缓存前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **一次只有一个模型调用** —— `callModelOnce` 流式发送一个请求，不保留对话；需要后续追问的调用方要另发一个请求。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未定下的方向和给维护者的备注。已发布的行为和已接受的理由以上面各节、包代码和链接的 Agent Notes 为准。

- `joinRelay` 按结构接收中继（`RelayRegistry`），因为 `owner-relay` 依赖 `event-bus`，而 `event-bus` 导入这个包。

</details>
