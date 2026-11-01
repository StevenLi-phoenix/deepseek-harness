---
description: "任何设置分区都能嵌入的“全部设置”卡片：列出一个或多个插件条目的每个 Config 字段及其生效层，先暂存改动，复核后一次写入主人的补丁，并等插件重新载入完成。"
kind: "package-reference"
---

# @deepseek-ai/dsh-lsy-config

[English](README.md) | 中文

## 概述

在已经显示某个插件的页面上改它的任何设置，不用再 SSH 去编辑补丁文件。**全部设置**卡片列出插件条目的每个配置字段，按 schema 的嵌套分组，每个字段显示生效的值和设置它的那一层：默认值、内置配置、你自己的补丁或 home 补丁。改动先暂存；**保存**先复核，**确认保存**才对你自己的补丁写入一次并重新载入插件。home 补丁设置的字段只读，凭据只显示是否已设置。

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

把这一行挂在 Web bundle 旁边；lsy 事件 bundle 已挂载它。它需要设置外壳，以及 Host 上的 `connection` 服务和该 profile 的配置编辑器，Web bundle 都已组合。这个包没有配置项。

```yaml
- id: lsy-config
  name: '@deepseek-ai/dsh-lsy-config'
```

### 把卡片放进设置分区

卡片是 Component Factory `settings.plugin-config`。分区用它负责的插件条目 id（profile 补丁里的 `id`）渲染，放在页面末尾：

```tsx
// Type-only: declares the 'settings.plugin-config' factory.
import type {} from '@deepseek-ai/dsh-lsy-config/client'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'

// The section's props gain the factory renderer (optional, so a test without it still renders):
export type MySectionProps = /* … */ & Partial<PropsRenderFactories>

// In the section's JSX, last child:
{renderFactorySlot?.('settings.plugin-config', { entries: ['lsy-qq', 'lsy-qq-login'] })}
```

属性：

| 属性 | 含义 |
|---|---|
| `entries` | `readonly string[]`，一到十六个条目 id |
| `exclude` | 可选的点分字段路径（`groups`、`media.images`；写分组表示排除它下面的所有字段），卡片既不显示也不写入，用于同一页面上有专门编辑器的字段 |
| `reloadWarning` | 可选的已本地化文字，在会重新载入插件的保存的复核步骤里显示 |

把这个包加进分区包的 `devDependencies`（`"@deepseek-ai/dsh-lsy-config": "workspace:*"`），并在它的 `tsconfig.client.json` 里引用 `../lsy-config/tsconfig.client.json`。这个导入只有类型，浏览器 bundle 因此保持独立。没有加载这个包时调用什么也不渲染；Host 没有运行的 id（或插件没有字段）也什么都不显示，所以分区可以写上只有部分部署才组合的条目。

有专门编辑器负责部分字段的分区传入 `exclude`，例如 QQ 页面：

```tsx
{renderFactorySlot?.('settings.plugin-config', {
  entries: ['lsy-qq'],
  exclude: ['groups'],
  reloadWarning: t('config.reloadWarning'),
})}
```

卡片保存时，被排除的字段保持它此刻的存储值；卡片读取之后专门编辑器改了这些字段，也不会让卡片的保存过期（修订号不计入被排除的字段）。改了其他任何字段则仍会过期。卡片和上游设置表单都通过 `ctx.configEditor.edit` 写入，它一次只执行一个写入，且两边都用修订号把关，所以对方改过条目之后才写的那一方会被拒绝并重新读取，而不是覆盖。

### 卡片显示什么

每个条目是一个可折叠的块，带字段数和你的补丁改了几项。里面 schema 的嵌套对象是可折叠的分组（其中有字段被改过时默认展开）。每个字段行显示：

| 部分 | 含义 |
|---|---|
| 标签 | 字段名；完整路径在提示里 |
| 层标签 | **默认值**：没有哪一层设置，用 schema 默认值。**内置配置**：插件 bundle 设置。**我的补丁**：你自己的补丁把它设得和 bundle 不同。**home 补丁**：home 补丁设置了整个条目 |
| **恢复默认** | 只出现在你的补丁改过的字段上：暂存一次退回，回到 bundle 的值（bundle 没设置时回到默认值） |
| 控件 | 按字段类型是文本框、数字框、开关、选择列表、每行一项的列表或 JSON 框 |
| 说明 | schema 有描述时显示描述，另有默认值，以及字段为何只读 |

