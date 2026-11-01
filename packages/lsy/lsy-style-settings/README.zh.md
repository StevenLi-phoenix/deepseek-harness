---
description: "说话风格设置分区：人设卡及其历史（编辑、回滚、删除）、性格、带释义和出处的热梗、可一键删除的语气样本、热梗挖掘器的上次运行、套话趋势，以及插件自己的配置。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-style-settings

[English](README.md) | 中文

## 概述

在手机上看清并纠正 DSH 的声音。设置 → 说话风格 显示人设卡及其历史，以及 [lsy-style](../lsy-style/README.zh.md) 保存的性格、热梗和语气样本，每条都有立即生效的删除按钮。热梗标出在哪里读到、释义从哪来。还显示待审核样本、上次收集和热梗挖掘的运行情况、套话趋势和插件配置。

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

和 lsy-style 一起挂在根部；没有需要配置的东西。

```yaml
- id: lsy-style-settings
  name: '@deepseek-ai/dsh-lsy-style-settings'
```

Host 一半在 `/api` 下注册三条路由，所以由连接的 owner 检查保护（其他 Peer 得到 403；有测试经真实连接跑过）：`GET /api/lsy.style`（面板）、`POST /api/lsy.style.edit`，内容是 `{ "op": "remove" | "keep", "id" }`、`{ "op": "block", "term" }`、`{ "op": "card", "card" }`、`{ "op": "rollback", "version" }` 或 `{ "op": "deleteVersion", "version" }`，以及 `POST /api/lsy.style.collect`（开始一次收集和一次挖掘并立即返回）。它们每次请求时读取 `ctx.lsyStyle`，lsy-style 没挂载时返回 503。浏览器一半是设置分区 `lsy-style`（标签 说话风格）：一张结论卡片显示条目数、审核方式和「立即收集」；待审核样本带「留」和「删」；人设卡带「编辑」「删除」和历史（每个版本和前一版对照，每个历史版本带「回滚到这版」和「删」）；性格、热梗（各群的黑话，标出每个梗的出处、释义来源和同族说法，再列 HotWatch 的标题）、语气样本（猫灯手写的回复在最前）三栏，每条带「删」；上次收集及按过滤原因的计数；热梗挖掘器的上次运行（按类别的读取文本数、新增、刷新、提议、模型调用、搜索，以及按规则的拒绝）；趋势；页脚是 `lsy-style` 条目的「全部设置」卡片（[lsy-config](../lsy-config/README.zh.md)，预设行字段 `mode`、`block`、`tools`、`dir`、`ticsFile` 不显示）。删除、保留、改卡、回滚或删历史版本都会在 Host 回答之前就显示在页面上，Host 拒绝时撤回。两种审核方式都能用：`required` 下新的语气样本会在待审核卡片里等着。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 基于 `ctx.lsyStyle` 的 Host 路由，以及服务返回值符合 `src/view.ts` 的编译期检查 |
| [`src/view.ts`](src/view.ts) | 路由路径和面板字段，两半共用 |
| [`src/client/index.ts`](src/client/index.ts) | 注册词典和分区 |
| [`src/client/style.ts`](src/client/style.ts) | store、loader（读取、先显示后确认的编辑、收集）以及轮询（页面可见时每 5 秒） |
| [`src/client/StyleSection.tsx`](src/client/StyleSection.tsx) | 分区本身 |

这是 fork 本地的包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [说话风格](../lsy-style/README.zh.md) — 收集、过滤、存储，以及主 agent 读到的内容块
- [QQ 分区](../lsy-qq-login/README.zh.md) — 本分区参照的同类设置分区
- [全部设置卡片](../lsy-config/README.zh.md) — 页脚的配置编辑器

-----

<a id="model-experience"></a>
## 模型体验

无，这个分区属于浏览器界面；样本经 lsy-style 到达主 agent，不经过这个包。

#### KV Cache 影响

无；这个包既不组装也不发送任何模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只有 owner 能用** — 路由只回应已登录的 owner Peer，和 DSH 页面其他部分一样。
- **开关在配置卡片里** — 页面显示内容块是否开启和审核方式；要改它们，改根部 `lsy-style` 行的 `enabled` 和 `review`，页脚的卡片会把它保存进 owner 的 patch（随后插件重载）。
- **除人设卡外没有手写入口** — 其余每条数据的来源只能是 QQ、B站或 agent 读过的网页，所以页面没有添加梗或样本的输入框；人设卡是 owner 唯一自己写的文字。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作笔记 — 点击展开</summary>

这份开发备注不是权威说明：只记录未决方向和给维护者的笔记。已发布行为和已接受的理由以上面各节、包代码和链接的 Agent Notes 为准。

- 分区单独成包，是因为带浏览器一半的包不能在依赖策略没有审核例外的情况下取用 Host 包的运行时导出，而 lsy-style 需要好几个。

</details>
