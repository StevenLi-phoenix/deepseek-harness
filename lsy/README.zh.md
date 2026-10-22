# lsy — 事件驱动的 agent 服务（fork 本地）

[English](README.md) | 中文

把这个 fork 作为常开、事件驱动的 agent 服务跑在 Mac mini 上的部署文件：主人在微信里和 agent 对话，agent 自己建监控和提醒，传感器轮询 GitHub，总线判断什么重要，再交给一次无人值守的 agent 运行或一条微信消息处理。代码在 [`packages/lsy/`](../packages/lsy/README.zh.md)；这个目录放 profile、服务定义和运维手册。

## 目录结构

| 路径 | 内容 |
|---|---|
| [`CHANGELOG.md`](CHANGELOG.md) | fork 本地变更（Keep a Changelog） |
| [`bundles/event/`](bundles/event/) | `@deepseek-ai/dsh-lsy-event-bundle`：以 bundle 层形式提供的事件组合配置（归代码所有；路由状态存在存储里，由 agent 的工具管理） |
| [`profiles/event/`](profiles/event/) | 事件 profile：`package.json`（Web bundle 加事件 bundle）与 `cordis.patch.yml`，即主人自己的空 patch 层，Web 设置页写入这里 |
| [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md) | Mac mini 上的隔离部署：`dsh-runtime` 用户、LaunchDaemon、密钥、微信绑定、验证 |
| [`deploy/`](deploy/) | `install-app.sh`、`setup-profile.sh`（软链插件和 bundle，只在首次创建主人层）、`check-setup-profile.sh`、`upgrade.sh`、`wechat-login.mjs`、`home.cordis.patch.yml`、LaunchDaemon 模板 |
| [`../packages/lsy/UPSTREAM.md`](../packages/lsy/UPSTREAM.md) | 上游基线、复制的包、改动过的上游文件、升级流程 |

## lsy 组的检查

```sh
pnpm exec vitest run packages/lsy
pnpm exec vitest run packages/lsy --coverage --coverage.include='packages/lsy/*/src/**/*.ts'
pnpm exec tsc -b packages/lsy/lsy-event-bus packages/lsy/lsy-github-sensor packages/lsy/lsy-tool-watch packages/lsy/lsy-wechat packages/lsy/lsy-balance
pnpm exec tsc -p tsconfig.host.json --noEmit   # also type-checks tests
pnpm exec tsx scripts/run-oxlint.ts packages/lsy lsy/deploy
pnpm run constraints && pnpm run verify-product-use && pnpm run verify-tsconfig-paths
pnpm run verify-translation-pairing packages/lsy/README.md packages/lsy/*/README.md lsy/README.md docs/subsystems/lsy.md
pnpm run verify-package-readme-model-experience && pnpm run verify-package-readme-summaries
pnpm run verify-config-catalog && pnpm run verify-cordis-catalog && pnpm run verify-md-links
```

## 从源码运行事件 profile

```sh
export DSH_HOME=/path/to/test-home            # never the live ~/.dsh
mkdir -p "$DSH_HOME/profiles/event/node_modules/@deepseek-ai"
cp lsy/profiles/event/package.json lsy/profiles/event/cordis.patch.yml "$DSH_HOME/profiles/event/"
ln -s "$PWD/lsy/bundles/event" "$DSH_HOME/profiles/event/node_modules/@deepseek-ai/dsh-lsy-event-bundle"
pnpm dsh event --dump-config | less            # composed tree, with the layer that set each row
pnpm dsh event --port 3092 --no-open           # Web UI + sensors + bus + WeChat channel
```

没有 `$DSH_HOME/lsy-wechat/account.json` 时，微信通道处于空闲状态并把通知排队。监控由使用 `unattended` preset 的 Session 创建（`watch_create`）；做实验时仍可以用 `$DSH_HOME/cordis.patch.yml` 覆盖任意一行。
