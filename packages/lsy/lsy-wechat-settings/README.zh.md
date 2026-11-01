---
description: "设置 → 微信（扫码绑定主人的 bot、通道健康、回复窗口、解绑）和设置 → 勿扰（睡眠专注、每日时段、按钮、iPhone 快捷指令步骤）的浏览器端；Host 路由由 lsy-wechat 和 lsy-presence 提供。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-wechat-settings

[English](README.md) | 中文

## 概述

在任何浏览器里管理主人的微信通道和勿扰时段。**设置 → 微信**扫码绑定 bot，显示是否已绑定、长连接是否健康、回复窗口和发件箱，点两次解绑。**设置 → 勿扰**显示你是否被视为在睡觉及原因，把不紧急的消息留到你醒来，并附有 iPhone 快捷指令的设置说明。两页都在打开时每隔几秒轮询，页面隐藏时暂停。

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

把下面这一行挂在 Web bundles 旁边；lsy event bundle 已经挂载了它。它需要设置外壳（`@deepseek-ai/dsh-client-ui-settings-general`，声明了 `settings.section` 列表）。页面要等 Host 路由存在才有用：`/api/lsy.wechat` 来自 [`@deepseek-ai/dsh-lsy-wechat`](../lsy-wechat/README.zh.md#understand-the-implementation)，`/api/lsy.presence` 来自 [`@deepseek-ai/dsh-lsy-presence`](../lsy-presence/README.zh.md)，各有自己的挂载行。

```yaml
- id: lsy-wechat-settings
  name: '@deepseek-ai/dsh-lsy-wechat-settings'
```

这个包没有配置。它的分区是 `lsy-wechat`（顺序 52）和 `lsy-presence`（顺序 53），词典有八种语言。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 一侧是个空的 `apply`，让插件出现在 Loader 里，浏览器端（`exports["./client"]`，经 `package.json` 里的 `dsh.client` 找到）得以送达。路由不在这里，因为它们需要运行中的通道和在线状态服务，而带浏览器面的包在运行时不能引入它们；Host 包保留路由，仍然只有 Host 面。路由回答的线上类型（`src/wechat-view.ts`、`src/presence-view.ts`）是 `lsy-wechat/src/view.ts` 和 `lsy-presence/src/view.ts` 的副本；两个 Host 包里各有一个测试，副本差一个字节就会失败。

每页有一个 store 和一个 loader：它们共享进行中的请求，请求失败时保留上一次的视图，并把页面的动作 POST 到同一个路由。微信页还每 2 秒轮询进行中的二维码登录，用 Host 发来的模块行画出二维码（白底上的一条 SVG 路径，所以深色主题下也能扫），并且只在链接是微信域名下的 HTTPS 链接时才提供它。两页都不显示令牌或消息正文：Host 遮挡 id，只回答时间、数量和代码，快捷指令说明里写的是保存 ingest 令牌的环境变量名，从不是它的值。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Node 一侧：空的 `apply` |
| [`src/wechat-view.ts`](src/wechat-view.ts)、[`src/presence-view.ts`](src/presence-view.ts) | Host 包线上类型的逐字节相同的副本 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：注册两个分区 |
| [`src/client/wechat/`](src/client/wechat) | 微信分区：store、loader、轮询、二维码绘制、分区本身、词典 |
| [`src/client/presence/`](src/client/presence) | 勿扰分区：store、loader、轮询、分区本身、词典 |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [lsy-wechat](../lsy-wechat/README.zh.md)——通道和 `/api/lsy.wechat` 路由
- [lsy-presence](../lsy-presence/README.zh.md)——在线状态和 `/api/lsy.presence` 路由
- [设置领域](../../client/ui-settings/README.zh.md)——这些分区填充的 `settings.section` 槽
- [lsy-memory-admin](../lsy-memory-admin/README.zh.md)——这个包沿用布局的纯浏览器端包

-----

<a id="model-experience"></a>
## 模型体验

无，因为这些分区属于浏览器界面；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送提供商请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **线上类型有两份**——改了 Host 的 `view.ts`，这个包里也要做同样的改动；改之前 Host 测试会失败。
- **只在打开时**——没人打开分区时不轮询。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 两个页面共用一个包，因为它们很小而且一起发布；拆开就需要再建一个布局相同的包。

</details>
