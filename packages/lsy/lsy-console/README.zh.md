---
description: "在浏览器里管理事件服务：消息流页面显示什么坏了、进来多少又有多少到了主人那里、每件事去了哪；设置分区提供每个已集成服务的健康总览、事件总线订阅和定时提醒，以及服务账号的 Claude Code 会话和语音试听。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-console

[English](README.md) | 中文

## 概述

在浏览器里管理事件服务，不用再开 SSH。侧边栏的**消息流**显示有没有东西坏了、影响了谁，进来多少、有多少到了你这里，以及每件事去了哪。**设置 → 服务总览**为每个服务显示一张健康卡片，带“管理”链接。**设置 → 订阅与监控**可以暂停、恢复、删除或新建事件总线订阅和定时提醒；来自配置的保持只读。**设置 → Claude Code 与语音**列出、启动和停止服务账号的 Claude Code 会话，并播放一句语音试听。

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

把下面这一行挂在 Web bundles 旁边；lsy event bundle 已经挂载了它。它需要设置外壳（`@deepseek-ai/dsh-client-ui-settings-general`，声明了 `settings.section` 列表），Host 上还需要 `connection` 服务，Web bundles 都已组合好。其余服务都是可选的：没挂载的服务，它的卡片写“未安装”（说话风格页 `ctx.lsyStyle` 在发布前就是其中之一）。Claude Code 需要 [`lsy-cc-admin`](../lsy-cc-admin/README.zh.md)，event bundle 把它挂在本包旁边。

```yaml
- id: lsy-console
  name: '@deepseek-ai/dsh-lsy-console'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `bili.url` | `http://127.0.0.1:8097` | bili-svc，探测 `<url>/healthz` |
| `ams.url` | `http://127.0.0.1:18090` | AMS 接收器；任何低于 500 的应答都算可达。留空则不显示它的卡片 |
| `probeTimeoutMs` | `2000` | 每次探测的期限 |
| `subscriptions.*` | 与 `watch_create` 相同 | `workspacePath`、`agentPreset`、`permissionPreset`、`coalesceSeconds`、`notifyMaxPerHour`、`sessionMaxPerHour`：用表单建的订阅按什么运行 |
| `previewText` | 一句简短的中文 | 语音试听说的那句话（不超过语音服务的 `tts.maxChars`） |

**总览。**分区打开且页面可见时，卡片每 10 秒刷新一次。只有目标分区已注册时，卡片才会链接到 `bili`、`lsy-qq`、`lsy-wechat`、`lsy-style`、`lsy-sysmon`、`lsy-subscriptions`、`lsy-agents` 或 `account`。服务想给自己的卡片补充细节，可以提供一个可选的 `health()`，返回 `{ state: 'ok' | 'warn' | 'down', detail? }`；`bili` 和 `lsyNotifier` 有它就按它读。说话风格卡片读 [`lsy-style`](../lsy-style/README.zh.md) 的 `ctx.lsyStyle.health()`（`StyleHealth`，收到后再校验一遍；保留和待审样本数、审核模式、上次更新、口癖趋势；只有计数）：有应答为绿，需要审核且有样本在等为黄，抛错或返回意外形状为红。

**消息流。**这个页面从侧边栏自己的入口打开，因为它是用来看的地方，不是要调的设置。它按这个顺序回答主人想知道的事。*有没有坏，影响了谁？* 顶部一行写出第一个断开的服务、没有它就收不到内容的节点（`needs`），以及去处理的入口；断开的节点呼吸红光，失去依赖的节点变虚线。*进来多少，有多少到了我这里？* 旁边的漏斗统计事件、交给智能体的批次、发给主人的消息、判定不用打扰的批次、等主人醒来的消息和失败数，可切换最近一小时、一天或一周；三段数据一起到达，切换不发请求。*哪些路在用？* 每个节点说一件关于现在的事（[`src/client/flow-view.ts`](src/client/flow-view.ts) 的 `factOf`）：有问题时说问题，否则说经过了什么；健康的节点从不说自己健康。经过越多箭头越粗，最近 15 分钟用过的箭头上有小圆点在跑（同时最多十个），什么也没收到的来源退到背景。*这件事去哪了，结果如何？* 侧栏列出最近 50 件事和它们的结果。点一行，它走过的路会一段接一段画出来（`stopsOf`、`route`）：从来源到接手的会话，发给主人时再到主人的微信。结果是事件总线知道的类别，智能体的具体理由留在它的会话里。点击或按 Enter 选中节点，会点亮经过它的所有路径，显示属于它的工具和调用箭头，并把侧栏变成这个节点的内容：现状、对应设置分区的入口（已注册时）、最近经过的事、上下游，以及折叠起来的接线细节。按 Esc 或点背景返回。`prefers-reduced-motion` 下所有动画停止。

