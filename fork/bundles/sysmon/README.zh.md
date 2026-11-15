---
description: "event 服务的设置 → 系统状态层：这台 Mac 的 CPU、内存、功耗、温度和各卷磁盘。"
kind: "package-bundle"
---

# @deepseek-ai/sysmon

[English](README.md) | 中文

## 概述

这一层加上设置 → 系统状态：服务所在 Mac 的 CPU、内存、功耗、温度和各卷磁盘。功耗和温度来自一个不需 sudo 的 helper；默认值写的是这份部署用的卷。

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
| `sysmon` | `@deepseek-ai/dsh-sysmon` | 系统状态卡片和它的读数 |

### 它依赖什么

读功耗和温度要 `/Users/dsh-runtime/bin/macmon` 这个 helper；没有它这两项是空的。

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

- [系统状态包](../../../packages/fork/sysmon/README.zh.md)

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 读数是本机的：没有远端机器，也没有历史，只有当前值。
