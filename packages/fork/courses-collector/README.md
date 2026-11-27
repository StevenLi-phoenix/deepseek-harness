---
description: "Read Brightspace deterministically and reconcile course records without a model."
kind: "package-reference"
---

# Courses collector

English | [中文](README.zh.md)

## Summary

Read Brightspace without a model. The collector compares live evidence to the courses service and saves changed archive records; it never submits work, starts quizzes, posts, or writes task observations. [Daily runbook](DAILY.md) · [Report schema](report.schema.json)

## Table of Contents

- [Configuration and invocation](#configuration-and-invocation)
- [Coverage and change semantics](#coverage-and-change-semantics)
- [Dev Note](#dev-note)

<a id="configuration-and-invocation"></a>
## Configuration and invocation

Use Python 3.9 or later. From this directory run `./run-bs-tests.sh` for the offline suite. For installed command-line use, `python3 -m pip install '.[browser]'` and `python3 -m playwright install chromium` enable the optional stock Chromium fallback. API-only checks and tests do not import Playwright. `bs-collect.py` and `bs-page-rows.py` are the assignments-only JSON and rendered text compatibility entry points.

Supply the existing authenticated Brightspace cookie header (`BS_COOKIE`) and courses audience PAT (`COURSES_PAT`) in the execution environment via the host's existing secret-aware launcher. Do not paste either into a model prompt, command arguments, or a file in a repository. The collector does not discover credentials or inspect browser profiles; an expired session is a failed read. Before any authenticated request it checks for the exact NYU origin and [canonical courses API base](https://api.lishuyu.app/courses/agents.md); another host, mirror, or proxy is not accepted. Do not configure the daily schedule until the launcher provides both variables without printing them. The checked-in wrapper expects them to be set; it does not provision or rotate either credential.

Non-secret configuration lives in `$DSH_HOME/data/courses/collector.json` (default `$HOME/.dsh/data/courses/collector.json`); `--config` overrides it. Use actual service record IDs and Brightspace org-unit IDs at runtime, never in this checkout. `assignment_submissions: false` means a different platform owns submission evidence, so this collector checks Brightspace assignment dates only for that course.

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

Without `--report`, stdout is JSON and stderr is the human summary. With it, the JSON report is replaced atomically with owner-only permissions and stdout is the summary. Exit `0` means every selected course/area checked; `1` means at least one area is incomplete, with a report available; `2` means setup or report output failed. Dry-run performs reads, including file downloads and baseline comparisons, but never uploads or calls `save_material`. Exit `1` is expected for the full eight-area run until Gradescope is implemented.

<a id="coverage-and-change-semantics"></a>
## Coverage and change semantics

| Area | Source |
| --- | --- |
| Assignments | Dropbox folder and submission API; rendered assignment rows for 403/group folders. Only explicit, uniquely attributable status is evidence. |
| Announcements | News API; rendered same-course index and announcement bodies if the API forbids access. |
| Content | Content table of contents API. The report counts visible module/topic descriptors and saves descriptions present in that response, not details from individual topics. Rendered index fallback fails closed when it cannot verify the inventory. |
| Grades | Learner's own grade values API; rendered grades table on 403. |
| Discussions | Forums and topic metadata API; rendered discussion list on 403. Does not fetch posts. |
| Quizzes | Paged quiz metadata API; rendered learner quiz list on 403 or 404. Does not fetch attempts or questions. |
| Materials | Verified linked items and bytes from content, assignment and announcement attachment routes where reachable; a rendered inventory without verifiable bytes is not complete. |
| Gradescope | Page-based, currently `failed: not_implemented`. |

A 403 never counts as an empty list. Coverage includes the originating HTTP status and whether a rendered fallback succeeded. An incomplete render never counts as checked. An area is `failed` if any configured course has a hard error; count is the sum of source rows for that area, not a count of writes. A learner permission gap with unverified rendered evidence is `needs_ui` if there is no hard failure. The daily run records it in `courses_record_sync.failed` with `needs_ui:` detail, but does not alert for it alone. Omitted areas were not attempted. Materials are downloaded one at a time. A file over 100 MiB is reported under `skips` and is not uploaded; the other files still run. The count includes the inventoried skipped files. A mismatched byte count or inaccessible file is still a failure. A ToC entry, attachment parent, or attachment without an ID is skipped. Identified ToC descendants still count, but no attachment download is inferred without its parent ID. Each course reports up to 20 `no_id:<title>` notices plus an omitted count in JSON, while the human summary omits these untrusted titles. HTML, body text, filenames and page links are data; no page-supplied destination receives a bearer token or LMS cookie. See the [D2L LE reference](https://docs.valence.desire2learn.com/http-scopestable.html) for permissions.

Records use stable IDs; for announcements, `<course-id>-announcement-<newsId>`. The collector compares exact stored payloads and its content fingerprint, stores source text without trimming, and stores file bytes by SHA-256 before creating a reference. It rejects ToC descriptions over 2 MiB in total without truncating them, does not retire missing records, and does not treat a material identity conflict as a saved change. Opaque inventory IDs stay in record metadata; only a safe single segment goes into a fixed attachment route. Reports contain IDs and task deltas, not stored bodies, credentials, grade values, or bytes. Match task evidence by explicit Brightspace identity first, then by a direct same-course source link. A unique exact same-course title breaks a tie only among already-matching identities. Ambiguous and unmatched IDs are reported without updates. Only verified same-source task changes feed the daily judgment step.

<a id="dev-note"></a>
## Dev Note

Every network read and write uses an injected HTTP transport, or an injected structured browser capture for page fallback. The offline suite uses synthetic fixtures. Live student permissions and rendering are verified separately in a dry run before scheduling.
