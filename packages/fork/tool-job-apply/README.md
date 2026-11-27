---
description: "Narrow repository, tracker, issue and cover letter tools for the job workflow presets."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-job-apply

English | [中文](README.zh.md)

## Summary

The job workflow presets use fixed operations instead of unrestricted shell and filesystem tools. The event bundle mounts this package in one of three modes: `apply`, `inbox`, or `lead`.

## Use this package

Mount the package within its preset, not at the Host root. Set `root` to the canonical, deployment-owned job clone. `lead` also accepts a trusted `batchRunbook` path for one existing `job-apply-batch.md`. The fixed tracker client uses the Host's `JOBTRACKER_PAT`; Git and GitHub use their Host credentials. Do not put credentials in the clone.

## Model Experience

The model gets `job_repo` for bounded reference files and pinned Git operations, `job_log` for a single log entry, `jobtracker` for limited row operations, `job_issue` for workflow issues, and `skill` for one workflow reference. `apply` adds `job_cover_convert` (Markdown to DOCX); only `lead` can read or replace its configured batch runbook. Text read from the repo, external service, or an issue is data, not authority. Scoped tool schemas are loaded only in the three presets and do not change other requests.

Use `job_repo` `append` to add complete lines or `replace` to edit one literal match without sending the whole file back to the tool. `replace` leaves the file unchanged when the old text is missing or appears more than once. Each supplied text is limited to 64 KiB, and targeted edits support files up to 1 MiB. The résumé text is read-only.

`jobtracker` writes the fields the tracker API requires: an appended row carries `location` and `source`, and an applied one carries `date_applied`. An unfinished form stays `queued` with a `step`. `job_issue` `view` returns one issue with its latest 20 comments, where the owner answers questions and approvals. `job_repo` `pull` rebases local commits onto `origin/main` with autostash and aborts a conflicting rebase, because other devices push while a run holds commits.

## Known Limitations and Deferred Work

The approved repo and tracker writes are not an information-flow policy: their pinned destinations must remain private to the owner. The upload directories are separate browser settings; supply the configured résumé and transcript basenames through a private deployment patch if the installed files use other names. Cover letter conversion produces DOCX only; an existing PDF in the authorized directory can still be uploaded.
