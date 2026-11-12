---
description: "fork-gmail 的设置页区块「邮箱」：等主人确认的信（可确认或丢弃）、已连接的账号（发信规则、重新登录、移除）、经 Google 登录添加账号、OAuth client 设置、规则和动态；另有 Google 登录完成后跳回的页面，位于 /api 之外。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-gmail-settings

[English](README.md) | 中文

## 概述

在一个地方管理 agent 用的 Gmail 账号。设置 → 邮箱 最上面是等你确认的信，每封都列出发件人、全部收件人（包括密送）、主题、附件、正文开头和为什么要确认，带一个发送按钮和一个丢弃按钮。下面是你的账号和各自的发信规则，可以重新登录或断开；一个表单经 Google 自己的登录添加账号。第一次使用时，页面会一步步带你建 Google OAuth client 并接收它的 JSON 文件；secret 不会再回到浏览器。

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

把它挂在 Web profile 的根上，旁边是 [`@deepseek-ai/dsh-fork-gmail`](../fork-gmail/README.zh.md)。fork event bundle 就是这样挂的；这个区块在设置里排在「课程 DDL」之后。要通过 https（或 localhost）打开设置页：Google 只把登录结果返回给这样的页面，地址是 `<origin>/fork.gmail.oauth`，也就是要给 OAuth client 注册的重定向 URI。

```yaml
- id: fork-gmail-settings
  name: '@deepseek-ai/dsh-fork-gmail-settings'
```

它没有配置；上限和可信收件人属于 `fork-gmail`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 部分在 `/api` 下、Web UI 登录之后注册 `GET /api/fork.gmail`（状态取自 `ctx.forkGmail.status()`，逐字段映射成 `src/view.ts` 里的线路类型，所以服务新增的字段不经审查到不了浏览器）和 `POST /api/fork.gmail`。POST 必须是 `application/json`，跨站表单发不出来；请求体是 `client`、`sign-in`、`policy`、`remove`、`confirm`、`discard` 之一，用严格的 schema 检查，回答新的状态（`sign-in` 另带要打开的 Google 页面）。服务拒绝时回答 400 和它的说明；其他失败回答 500 和一句通用文字，并把原因写进日志。`GET /fork.gmail.oauth` 在 `/api` 之外，因为 DSH 的登录 cookie 是 `SameSite=Strict`，Google 的跨站跳转不会带上它；从设置页开始的登录有一个只能用一次的 `state`，用它来认证请求。这个页面是静态 HTML，所有值都转义，没有脚本，带 `Content-Security-Policy: default-src 'none'`、`Referrer-Policy: no-referrer`（地址里有 Google 的一次性授权码）和 `Cache-Control: no-store`。浏览器部分在区块打开且页面可见时刷新，读取失败时保留上一次的回答，全部文案有八种语言。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 部分：状态和操作路由、线路映射、登录页路由 |
| [`src/view.ts`](src/view.ts) | 两部分共用的线路类型和路径 |
| [`src/page.ts`](src/page.ts) | 登录页的 HTML 和响应头 |
| [`src/client/`](src/client/) | 浏览器部分：区块、它的 store 和刷新、文案 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Gmail 服务](../fork-gmail/README.zh.md)：发信规则、发信关卡、待确认的信、登录

-----

<a id="model-experience"></a>
## 模型体验

无，这个区块和登录页都是浏览器界面；这里没有任何东西进入模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **登录只存在内存里**：DSH 重启前开始的登录完成不了；重新开始一次即可。
- **不显示邮件**：页面显示待确认的信和动态，不显示邮箱内容；读信去 Gmail 本身。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>给维护者的工作上下文——点击展开</summary>

本开发备注是非权威的工作上下文：尚未定下的方向和给维护者的备注。已发布的行为和已接受的理由以上面各节、包代码和链接的 Agent Notes 为准。

无。

</details>