拓扑写在 [`src/client/flow-graph.ts`](src/client/flow-graph.ts)：它是主人画出来的流程图，在流程编辑器里画好、导出成 JSON，所以一个节点可以写运行时还没有那样做的东西。每个节点用 `wired`、`via`、`gap` 说明它是已接通、部分接通还是尚未实现、由什么承载，以及与图的差别在哪，`tests/flow-graph.client.spec.ts` 遇到什么都没写的节点会失败。尚未实现的节点默认不显示，由一个开关打开。每个节点有 `cell`，即固定的列和行：一个来源一行，左边是从哪来，右边是到哪去。节点通过 `tracks`（事件来源和订阅）说明事件总线知道它的哪些数据。自带 `title` 的节点不需要词典条目，其余的读 `flow.node.<id>` 和 `.desc`。布局和路径是 [`src/client/flow-model.ts`](src/client/flow-model.ts) 里的纯计算，它不认识任何具体的图。其中的 `problems()` 会报告环、悬空或重复的箭头、没有任何箭头的节点，以及缺一个答案的判断，同一个测试遇到其中任何一种都会失败。健康状态来自 `api/lsy.overview`，用总览的 store；计数来自 `api/lsy.flow`（[`src/activity.ts`](src/activity.ts)），它读事件总线和 presence 服务，只返回标题，不返回事件正文。页面打开时两者每 10 秒一起读取。模型路由卡片不在其中：模型路由是公共基础设施，不是消息流的一环。

**订阅。**在总线配置里定义的订阅显示“来自配置”，没有按钮。`watch_create` 或表单建的订阅可以暂停（不再匹配新事件，已在排队的事件保留）、恢复，或在第二次点击后删除；删除监视时也会停掉它的仓库轮询，和 `watch_delete` 一致。表单需要名称、来源/类型/对象 glob（至少一项）、通知或会话模式，会话模式还要任务说明；会话订阅按配置的预设和工作区运行。定时提醒（`schedule_create`）可以暂停、恢复和删除；改时间请对智能体说。分区最后是**时间间隔提示**，即 [`lsy-time-gap`](../lsy-time-gap/README.zh.md) 的“全部设置”卡片（阈值、时区、排除的预设），它给安静一段时间后才到达的输入加上说明。

**会话自动归档。**同一分区在监控说明下面显示总线是否归档闲置已久的对话 Session（`lsy-event-bus` 的 `autoArchive`）：规则（闲置天数、每次上限、间隔）、下次检查、保护自己 Session 的插件、上一次检查（检查和归档的 Session 数，以及按原因分类的跳过）和最近归档的 30 个 Session。**预览**列出一次检查会归档什么但不归档；**立即归档**真的跑一次。两个按钮点下去立刻变成“正在检查…”，Host 回答之前保持禁用。底部的设置卡片只列 `lsy-event-bus` 的 `autoArchive` 字段，所以改动（天数、试运行、上限）是一次明确的保存，会重载总线。