保存会把条目的整份 config 在你的补丁里重新写一遍，因为补丁条目的 `config` 会替换 bundle 的整份 config；只有你改过的字段和显示的内容不同。当每个字段都回到 bundle 的值，你的补丁里的这个条目就被移除。

只读字段：home 补丁设置的条目（请改 home 补丁）、由 `!!js` 表达式给出的字段（在补丁文件里改），以及凭据字段（`role('secret')`）。`tokenEnv` 这样的凭据引用只是变量名，所以可以编辑，卡片也从不读取变量的值。

### 保存

1. 编辑字段。此时什么都没写，也不会自行保存：输入时不会，离开字段时不会，等待也不会。字段不接受的值会被标出，并让**保存**不可用。
2. **保存**列出每一项改动（`字段：旧值 → 新值`），并说明哪个插件会重新载入；保存会重新载入插件时，随后是分区传入的 `reloadWarning`。
3. **确认保存**把所有改动一次发出。表单显示**正在重新载入…**，直到新的插件实例用保存后的修订号应答，期间保留原来显示的内容，然后显示**已保存**。如果插件约 30 秒内没有应答，表单会说明并提供**重试**。
4. schema 标为 `volatile` 的字段对运行中的插件无需重新载入即可生效；复核步骤会这样说明，只改这类字段的保存既不显示警告，也不等待重新载入。
5. 被拒绝时会说明原因：读表单之后配置变了（会重新读取）、home 补丁设置了这个条目，或插件拒绝了这些值。这些情况都不会写入。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

**为什么不用上游的设置表单。** 上游的插件设置接口（`settings.describe` 与 `mutate`，位于 `ctx.configForms` 之后）只提供 schema 标为 `volatile` 的字段，因为这些字段无需重新挂载插件就能生效。插件只标了部分字段（`lsy-qq` 标了记录的群和大部分限额，没有标连接、发送、摘要和登录设置），其余的够不到。这个包读取完整的 schema，并通过上游使用的同一条保存路径 `ctx.configEditor.edit` 写入：它按 schema 校验下一份 config，原子地写入主人的补丁，并重新载入插件。表单外壳复用 `ui-primitives` 的共享控件（`SettingsForm`、`Switch`、`Tag`）。

**Host 一半。** `GET /api/lsy.config?entries=a,b&exclude=x,y.z` 对每个在运行的条目回答一棵树，它由条目的 Config schema 与已存各层构成（`src/fields.ts`）：嵌套对象成为分组，叶子的类型是 `string`、`credential-ref`、`number`、`boolean`、`select`、`string-list`、`json`（其他形状）或 `secret`。叶子带着生效的值、schema 默认值、设置它的那一层，以及你的补丁改过它时 bundle 的值。层由生效 config 与仅 bundle 层给出的 config（`ctx.configEditor.configuration()`）比较得出；当生效 config 既不等于你的补丁、也不等于 bundle 时，判定为 home 补丁设置。凭据叶子只带 `set`。`POST /api/lsy.config` 接收 `{ id, revision, ops, exclude }`，ops 有 `set`、`unset`（退回 bundle 的值）和 `clear`（移除字段，让 schema 默认值生效）。它检查 `revision`（生效 config 与 bundle config 的哈希，不含被排除的字段），把 ops 应用到生效的 config 上（`src/edit.ts`），拒绝凭据字段、被排除的字段、未知路径、分组以及 `!!js` 表达式之下的字段，再把结果交给 `configEditor.edit`。什么都没变的保存不写入也不重新载入；每个改动的字段都是 `volatile` 时，应答带 `reload: false`：Loader 把这些改动应用到运行中的插件，插件不会被重新应用。两条路由都在 `/api` 下，由连接的登录检查把关。

