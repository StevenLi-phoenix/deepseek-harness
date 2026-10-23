---
description: "账号设置页里的卡片，列出 Host 持有的每个供应商 key 的余额或配额（OpenRouter、DeepSeek API、OpenCode Go），位于 DeepSeek 账号卡片下方；key 从不离开 Host。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-balance

[English](README.md) | 中文

## 概述

在 DeepSeek 账号余额所在的页面，同时看到每条模型线路还剩多少。在**设置 → 账号与余额**的账号卡片下方，一张卡片列出 Host 持有的每个供应商 key：OpenRouter key 在限额内的剩余、DeepSeek API key 的钱包、OpenCode Go 各档配额（用进度条表示）。用完的线路变红；读不到的会说明原因。卡片在打开页面和点击“刷新”时读取。

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

把下面这一行挂在 Web bundles 旁边；lsy event bundle 已经挂载了它。它需要账号设置页（`@deepseek-ai/dsh-client-ui-settings-account`，声明了 `settings.account.balances` 区域），Host 上还需要 `account` Remote 以及 `credentials` 和 `connection` 服务，Web bundles 都已组合好。

```yaml
- id: lsy-balance
  name: '@deepseek-ai/dsh-lsy-balance'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sources` | OpenRouter（`OPENROUTER_API_KEY`）、DeepSeek API（`DEEPSEEK_API_KEY`）、OpenCode Go（`OPENCODE_GO_API_KEY`） | 要读取的 key：`kind`（`openrouter`、`deepseek`、`opencode-go`）、`keyRef`（凭据引用，即模型页的 `apiKeyEnv`）和 `label`。key 没设置的来源会跳过 |
| `cacheMs` | `60000` | Host 用缓存回答的时长；“刷新”可绕过缓存，但最多每 10 秒一次 |
| `timeoutMs` | `15000` | 一次供应商请求的时限 |

金额显示规则与账号页一致：保留两位小数并向下取整，不足一分显示 `<¥0.01`。DeepSeek API key 的有余额金额与已登录账号相同时不再列出，因为上方账号卡片已经显示。没有配置任何 key 时卡片不渲染。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 部分在 connection 上注册 `GET /api/lsy.balance`，因此受 `/api` 的登录校验保护。对每个配置的来源，它通过 `credentials.resolve()` 取出 key，只发给该供应商自己的接口（`openrouter.ai/api/v1/key`、`api.deepseek.com/user/balance`、`opencode.ai/inference/go/v1/usage`），回答里不含 key；失败原因是 `HTTP 401` 这样的固定短语，不会带响应内容。回答缓存 `cacheMs`，进行中的请求共享；缺少的 key 只记一次日志。

浏览器部分通过 `ctx.slots.inject` 在账号页的 `settings.account.balances` 区域注册一个条目（`lsy-provider-balances`），因此跟随该声明的生命周期。它由一个 store 和一个 `BalanceLoader` 支撑。每一轮请求相对于文档的 `api/lsy.balance`（点击“刷新”时加 `?fresh=1`），并带上账号页的客户端标识调用 `account.getBalance`，仅用于识别同一账号的 DeepSeek API key；进行中的一轮会被共享，打开页面时接受 30 秒内的读数。路由失败时保留上一次的读数。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 部分：配置、带缓存的 `/api/lsy.balance` 路由 |
| [`src/sources.ts`](src/sources.ts) | 各供应商的查询与响应解析 |
| [`src/readings.ts`](src/readings.ts) | 两部分共用的读数类型与路由路径 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、loader、账号页注册 |
| [`src/client/balance.ts`](src/client/balance.ts) | 钱包汇总、金额格式化、store 工厂、loader |
| [`src/client/rows.ts`](src/client/rows.ts) | 由 store 状态得出卡片各行与更新时间 |
| [`src/client/ProviderBalances.tsx`](src/client/ProviderBalances.tsx) | 卡片 |

这是 fork 本地包；见 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [账号设置](../../client/ui-settings-account/README.zh.md)——这张卡片所在的页面与 `settings.account.balances` 区域
- [开放平台账号 provider](../../credentials/deepseek-account-platform/README.zh.md)——Host 读取账号钱包的地方

-----

<a id="model-experience"></a>
## 模型体验

无，这张卡片属于浏览器界面，不会进入任何模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送 provider 请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **OpenRouter 显示的是 key，不是账户**——`/api/v1/key` 给出的是这个 key 自身限额内的剩余；没设限额的 key 显示已用金额，因为账户余额需要管理用 key 才能查。
- **只支持三家**——模型页上的其他 key 在 `sources.ts` 加上它们的接口之前不显示。
- **按需读取**——卡片在打开页面和点击“刷新”时读取，Host 最多缓存一分钟。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 早期版本是输入框下方统计栏里的小块；owner 把它挪到了账号页，余额本该在那里。

</details>
