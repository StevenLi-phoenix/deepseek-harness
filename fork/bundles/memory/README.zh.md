---
description: "event 服务的设置 → 记忆层：owner 记忆文件的审核页，以及它背后的路由。"
kind: "package-bundle"
---

# @deepseek-ai/memory

[English](README.md) | 中文

## 概述

这一层加上设置 → 记忆：待批或待弃的写入、可搜索/撤销/删除的条目、可按 Session 回滚的改动，以及人格回复的保留/删除判定。页面是浏览器那一半；它的 `/api/owner-memory` 路由读 `<DSH_HOME>/owner-memory/memory.jsonl`，不注册工具，agent 碰不到它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

### 装进 event profile

这一层随仓库发布：`fork/deploy/setup-profile.sh` 会把 `fork/bundles/` 下的每个目录链接进 `$DSH_HOME/profiles/event/node_modules/@deepseek-ai/`，并写好 profile 清单，所以部署时不用逐台改动。手动加入就自己建链接，把名字加到 `dsh.profile.bundles` 末尾。

### 这一层挂载什么

| 行 | 包 | 挂载什么 |
|---|---|---|
| `owner-memory-admin` | `@deepseek-ai/dsh-owner-memory-admin` | 设置 → 记忆页面 |
| `owner-memory-settings` | `@deepseek-ai/dsh-owner-memory/settings` | `/api/owner-memory` 这条 Host 路由 |

### 它依赖什么

`preset-unattended` 里的 `owner-memory` 行，它持有这个页面所读的记忆文件。那一行随预设留在骨架里。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

这里的行就是该功能原先写在 `@deepseek-ai/dsh-event-bundle` 里的那些，逐字搬过来，相对顺序不变。profile 按 `dsh.profile.bundles` 的顺序把各层合成一个扁平的 patch 列表来应用，`insert` 是追加，所以这一层挂载在它用到的骨架行之后、owner 的 profile patch 之前。挂载顺序和理由写在 `fork/bundles/event/README.md`。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [owner 记忆包](../../../packages/fork/owner-memory/README.zh.md)
- [记忆审核页包](../../../packages/fork/owner-memory-admin/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 页面管理的是 Host 放在 root Session 前面的文件；它不改 Session 的对话记录。
- 受保护写入按 `owner-memory` 行的 `hold` 决定，这一层不改那个值。
