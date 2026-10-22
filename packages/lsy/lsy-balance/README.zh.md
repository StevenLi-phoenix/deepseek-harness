---
description: "输入框下方统计栏里的余额小块：在活动与用量读数旁常驻显示所有余额——DeepSeek 账号，以及在 Host 上读取的 OpenRouter、DeepSeek API、OpenCode Go key。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-balance

[English](README.md) | 中文

## 概述

不用打开设置或各家控制台，就能看到每条模型线路还剩多少。这个小块位于输入框下方，排在活动和用量读数之后，每个来源一段并带名称：`DeepSeek ¥12.34 · OpenRouter $7.50 · OpenCode Go 34%`。鼠标悬停逐段说明并给出读取时间。用完的那段变红，读不到的变淡；点击它、窗口重新获得焦点、以及页面可见时每两分钟，都会刷新。

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

把下面这一行挂在 Web bundles 旁边；lsy event bundle 已经挂载了它。Host 需要提供 `account` Remote（`@deepseek-ai/dsh-api-account-controller` 加一个 DeepSeek 账号 provider），以及 `credentials` 和 `connection` 服务，Web bundles 已经组合好了。

```yaml
- id: lsy-balance
  name: '@deepseek-ai/dsh-lsy-balance'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sources` | OpenRouter（`OPENROUTER_API_KEY`）、DeepSeek API（`DEEPSEEK_API_KEY`）、OpenCode Go（`OPENCODE_GO_API_KEY`） | 要读取的 key：`kind`（`openrouter`、`deepseek`、`opencode-go`）、`keyRef`（凭据引用，即模型页的 `apiKeyEnv`）和 `label`。key 没设置的来源会跳过 |
| `cacheMs` | `60000` | Host 用缓存回答的时长；点击可绕过缓存，但最多每 10 秒一次 |
| `timeoutMs` | `15000` | 一次供应商请求的时限 |

DeepSeek 账号显示充值加赠金；OpenRouter key 显示其限额内的剩余；DeepSeek API key 显示钱包余额；OpenCode Go 显示用得最多的那档配额。金额显示规则与账号设置页一致：保留两位小数并向下取整，不足一分显示 `<¥0.01`。DeepSeek API 的读数与已登录账号相同时只显示一次。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 部分在 connection 上注册 `GET /api/lsy.balance`，因此受 `/api` 的登录校验保护。对每个配置的来源，它通过 `credentials.resolve()` 取出 key，只发给该供应商自己的接口（`openrouter.ai/api/v1/key`、`api.deepseek.com/user/balance`、`opencode.ai/inference/go/v1/usage`），回答里不含 key；失败原因是 `HTTP 401` 这样的固定短语，不会带响应内容。回答缓存 `cacheMs`，进行中的请求共享；缺少的 key 只记一次日志。

浏览器部分通过 `ctx.slots.inject` 注册一个 `conversation.composer.dock` 条目（`id: balance`，`order: 2`，排在 ui-chat 的 `activity` 和 `usage` 之后），因此跟随该插槽声明的生命周期。所有打开的输入框共用一个 store 和一个 `BalanceLoader`。每一轮调用 `account.getBalance`（带上与账号设置页相同的客户端标识），并请求相对于文档的 `api/lsy.balance`（点击时加 `?fresh=1`）；进行中的一轮会被共享；如果上一次结果还在调用方接受的时效内就跳过：挂载和定时器接受两分钟，窗口回到前台接受三十秒，点击则总是查询。账号返回 `null` 表示未登录；账号读取失败时保留上一次成功的钱包，路由失败时保留上一次的读数。账号金额是十进制字符串，用 `big.js` 求和，不经过浮点数。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 部分：配置、带缓存的 `/api/lsy.balance` 路由 |
| [`src/sources.ts`](src/sources.ts) | 各供应商的查询与响应解析 |
| [`src/readings.ts`](src/readings.ts) | 两部分共用的读数类型与路由路径 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、基于账号 Remote 和路由的 loader、插槽注册 |
| [`src/client/balance.ts`](src/client/balance.ts) | 钱包汇总、金额格式化、store 工厂、loader |
| [`src/client/segments.ts`](src/client/segments.ts) | 由 store 状态得出各段与悬停提示 |
| [`src/client/BalancePill.tsx`](src/client/BalancePill.tsx) | 余额小块与刷新时机 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [账号设置](../../client/ui-settings-account/README.zh.md)——与这个小块共用余额查询的设置页
- [开放平台账号 provider](../../credentials/deepseek-account-platform/README.zh.md)——Host 读取钱包的地方

-----

<a id="model-experience"></a>
## 模型体验

无，这个小块属于浏览器界面，不会进入任何模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **OpenRouter 显示的是 key，不是账户**——`/api/v1/key` 给出的是这个 key 自身限额内的剩余；没设限额的 key 显示已用金额，因为账户余额需要管理用 key 才能查。
- **只支持三家**——模型页上的其他 key 在 `sources.ts` 加上它们的接口之前不显示。
- **轮询而非推送**——消费会在下一次刷新时体现：页面可见时最多两分钟（含 Host 一分钟缓存），点击则立即刷新。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 每轮结束时刷新能比定时器更早反映消费；这需要一个插槽条目不必深入 ui-chat 就能观察到的 Session 事件。

</details>