**Claude Code 与语音。**这里的会话属于 `dsh-runtime` 自己的 Claude Code，不是你本人的。页面只能停止桥在自己 tmux 服务器里启动的会话，最多同时启动 `lsy-cc-admin` 的 `maxSessions`（3）个。第一条任务会作为 Claude Code 的 prompt 参数，所以从这里启动的会话把它当作你本人的话。语音卡片显示朗读和听写是否有应答，试听按钮合成固定的一句话并在浏览器里播放，不发往任何频道。听写属于配置，所以卡片只给出开启它的补丁，保持只读。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 部分在 connection 上注册 `GET /api/lsy.overview`、`GET /api/lsy.flow`、`GET`/`POST /api/lsy.subscriptions` 和 `GET`/`POST /api/lsy.agents`，因此受 `/api` 的登录校验保护。POST 必须是 `application/json`（跨站表单发不出它），不超过 64 KiB，并用 schemastery 校验；拒绝时返回 `{ error, detail? }`，带稳定的错误码和字段路径，从不带值。每个动作记一行日志：名称、目标、结果和耗时（`subscription.delete octo-tags -> ok (3 ms)`），从不记 token、事件、任务或试听的那句话。

总览并行读取每张卡片。每个 HTTP 探测有 `probeTimeoutMs`，整张卡片的上限是它的两倍加半秒，所以卡死的服务只花一个期限并显示为红色；抛错的卡片显示红色，日志只记错误类型。卡片带的是状态和事实（计数、名称、秒数），从不带 URL、密钥或消息正文。构建标识取入口文件所在的 `builds.noindex/<sha>` 目录和它上面 `@deepseek-ai/dsh` 包的版本。Claude Code 的登录状态：`~/.claude/.credentials.json` 非空为 `full`，OAuth token 文件非空为 `token`，否则 `none`；这些文件只做 `stat`。

订阅用总线自己的 API：`listSubscriptions()`、`batches()`（算触发次数）、`subscribe()`、`unsubscribe()` 和 `setPaused()`；提醒用 `ctx.schedule.catalog()` 和 `edit()`（`active`、`delete`）。浏览器立刻移除或翻转一行，Host 的回答再替换它；被拒绝时把那一行放回去并说明原因。`monitor_start` 启动的监控属于启动它的对话，登记在 Host 够不到的预设作用域里，所以页面只说明去哪里管理，不列出它们。自动归档卡片用同一个 GET 读取 `archiveStatus()`，POST 动作 `archive.sweep`（`dryRun` 为 true 或 false）运行 `sweepArchive()`；归档 Session 的标题截到 80 个字符，不发送任何 Session 内容。

Claude Code 会话来自 `ctx.lsyClaudeCode`（[`lsy-cc-admin`](../lsy-cc-admin/README.zh.md)），通过一个很小的结构类型读取，所以这个带浏览器部分的包不会运行时导入任何对等包的值。语音和总线的错误同理，Host 部分按名字识别它们。

