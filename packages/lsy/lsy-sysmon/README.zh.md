---
description: "设置里的一个分区，显示 Host 机器的 CPU、内存、功耗、温度和各卷磁盘用量，打开时每五秒刷新一次；功耗和温度来自无需 sudo 的 macmon。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-sysmon

[English](README.md) | 中文

## 概述

不开终端，在任何浏览器里看运行 dsh 的这台机器状况如何。**设置 → 系统状态**显示 CPU 占用（附核心数和平均负载）、内存已用与总量（附交换区）、整机功耗（附 CPU、GPU、神经网络引擎的瓦数和芯片温度），以及每个卷一条用量条（已用、总量、剩余），用到 85% 变琥珀色，95% 变红。打开时每五秒刷新一次；Host 不再应答时保留上一次的读数。功耗和温度来自无需 sudo 的 macmon；没装时卡片会说明怎么安装。

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

把下面这一行挂在 Web bundles 旁边；lsy event bundle 已经挂载了它。它需要设置外壳（`@deepseek-ai/dsh-client-ui-settings-general`，声明了 `settings.section` 列表），Host 上还需要 `connection` 服务，Web bundles 都已组合好。

```yaml
- id: lsy-sysmon
  name: '@deepseek-ai/dsh-lsy-sysmon'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `macmonPath` | 未设置：`<home>/bin/macmon` 存在时用它，否则 `/opt/homebrew/bin/macmon` | 读取功耗、温度和内存的 [macmon](https://github.com/vladkens/macmon) 程序的绝对路径 |
| `mounts` | `/System/Volumes/Data`（`Internal`）、`/Volumes/MiniSSD`（`MiniSSD`） | 要显示的卷，按顺序：`mount`（挂载点）和 `label`。读不到的挂载点显示为不可用并附原因 |
| `cacheMs` | `2000` | Host 用缓存回答的时长；`?fresh=1` 可绕过缓存，但最多每 2 秒一次 |

给服务运行所用的用户安装 macmon：`brew install macmon`，或把发布版二进制放进该用户的 `~/bin`。没有它时，分区仍显示 CPU、磁盘和近似的内存数字（总量减空闲页，会把 macOS 的文件缓存算作已用）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 部分在 connection 上注册 `GET /api/lsy.sysmon`，因此受 `/api` 的登录校验保护。每次采样通过 `execFile` 以固定参数运行 `macmon pipe -s 1 -i 500`，超时 5 秒、输出上限 1 MiB（不经过 shell；请求里的任何内容都不会进入命令），只从它的 JSON 行里取有限数值；同时读取 `os.cpus()` 的 tick、`os.loadavg()`，并对每个挂载点调用 `fs.statfsSync()`。CPU 占用是自上一次采样以来 tick 中非空闲的比例（上一次采样不超过 30 秒时），否则取 macmon 运行期间这一段；两种窗口都没有时为 `null`。Host 读不到的数一律是 `null`，从不是 `0`：虚拟机里的零瓦会变成 `power: null`。采样从不抛错；macmon 的状态在 `sources.macmon`（`ok`、`missing`、`failed`），`statfs` 失败的挂载点进入 `skippedMounts`，原因为 `not found`、`not permitted` 或 `unreadable`。每种状态变化只记一次日志。快照缓存 `cacheMs`，进行中的采样共享。

一个卷的 `used` 是 Host 用户不可用的全部空间（`total − bavail × bsize`），因此 `used + free = total`。在 APFS 上这是整个容器的用量，也就是真正会被占满的那部分。

浏览器部分通过 `ctx.slots.inject` 注册一个 `settings.section` 条目（`lsy-sysmon`，排在内置分区之后），与上游页面相同，因此跟随设置外壳的生命周期。外壳只挂载当前打开的分区，所以这个分区在打开且页面可见时每 5 秒请求一次相对于文档的 `api/lsy.sysmon`，关闭时停止。一个 `SysmonLoader` 共享进行中的请求；请求失败时保留上一次的快照，状态行会说明它的采样时间。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 部分：配置、带缓存的 `/api/lsy.sysmon` 路由 |
| [`src/sampler.ts`](src/sampler.ts) | 一次采样：CPU tick 差值、磁盘、内存兜底、缓存与状态变化日志 |
| [`src/macmon.ts`](src/macmon.ts) | 运行 macmon 并解析它的 JSON 行 |
| [`src/snapshot.ts`](src/snapshot.ts) | 两部分共用的快照类型与路由路径 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、loader、设置分区注册 |
| [`src/client/sysmon.ts`](src/client/sysmon.ts) | store、loader 与感知页面可见性的轮询 |
| [`src/client/cards.ts`](src/client/cards.ts) | 由快照得出卡片内容、单位与阈值颜色 |
| [`src/client/SystemStatus.tsx`](src/client/SystemStatus.tsx) | 分区本身 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [设置领域](../../client/ui-settings/README.zh.md)——这个分区所填的 `settings.section` 插槽
- [lsy-balance](../lsy-balance/README.zh.md)——fork 的另一个浏览器包，本包的路由与卡片沿用它的做法

-----

<a id="model-experience"></a>
## 模型体验

无，这个分区属于浏览器界面，不会进入任何模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **功耗需要 Apple Silicon 上的 macmon**——其他 Host 显示 CPU、磁盘和近似内存，功耗卡片会说明为何为空。
- **容器用量，而非卷自身用量**——APFS 卷共享所在容器的空间，所以用量条显示的是容器有多满；`df` 显示的是每个卷自己的文件。
- **遗留的挂载点目录**——卸载后留在原路径的目录会报告它所在的文件系统；macOS 卸载时会删除 `/Volumes/<name>`，所以这种情况很少见。
- **只在打开时采样**——没人打开这个分区时，不采样、不保存、也不告警。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 插件市场搜索（`dsh-plugin-sourcing`）找到 13 个以上的系统监视插件，都不合用：它们的路由没有登录校验，也都读不到 macOS 的分卷磁盘与功耗。
- 参考（只读未运行）：[MM998LI/dsh-dock-vitals](https://github.com/MM998LI/dsh-dock-vitals)（MIT）的固定参数 `execFile` 与按需采样；[weihaobin0818-lgtm/dsh-system-monitor](https://github.com/weihaobin0818-lgtm/dsh-system-monitor)（MIT）的逐挂载点 `statfs`；[vladkens/macmon](https://github.com/vladkens/macmon)（MIT）作为功耗来源。
- 在 Mac mini 上，macmon 0.10.0 已为 `dsh-runtime` 安装在 `/Users/dsh-runtime/bin/macmon`。

</details>
