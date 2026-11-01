---
description: "QQ 的设置分区：QQ 观察者是否连着、NapCat 的登录状态；QQ 把账号踢下线后，显示用手机扫码重新登录的二维码，并在页面上自动更新。"
kind: "package-reference"
---

# @deepseek-ai/dsh-fork-qq-login

[English](README.md) | 中文

## 概述

QQ 被踢下线后，用手机就能恢复，不用开终端。**设置 → QQ** 给出一句结论（「QQ 已连接」「需要扫码登录」「NapCat 没有响应」），下面写着下一步。需要扫码时，它画出大到能从另一块屏幕扫的登录二维码，并随 NapCat 轮换而更新；扫码、确认，几秒内结论变成「已连接」。第二张卡片列出连接状态（自何时起、第几次尝试、最近的错误）和 NapCat 的登录状态；第三张卡片用来编辑记录哪些群。

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

把下面这一行挂在 QQ 观察者旁边；fork event bundle 已经挂载了它。它需要 [`@deepseek-ai/dsh-fork-qq`](../fork-qq/README.zh.md)（`ctx.forkQq`）、Host 上的 `connection` 服务，以及浏览器侧的设置外壳，后两者 Web bundles 都已组合好。它没有配置项。

```yaml
- id: fork-qq-login
  name: '@deepseek-ai/dsh-fork-qq-login'
```

二维码来自 NapCat 的登录状态，经扫码入口（login door，`fork/deploy/napcat/napcat.sh door`，`napcat.sh start` 会一并启动）取得；`login.url` 和 `settingsUrl` 见 [fork-qq](../fork-qq/README.zh.md#use-this-package)。没有扫码入口时，分区仍显示连接状态，并说明怎么启动它。恢复步骤在运行手册里（[QQ 掉线恢复](../../../fork/deploy/RUNBOOK.md#qq-recovery)）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 部分在 connection 上注册 `GET /api/fork.qq` 和 `POST /api/fork.qq.refresh`，因此两者都受 `/api` 登录校验保护（只有 owner Peer 能访问，POST 同样经过 Host/Origin 围栏）。答案由 `ctx.forkQq` 组装：连接状态、登录读数和记录的群数。NapCat 给出的登录链接在 Host 上用 `uqr` 编码成模块矩阵，只发送矩阵，浏览器据 `0`/`1` 行画出二维码，从不接触链接本身；二维码的任何内容都不写日志。`?fresh=1` 跳过观察者 1.5 秒的共享读数；刷新路由请求扫码入口生成新码，入口每 10 秒只放行一次。

「记录的群」卡片是这个分区唯一会写入的地方。`fork-qq` 的 `groups` 字段可热更新，所以卡片通过 `fork-qq` 条目的插件设置表单（`ctx.configForms`）读取它，并用 `form.set('groups', …)` 写入整份新名单：Host 校验、按修订号加围栏（别处刚改过的名单会被拒绝而不是被覆盖）、保存到 profile patch，观察者无需重启即可跟随，并为新加的群补抓历史。卡片按名称列出名单里的群，列出账号所在的其他群（丢弃消息最多的排前面，来自面板，最多 60 个）供一键添加，接受手输的群号（3 到 20 位数字），移除前要确认。没有任何手工编辑文件。

浏览器部分通过 `ctx.slots.inject` 注册一个 `settings.section` 条目（`fork-qq`，排在系统状态之后）。外壳只挂载当前打开的分区，所以这个分区在打开且页面可见时每 3 秒请求一次相对于文档的 `api/fork.qq`，关闭时停止。一个 `QqLoader` 共享进行中的请求；请求失败时保留上一次的答案，状态行会说明它的时间。结论由 `headline()` 决定：观察者自己的连接在线时以它为准，否则由 NapCat 的登录状态决定该做什么，扫码入口答不上来时则说明怎么把它拉起来。二维码是内联 SVG（一条由水平条组成的路径，带两个模块的静区），不论主题都是白底黑码，最宽 320 px。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 部分：两条路由 |
| [`src/panel.ts`](src/panel.ts) | 答案组装与二维码矩阵 |
| [`src/view.ts`](src/view.ts) | 两部分共用的答案类型与路由路径 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、loader、设置分区注册 |
| [`src/client/qq.ts`](src/client/qq.ts) | store、loader 与感知页面可见性的轮询 |
| [`src/client/cards.ts`](src/client/cards.ts) | 由答案得出结论、明细行和二维码路径 |
| [`src/client/QqLogin.tsx`](src/client/QqLogin.tsx) | 分区本身 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [QQ 观察者](../fork-qq/README.zh.md)——连接、扫码入口和这个分区所补充的主人通知
- [fork-sysmon](../fork-sysmon/README.zh.md)——系统状态分区，本包的路由与轮询沿用它的做法

-----

<a id="model-experience"></a>
## 模型体验

无，这个分区属于浏览器界面，不会进入任何模型请求，登录二维码也从不交给 agent。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **需要扫码入口**——没有它（`napcat.sh door`）就没有二维码可显示；分区会说明这一点，仍显示连接状态。
- **屏幕扫不了自己**——在手机上看这一页时，先截屏，再在 QQ 的「扫一扫」→ 相册里选这张截图。
- **编辑依赖设置表单**——`fork-qq` 条目必须在可写的层里有唯一地址；Host 不提供它（或更高优先级的层覆盖了 `groups`）时，卡片会说明，名单仍在 profile patch 里设置。
- **仅限 owner**——路由只回答已登录的 owner Peer；拿到 DSH 页面及其登录的人能扫这个码，和能用 DSH 的其他功能一样。
- **QQ 说了算**——NapCat 不是官方客户端，QQ 可能要求新设备验证或拒绝登录；分区显示 NapCat 自己的错误文字，手机上显示 QQ 的提示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 浏览器从不直接访问 NapCat 的 WebUI：它的令牌能在容器里开 shell、读取 QQ 会话，所以只有扫码入口（两个端点）持有它。已否决：把 WebUI 端口开放给服务用户。
- 不提供「不扫码重新登录」按钮（NapCat 的快速登录）：能让它生效的会话，正是 QQ 刚刚踢下线的那一个。

</details>
