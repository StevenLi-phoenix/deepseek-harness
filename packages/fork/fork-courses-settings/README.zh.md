---
description: "课程 DDL 提醒的设置页：开关与当前是否静默、上次和下次检查以及立即检查按钮、课程同步健康与最新失败原因、接下来的截止及下次提醒、最近发出的提醒、规则，以及 fork-courses 的全部设置卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-courses-settings

[English](README.md) | 中文

## 概述

在一个地方查看和修改课程 DDL 提醒。设置 → 课程 DDL 显示提醒开没开、现在是否静默，DSH 上次什么时候检查你的课程记录、发了什么，课程同步是否正常（以及最近一次成功和最新一次失败的原因），接下来有哪些截止、各自什么时候提醒，以及发出过的提醒，每条都能展开。一个按钮可以立即检查。提醒开关、提醒时间点、静默时段和同步提醒设置在页面底部的卡片里修改。

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

把它挂在 Web profile 的根上，旁边要有 [`@deepseek-ai/dsh-fork-courses`](../fork-courses/README.zh.md) 和 [`@deepseek-ai/dsh-fork-config`](../fork-config/README.zh.md)（全部设置卡片）。fork event bundle 已经这样做了；这一页出现在设置里 QQ 之后。

```yaml
- id: fork-courses-settings
  name: '@deepseek-ai/dsh-fork-courses-settings'
```

它没有配置。立即检查和定时器跑的是同一次轮询，所以会发出当时该发的提醒。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 半边在 `/api` 下、Web UI 登录之后注册 `GET /api/fork.courses`（来自 `ctx.forkCourses.status()` 的状态，映射为 `src/view.ts` 里的线路类型）和 `POST /api/fork.courses.poll`（只收 JSON，跨站表单无法触发；它等一次轮询结束后回答新的状态）。浏览器半边在这一页打开且页面可见时每 15 秒刷新一次，读取失败时保留上一次的回答，并为条目 `fork-courses` 渲染全部设置卡片。所有文案都在 `src/client/locales.ts` 里，共八种语言。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 半边：两条路由和线路映射 |
| [`src/view.ts`](src/view.ts) | 两个半边共用的线路类型和路径 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、加载器、设置页注册 |
| [`src/client/courses.ts`](src/client/courses.ts) | store、加载器和各卡片的文字 |
| [`src/client/polling.ts`](src/client/polling.ts) | 打开且可见时刷新 |
| [`src/client/CoursesSection.tsx`](src/client/CoursesSection.tsx) | 这一页 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [课程服务](../fork-courses/README.zh.md)：这一页每一行背后的规则
- [全部设置卡片](../fork-config/README.zh.md)：配置怎样保存到主人的 patch

-----

<a id="model-experience"></a>
## 模型体验

无，这一页是浏览器界面；这里没有任何东西进入模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只有最近一次轮询**：页面显示最近一次轮询和最近 20 条消息；更早的轮询在服务日志里。
- **接下来的截止要等一次轮询**：重启后在第一次轮询（60 秒）或点立即检查之前是空的。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未定下的方向和给维护者的备注。已发布的行为和已接受的理由以上面各节、包代码和链接的 Agent Notes 为准。

无。

</details>