**日志。** 每次保存都记录 `lsy-config: saved <条目> changed=[路径] reload=<bool> outcome=ok in <毫秒>ms`，被拒绝时记录 `save of <条目> edits=[路径] outcome=<原因> in <毫秒>ms`。只记录条目 id 和字段路径，不记录值。浏览器把同样的事实写进控制台。

**浏览器一半。** 这个包用 `ctx.slots.registerFactory` 注册该 factory，任何分区通过 `renderFactorySlot` 加一次仅类型导入就能用到它；这满足客户端 bundle 纯度检查，包不存在时分区也不受影响。`ConfigLoader`（`src/client/store.ts`）保存每个条目最近一次的描述和阶段（`loading`、`ready`、`saving`、`reloading`、`unreachable`），保存后不断读取该条目，直到插件用保存后的修订号应答。Host 重新载入时应答可能丢失，此时修订号变了就算保存成功。`src/client/model.ts` 用纯函数处理草稿、解析和复核行。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | Host 一半：`/api/lsy.config` 路由、请求检查、日志 |
| [`src/fields.ts`](src/fields.ts) | 从 Config schema 与已存各层生成表单树 |
| [`src/edit.ts`](src/edit.ts) | 把一次保存的改动变成下一份已存 config；修订号 |
| [`src/view.ts`](src/view.ts) | 两半共用的路由、表单与保存类型 |
| [`src/client/index.ts`](src/client/index.ts) | 浏览器入口：词典、loader、factory 注册 |
| [`src/client/slot-contract.ts`](src/client/slot-contract.ts) | `settings.plugin-config` factory 的声明 |
| [`src/client/store.ts`](src/client/store.ts) | store 与 loader：读取、保存、等待重新载入 |
| [`src/client/model.ts`](src/client/model.ts) | 草稿、解析，以及保存的计划与复核 |
| [`src/client/PluginConfigCard.tsx`](src/client/PluginConfigCard.tsx) | 卡片 |

这是 fork 本地的包；它改动的上游文件列在 [`../UPSTREAM.md`](../UPSTREAM.md)。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [设置域](../../client/ui-settings/README.zh.md) — 设置外壳，以及上游针对 `volatile` 字段的插件设置表单
- [Slots](../../client/ui-slots/README.zh.md) — Component Factory，分区用它接入这张卡片
- [配置编辑器](../../boot/config-editor/README.zh.md) — 保存路径及其补丁分层
- [lsy-sysmon](../lsy-sysmon/README.zh.md) 与 [bili](../bili/README.zh.md) — 嵌入这张卡片的分区

-----

<a id="model-experience"></a>
## 模型体验

无，因为卡片是配置之上的浏览器界面；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；这个包既不组装也不发送提供方请求。保存插件配置会重新载入该插件，这可能改变之后请求的内容，但卡片本身不会往请求里加任何东西。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **补丁条目会替换 bundle 的 config** — 一个条目第一次保存时，会把 bundle 当前的值复制进你的补丁，所以之后 bundle 默认值的变化不会到达这个条目，直到把每个字段都恢复为 bundle 的值（这会移除你的条目）。
- **这里不编辑凭据** — `role('secret')` 字段留在 `.env` 或凭据存储里。bundle 里字面写下的密钥会被第一次保存复制进你的补丁，因为 config 是整份重写的。
- **只有 schema 带描述的字段才有说明** — 字段显示 schema 的 `description`；schema 没有描述的插件只显示字段名和默认值。
- **其他形状按 JSON 编辑** — 映射、元组、不同类型的联合以及对象列表都按 JSON 文本编辑。
- **嵌套 include 里的条目**配置编辑器无法定位，什么都不显示。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- `lsy-qq` 表单夹具（`tests/qq-form.client.ts`）是生成的：改动那份 schema 之后运行 `UPDATE_QQ_FORM=1 pnpm exec vitest run packages/lsy/lsy-config/tests/schemas.spec.ts`，再运行 `pnpm exec tsx scripts/run-oxlint.ts --fix packages/lsy/lsy-config`。
- 若要只还原“我的补丁”中的某些值而不重写 bundle 的内容，需要上游改动 loader；保存之所以整份重写，是因为补丁条目会替换整份 config。

</details>
