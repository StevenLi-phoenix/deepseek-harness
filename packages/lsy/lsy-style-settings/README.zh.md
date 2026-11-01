---
description: "说话风格设置分区：给主 agent 校准语气的 QQ 群和 B站真人对话，按来源分组、一键删除，审核挂起的样本，加入 owner 自己的句子，上次收集情况，以及套话趋势。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-style-settings

[English](README.md) | 中文

## 概述

在手机上就能看清并纠正主 agent 从哪里学语气。设置 → 说话风格 列出 [lsy-style](../lsy-style/README.zh.md) 保存的每一条说话风格样本：你自己的话在最前，然后是 QQ 群和 B站评论区，每条都有删除按钮，删了立即生效，也不会再回来。审核开启时还会显示待审核的样本供你留或删，可以写一句自己的话加进去，能看到上次收集读了多少、按原因筛掉了多少，以及每天还有多少回答带着禁用套话。

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

Host 一半在 `/api` 下注册三条路由，所以由连接的登录检查保护：`GET /api/lsy.style`（面板）、`POST /api/lsy.style.edit`，内容是 `{ "op": "remove" | "keep", "id" }` 或 `{ "op": "add", "reply", "prompt"? }`，以及 `POST /api/lsy.style.collect`（开始一次收集并立即返回）。它们每次请求时读取 `ctx.lsyStyle`，lsy-style 没挂载时返回 503。浏览器一半是设置分区 `lsy-style`（标签 说话风格）：一张结论卡片显示样本数、审核方式和「立即收集」；待审核样本带「留」和「删」；你自己的、QQ 的和 B站的样本带「删」；添加输入框；上次收集及按过滤原因的计数；以及趋势。删除或保留会在 Host 回答之前就显示在页面上，Host 拒绝时撤回。

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

-----

<a id="model-experience"></a>
## 模型体验

无，这个分区属于浏览器界面；样本经 lsy-style 到达主 agent，不经过这个包。

#### KV Cache 影响

无；这个包既不组装也不发送任何模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **只有 owner 能用** — 路由只回应已登录的 owner Peer，和 DSH 页面其他部分一样。
- **开关在 profile patch 里** — 页面显示内容块是否开启和审核方式；要改它们，改根部 `lsy-style` 行的 `enabled` 和 `review`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作笔记 — 点击展开</summary>

这份开发备注不是权威说明：只记录未决方向和给维护者的笔记。已发布行为和已接受的理由以上面各节、包代码和链接的 Agent Notes 为准。

- 分区单独成包，是因为带浏览器一半的包不能在依赖策略没有审核例外的情况下取用 Host 包的运行时导出，而 lsy-style 需要好几个。

</details>