浏览器部分通过 `ctx.slots.inject` 注册三个 `settings.section` 条目（`lsy-overview` 顺序 35、`lsy-subscriptions` 58、`lsy-agents` 60），并把消息流注册成 `main` 页面和 `sidebar.panellist` 入口（`lsy-flow`，顺序 20，在插件和自动化之后）。页面跳转到设置时调用设置外壳提供的 `ctx.get('settingsNavigation')?.openSection(id)`。“管理”链接调用设置外壳交给每个分区的 `select(id)`（与 `close` 并列），并且只在目标分区已注册时显示。模型路由卡片在浏览器里由 `api/lsy.balance` 构建。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 部分：四个路由、状态码与错误应答 |
| [`src/overview.ts`](src/overview.ts) | 各卡片与它们带期限的探测 |
| [`src/activity.ts`](src/activity.ts) | 消息流要统计的内容：各时间段的漏斗、来源和订阅，以及最近的事件 |
| [`src/subscriptions.ts`](src/subscriptions.ts) | 总线与定时服务上的列表与动作，以及自动归档的视图与检查 |
| [`src/agents.ts`](src/agents.ts) | Claude Code 与语音卡片、启动、停止和试听 |
| [`src/claude-code.ts`](src/claude-code.ts) | 本页用到的 `ctx.lsyClaudeCode` 的形状 |
| [`src/request.ts`](src/request.ts)、[`src/log.ts`](src/log.ts)、[`src/probe.ts`](src/probe.ts)、[`src/build-info.ts`](src/build-info.ts) | 请求体解析与拒绝、动作日志、期限、构建标识 |
| [`src/views.ts`](src/views.ts) | 两部分共用的类型与路由路径 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、loader、分区和页面注册、试听播放器 |
| [`src/client/resource.ts`](src/client/resource.ts) | store、带乐观动作的 loader，以及感知页面可见性的轮询 |
| [`src/client/Overview.tsx`](src/client/Overview.tsx)、[`Subscriptions.tsx`](src/client/Subscriptions.tsx)、[`Agents.tsx`](src/client/Agents.tsx) | 三个分区 |
| [`src/client/Flow.tsx`](src/client/Flow.tsx)、[`FlowCanvas.tsx`](src/client/FlowCanvas.tsx)、[`FlowBox.tsx`](src/client/FlowBox.tsx)、[`FlowDetail.tsx`](src/client/FlowDetail.tsx)、[`flow-view.ts`](src/client/flow-view.ts) | 消息流页面：页面外壳、图、单个节点、侧栏，以及节点对自己的说法 |
| [`src/client/flow-graph.ts`](src/client/flow-graph.ts)、[`flow-model.ts`](src/client/flow-model.ts) | 消息流的拓扑（只有数据），以及适用于任何图的布局、路径遍历和检查 |
| [`src/client/cards.ts`](src/client/cards.ts)、[`balance.ts`](src/client/balance.ts)、[`subs.ts`](src/client/subs.ts) | 卡片文字、模型路由卡片、表单规则 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [设置领域](../../client/ui-settings/README.zh.md)——这些分区所填的 `settings.section` 插槽
- [lsy-event-bus](../lsy-event-bus/README.zh.md)——订阅与 `setPaused()`
- [lsy-cc-admin](../lsy-cc-admin/README.zh.md)——Claude Code 会话服务
- [lsy-cc-bridge](../lsy-cc-bridge/README.zh.md)——会话所在的启动脚本与工具
- [lsy-voice](../lsy-voice/README.zh.md)——`describe()` 与语音服务
- [lsy-sysmon](../lsy-sysmon/README.zh.md)——这些分区的卡片与轮询所沿用的页面

-----

<a id="model-experience"></a>
## 模型体验

无，这些分区属于浏览器界面，不会进入任何模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **从这里启动的会话不是智能体的**——用表单建的订阅启动的无人值守会话与 `watch_create` 建的相同；从这里启动的 Claude Code 会话属于服务账号，智能体只有在它主动发消息时才会收到消息。
- **不列出监控**——`monitor_start` 的登记属于各个预设挂载；请让启动它的对话执行 `monitor_list` 或 `monitor_stop`。
- **触发次数受保留数量限制**——次数是总线还保留着的批次数（`retainBatches`，默认 1000），“上次触发”是其中最新的一批。
- **听写只读**——它属于配置，而补丁条目的 `config` 会替换整个条目，所以卡片展示补丁而不是替你保存。
- **微信和 bili 的卡片在它们报告健康前信息很少**——服务可以通过增加 `health()` 报告更多。
- **QQ 卡片从不触达 QQ**——它只调用观察器内存里的 `connectionStatus()`（记录器最近推送的状态，可能是红色的 `recorder-down` 或 `protocol-mismatch`）和 `recordedGroups()`（调用其他任何成员，测试都会失败，两者都不发请求），因为这个账号处于 QQ 风控下；本包的任何页面都不会调用协议端或 NapCat 的登录门。
- **试听要等语音模型**——闲置后的第一句在 feiyu 上约需 45 秒；同一时间只跑一个试听。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- `select` 属性是对 `ui-settings-general` 和插槽契约的 fork 修改（见 `packages/lsy/UPSTREAM.md`）；没有分区注册的 id 会显示外壳的第一个分区，所以链接先做检查。
- 触达监控需要 `unattended` 预设往隔离域里发布一个服务，而预设注册表的挂载审计只允许按挂载逐个这样做。

</details>
