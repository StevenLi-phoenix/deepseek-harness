---
description: "求职预设的受限仓库、进度表、问题单和求职信工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-job-apply

[English](README.md) | 中文

## 概述

求职预设用固定操作替代通用命令行和文件工具。事件配置将此包挂载为 `apply`、`inbox` 或 `lead` 模式。

## 目录

- [使用这个包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

## 使用这个包

<a id="use-this-package"></a>

将此包挂载在预设内，而不是宿主根作用域。将 `root` 设为部署维护的正规求职仓库路径；`lead` 还接受一个已存在的可信 `job-apply-batch.md` 路径 `batchRunbook`。固定的进度表客户端从宿主读取 `JOBTRACKER_PAT`，Git 和 GitHub 沿用宿主凭证；不要把凭证放进仓库。

<a id="model-experience"></a>
## 模型体验

### 求职工具

#### 模型看到什么

模型使用 `job_repo` 读写限定文件并执行固定的 Git 操作，`job_log` 追加单行日志，`jobtracker` 操作限定的行，`job_issue` 管理工作流问题单，`skill` 读取该预设唯一的流程参考。`apply` 增加 `job_cover_convert`（Markdown 转 DOCX）；只有 `lead` 可以读写配置中的批处理手册。仓库、外部服务或问题单的内容都是数据，无权改变权限。工具定义只加载到这三个预设，不影响其他请求。用 `job_repo` 的 `append` 在文件末尾追加完整行，或用 `replace` 替换唯一的原文匹配，不必把整份文件传回工具。原文不存在或出现多次时，`replace` 不改动文件。每段输入最多 64 KiB，局部编辑支持最多 1 MiB 的文件。简历文本只读。

#### Token 影响

六个工具的描述约 2,500 字符；加上参数 schema，三个求职 preset 下的 Agent 每次请求的固定开销约 1,000–1,500 token。其他 preset 下的 Agent 不付出代价。

#### KV Cache 影响

工具定义和可见性不变时前缀稳定；挂载或卸载可能让复用从第一个变化的 schema token 起失效。

### 求职工具结果

#### 模型看到什么

`jobtracker` 按进度表 API 的要求写字段：新增行带 `location` 和 `source`，已投递的行带 `date_applied`；没填完的表单保持 `queued` 并记 `step`。`list` 带 `company`、`role` 或 `url` 时在所有状态里查找，忽略大小写和标点；不带时只列一种状态，最新的在前。最多显示 40 行，匹配不超过 5 行才给完整备注，所以按公司和岗位查到的那一行带着更新时要保留的备注。`job_issue` 的 `view` 返回一个问题单和最近 20 条评论，主人在评论里回答问题和批准。`job_repo` 的 `pull` 用 autostash 把本地提交变基到 `origin/main` 上，变基冲突时中止，因为一轮投递持有本地提交时其他设备也在推送。

#### Token 影响

`jobtracker` 的列表最多 40 行，`job_issue` 的 `view` 最多 20 条评论，模型交给 `job_repo` 的每段文本最多 64 KiB。

#### KV Cache 影响

只追加；每个结果接在可复用的请求前缀之后，不会让已有的 KV Cache 条目失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **不是信息流策略**——限定的仓库和进度表写入发往固定目的地，这些目的地仍须仅对主人开放。
- **上传文件名属于浏览器配置**——如已安装的简历和成绩单文件名不同，请通过私有部署补丁设置。
- **只生成 DOCX**——求职信转换只生成 DOCX，但指定目录中已有的 PDF 仍可上传。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：尚未决定的探索方向与维护者备注。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

- 三个求职 preset 各挂载这个包一次，由 `mode` 选择工具组合；新的求职流程在这里加一个 mode，而不是新建一个包。

</details>
