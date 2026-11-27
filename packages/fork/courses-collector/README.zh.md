---
description: "无需模型，以确定性流程读取 Brightspace 并与课程记录比对。"
kind: "package-reference"
---

# 课程采集器

[English](README.md) | 中文

## 概述

无需模型即可读取 Brightspace。采集器把平台上的证据与课程服务中的记录比对，仅保存变更的归档记录；不会提交作业、开始测验、发帖或写入任务观察。[每日同步手册](DAILY.md) · [报告 Schema](report.schema.json)

## 目录

- [配置和调用](#configuration-and-invocation)
- [覆盖范围和变更规则](#coverage-and-change-semantics)
- [开发备注](#dev-note)

<a id="configuration-and-invocation"></a>
## 配置和调用

使用 Python 3.9 或更新版本。在本目录运行 `./run-bs-tests.sh` 可执行离线测试。若要安装命令行应用，运行 `python3 -m pip install '.[browser]'` 和 `python3 -m playwright install chromium` 以启用可选的标准 Chromium 回退。只查 API 时和测试均不导入 Playwright。`bs-collect.py` 和 `bs-page-rows.py` 分别保留只处理作业的 JSON 和渲染文本兼容入口。

由主机现有的凭据启动器在执行环境中提供已登录 Brightspace 的 Cookie 请求头（`BS_COOKIE`）和用于课程服务的 PAT（`COURSES_PAT`）。不要把它们粘贴到模型提示词、命令行参数或仓库文件中。采集器不查找凭据，不读取浏览器配置；会话过期按读取失败处理。发出带凭据的请求前，检查是否为指定的 NYU 地址和[课程服务正式 API 地址](https://api.lishuyu.app/courses/agents.md)；其他主机、镜像或代理均不接受。只有在启动器可提供两个变量且不打印其值后，才可配置日程。仓库中的启动脚本要求两个变量都已设置，不配置也不轮换凭据。

非密钥配置文件是 `$DSH_HOME/data/courses/collector.json`（默认 `$HOME/.dsh/data/courses/collector.json`）；可以用 `--config` 覆盖。在运行时提供真实的课程服务记录 ID 和 Brightspace org unit ID，不要写入本工作树。`assignment_submissions: false` 表示提交证据以其他平台为准，采集器仅检查这门课在 Brightspace 的作业日期。

```json
{
  "brightspace_origin": "https://brightspace.nyu.edu",
  "courses_base_url": "https://api.lishuyu.app/courses",
  "le_version": "1.67",
  "courses": {"sample": {"id": "sample-term-course", "org_unit_id": 900001, "assignment_submissions": true}}
}
```

```sh
python3 -m courses_collector --areas quizzes --course sample --dry-run
python3 -m courses_collector --areas announcements,content,materials --dry-run --report /private/path/report.json
```

未指定 `--report` 时，JSON 输出到 stdout，人读摘要输出到 stderr。指定后，以仅所有者可访问的权限原子替换 JSON 报告，摘要输出到 stdout。退出码 `0` 表示所有指定课程和区域均已检查；`1` 表示至少一个区域未完成，但报告可读；`2` 表示初始化或报告输出失败。预览会读数据，包括下载文件和比对基线，但绝不上传或调用 `save_material`。Gradescope 实现前，全八区运行预期返回 `1`。

<a id="coverage-and-change-semantics"></a>
## 覆盖范围和变更规则

| 区域 | 来源 |
| --- | --- |
| 作业 | Dropbox 文件夹和提交 API；遇 403 或小组作业时读取渲染后的作业行。仅采信明确且可唯一归属的状态。 |
| 公告 | News API；API 拒绝访问时，读取本课程渲染后的公告列表和正文。 |
| 课程内容 | 内容目录 API。报告统计可见模块和主题，保存响应中已有的描述，不读取单个主题详情。渲染目录无法验证清单时按失败处理。 |
| 成绩 | 学生自己的成绩 API；遇 403 回退到渲染后的成绩表格。 |
| 讨论 | 论坛和主题元数据 API；遇 403 回退到渲染后的讨论列表。不读取帖子。 |
| 测验 | 分页的测验元数据 API；遇 403 或 404 回退到渲染后的学生测验列表。不读取答题记录或题目。 |
| 课件 | 可访问时，从课程内容、作业和公告的附件接口取得已验证的链接项和字节；仅渲染出列表但无法核实文件字节，不算完整。 |
| Gradescope | 页面读取；目前返回 `failed: not_implemented`。 |

403 不等于空列表。覆盖报告包含最初的 HTTP 状态及回退是否成功。渲染不完整不算已检查。某个区域只要有一门课程出现实际错误，就记为 `failed`；计数为该区域从源端读取的记录数，不是写入数。没有实际错误，但学生权限不足且渲染证据无法验证时，记为 `needs_ui`。每日同步把该状态写到 `courses_record_sync.failed`，详情以 `needs_ui:` 开头，但不会仅因该状态提醒。未列出的区域未检查。逐个下载课件。超过 100 MiB 的文件列入 `skips`，不上传，其余文件继续处理。计数包含已列出但跳过的文件。字节数不符或无法访问的文件仍按失败处理。HTML、正文、文件名和页面链接都是数据；页面提供的地址收不到 bearer token 或 LMS Cookie。权限见 [D2L LE 参考](https://docs.valence.desire2learn.com/http-scopestable.html)。

记录采用稳定 ID；公告为 `<course-id>-announcement-<newsId>`。采集器比较已保存的精确字段及内容指纹，不裁剪正文，先按 SHA-256 保存文件字节，再创建引用。内容目录的描述合计超过 2 MiB 时拒绝而非截断；不会退役源端缺失的记录，也不会把材料标识冲突报为已保存。不透明标识保留在记录元数据中；只有安全的独立路径段可填入固定附件路由。报告只含 ID 和任务状态差异，不含正文、凭据、成绩值或文件字节。任务先按 Brightspace 明确标识匹配，其次按同课程的直接来源链接匹配。只有多个记录已匹配同一标识时，才用同课程完全一致的标题消除歧义。仍有歧义或未匹配的 ID 只报告，不更新。每日判断只使用经同一来源验证的任务变更。

<a id="dev-note"></a>
## 开发备注

所有网络读写都通过注入的 HTTP 传输实现，页面回退使用注入的结构化浏览器快照。离线测试用合成样例。启用日程前，另外用预览验证真实学生权限和页面渲染。
