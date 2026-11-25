# fork — 事件驱动的 agent 服务（fork 本地）

[English](README.md) | 中文

把这个 fork 作为常开、事件驱动的 agent 服务跑在 Mac mini 上的部署文件：主人在微信里和 agent 对话，agent 自己建监控和提醒，传感器轮询 GitHub，总线判断什么重要，再交给一次无人值守的 agent 运行或一条微信消息处理。代码在 [`packages/fork/`](../packages/fork/README.zh.md)；这个目录放 profile、服务定义和运维手册。

## 目录结构

| 路径 | 内容 |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | fork 本地变更（Keep a Changelog） |
| [`bundles/event/`](bundles/event/) | `@deepseek-ai/dsh-event-bundle`：以 bundle 层形式提供的事件服务骨架（webhook 运行时、owner relay、事件总线与其订阅、ingest、控制台和设置页的行，以及 `notify` 和 `unattended` 两个 preset；路由状态存在存储里，由 agent 的工具管理）。每个功能都是它旁边的独立 bundle，排在它之后挂载：`github`、`headless-browser`、`provider-balance`、`subagent-activity`、`sysmon`、`memory`、`presence`、`wechat`、`cc-admin`、`voice`、`bili`、`qq`、`courses`、`gmail`、`qqbot`、`integrity`、`guard`、`style`（挂载顺序见 [`bundles/event/README.md`](bundles/event/README.zh.md)） |
| [`profiles/event/`](profiles/event/) | 事件 profile：`package.json`（Web bundle、骨架，然后按挂载顺序每个功能一个 bundle）与 `cordis.patch.yml`，即主人自己的空 patch 层，Web 设置页写入这里 |
| [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) | Mac mini 上的隔离部署：`dsh-runtime` 用户、LaunchDaemon、密钥、微信绑定、验证 |
| [`deploy/`](deploy/) | `install-app.sh`、`setup-profile.sh`（软链插件和每个 fork bundle，只在首次创建主人层）、`check-setup-profile.sh <installed prefix>`（检查全新、迁移过和重复运行的 home；`upgrade.sh` 在切换 `current` 前运行它）、`upgrade.sh`、`wechat-login.mjs`、`home.cordis.patch.yml`、LaunchDaemon 模板 |
| [`../packages/fork/UPSTREAM.md`](../packages/fork/UPSTREAM.md) | 上游基线、复制的包、改动过的上游文件、升级流程 |

## fork 组的检查

```sh
node fork/deploy/check-owner-names.mjs
pnpm exec vitest run packages/fork
pnpm exec vitest run packages/fork --coverage --coverage.include='packages/fork/*/src/**/*.ts'
pnpm exec tsc -b packages/fork/cc-bridge packages/fork/event-bus packages/fork/github-sensor packages/fork/tool-watch packages/fork/wechat packages/fork/qq packages/fork/qqbot packages/fork/tool-qq packages/fork/speaking-style packages/fork/content-guard packages/fork/provider-balance packages/fork/bili packages/fork/tool-bili
pnpm exec tsc -p tsconfig.host.json --noEmit   # also type-checks tests
pnpm exec tsx scripts/run-oxlint.ts packages/fork fork/deploy
pnpm run constraints && pnpm run verify-product-use && pnpm run verify-tsconfig-paths
pnpm run verify-translation-pairing packages/fork/README.md packages/fork/*/README.md fork/README.md docs/subsystems/fork.md
pnpm run verify-package-readme-model-experience && pnpm run verify-package-readme-summaries
pnpm run verify-config-catalog && pnpm run verify-cordis-catalog && pnpm run verify-md-links
```

`tsconfig.host.json` 不包含 `*.client.spec.*` 测试；它们在 Client 聚合 `tsconfig.client.json` 里做类型检查。

在 GitHub 上，[`.github/workflows/fork-ci.yml`](../.github/workflows/fork-ci.yml) 在每次推送 `main` 时用托管 runner 跑 `ci.yml` 的 pull request 门禁：静态门禁、typecheck 与 lint、分四片的覆盖率（每个文件 100%）和构建。正在跑的一轮不会被取消；失败的一轮经 `ci` 路由告诉主人。仓库设置里停用了 `CI master` workflow（`gh workflow enable "CI master"` 可重新启用）：它的推送 job 要等上游的自托管 runner 和 secret。

## 从源码运行事件 profile

```sh
export DSH_HOME=/path/to/test-home            # never the live ~/.dsh
fork/deploy/setup-profile.sh "$DSH_HOME" "$PWD" # links the plugins and all 19 fork bundles
pnpm dsh event --dump-config | less            # composed tree, with the layer that set each row
pnpm dsh event --port 3092 --no-open           # Web UI + sensors + bus + WeChat channel
```

没有 `$DSH_HOME/wechat/account.json` 时，微信通道处于空闲状态并把通知排队。监控由使用 `unattended` preset 的 Session 创建（`watch_create`）；做实验时仍可以用 `$DSH_HOME/cordis.patch.yml` 覆盖任意一行。
