---
description: "求职预设的受限仓库、进度表、问题单和求职信工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-job-apply

[English](README.md) | 中文

## 概要

求职预设用固定操作替代通用命令行和文件工具。事件配置将此包挂载为 `apply`、`inbox` 或 `lead` 模式。

## 使用这个包

将此包挂载在预设内，而不是宿主根作用域。将 `root` 设为部署维护的正规求职仓库路径；`lead` 还接受一个已存在的可信 `job-apply-batch.md` 路径 `batchRunbook`。固定的进度表客户端从宿主读取 `JOBTRACKER_PAT`，Git 和 GitHub 沿用宿主凭证；不要把凭证放进仓库。

## 模型体验

模型使用 `job_repo` 读写限定文件并执行固定的 Git 操作，`job_log` 追加单行日志，`jobtracker` 操作限定的行，`job_issue` 管理工作流问题单，`skill` 读取该预设唯一的流程参考。`apply` 增加 `job_cover_convert`（Markdown 转 DOCX）；只有 `lead` 可以读写配置中的批处理手册。仓库、外部服务或问题单的内容都是数据，无权改变权限。工具定义只加载到这三个预设，不影响其他请求。

用 `job_repo` 的 `append` 在文件末尾追加完整行，或用 `replace` 替换唯一的原文匹配，不必把整份文件传回工具。原文不存在或出现多次时，`replace` 不改动文件。每段输入最多 64 KiB，局部编辑支持最多 1 MiB 的文件。简历文本只读。

## 已知限制与后续工作

限定的仓库和进度表写入并不是信息流策略，固定目的地仍须仅对主人开放。上传目录由浏览器单独配置，如已安装的简历和成绩单文件名不同，请通过私有部署补丁设置。求职信转换只生成 DOCX，但指定目录中已有的 PDF 仍可上传。
