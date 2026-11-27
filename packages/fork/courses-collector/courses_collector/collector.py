"""Read individual areas, reconcile stored evidence, and prepare a compact report."""
from __future__ import annotations

from collections import Counter
from dataclasses import replace
from datetime import datetime, timezone
import re
from urllib.parse import parse_qs, urlsplit

from . import assignments as legacy
from .areas import AreaReader
from .config import Config
from .model import Course, Material, ReadError, Reading, TaskEvidence
from .store import Courses, stable_url
from .transport import MAX_FILE, Brightspace, ResponseTooLarge

AREAS = ("assignments", "announcements", "content", "grades", "discussions", "quizzes", "materials", "gradescope")


def assignment_url(origin: str, course: Course, folder_id: str) -> str:
    return f"{origin}/d2l/lms/dropbox/user/folder_submit_files.d2l?db={folder_id}&ou={course.org_unit_id}"


def read_assignments(client: Brightspace, course: Course, page_reader) -> Reading:
    api_path = "/d2l/api/le/" + client.le_version
    result = legacy.read_course(course.org_unit_id, "", lambda path, _: client.get_json(api_path + path),
                                attachment_base=client.base_url + api_path,
                                read_submissions=course.assignment_submissions)
    folders = [row for row in result.get("folders", []) if not row["hidden"]]
    source = "api"
    fallback = None
    failure = None
    page_status = {}
    if result["status"] == "failed":
        failure = ReadError(result["reason"], result.get("http_status"))
    if failure and failure.http_status == 403 and not folders:
        if page_reader is None:
            return Reading(failure=failure, fallback_http=403)
        try:
            tasks = page_reader.assignment_task_rows(course)
            if not tasks:
                raise ReadError("no verified assignment rows")
            if not course.assignment_submissions:
                tasks = [TaskEvidence(t.platform_id, t.title, t.url, t.due_at, due_known=t.due_known) for t in tasks]
            return Reading(tasks=tasks, source="page", fallback_http=403, count=len(tasks))
        except ReadError as error:
            return Reading(source="page", fallback_http=403, failure=ReadError(f"listing API HTTP 403; {error}", 403))
    needs_page = [row for row in folders if row.get("needs_ui")]
    if needs_page:
        fallback = 403 if any(not row["group"] for row in needs_page) else None
        page_label = "submissions API HTTP 403" if fallback else "group submissions require rendered evidence"
        if page_reader is not None:
            source = "api+page"
            try:
                title_counts = Counter(row["name"] for row in folders)
                names = [row["name"] for row in needs_page if title_counts[row["name"]] == 1]
                page_status = page_reader.assignment_statuses(course, names) if names else {}
            except ReadError as error:
                failure = failure or ReadError(f"{page_label}; {error}", fallback)
        unresolved = sum(page_status.get(row["name"]) not in ("submitted", "not_submitted") for row in needs_page)
        if unresolved:
            failure = failure or ReadError(f"{page_label}: {unresolved} submission rows not verified on rendered page", fallback)
    tasks = []
    for row in folders:
        platform_id = str(row["folder_id"])
        status = row["status"]
        if row.get("needs_ui"):
            status = page_status.get(row["name"], "unknown")
        due_at = row["due_at"]
        due_known = row["due_known"]
        if not due_known:
            failure = failure or ReadError("assignment due date missing or malformed")
        tasks.append(TaskEvidence(platform_id, row["name"], assignment_url(client.base_url, course, platform_id),
                                  due_at, status, due_known))
    return Reading(tasks=tasks, source=source, fallback_http=fallback, count=len(tasks), failure=failure)


def read_gradescope() -> Reading:
    return Reading(source="page", failure=ReadError("not_implemented"))


def _normalize_instant(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            return parsed
    except (AttributeError, ValueError):
        pass
    raise ReadError("invalid saved or observed deadline")


def _matching_saved(rows: dict[str, dict], course: Course, evidence: TaskEvidence, origin: str):
    exact = []
    for row in rows.values():
        links = row.get("source_links") or []
        if not isinstance(links, list):
            raise ReadError("invalid saved source links")
        for link in links:
            if (not isinstance(link, dict) or not isinstance(link.get("url"), str)
                    or link.get("kind") not in ("requirements", "submission", "evidence")):
                continue
            try:
                parts = urlsplit(link["url"])
                q = parse_qs(parts.query, max_num_fields=64)
            except ValueError:
                continue
            if (f"{parts.scheme}://{parts.netloc}" == origin and
                    parts.path == "/d2l/lms/dropbox/user/folder_submit_files.d2l" and
                    q.get("ou") == [str(course.org_unit_id)] and q.get("db") == [evidence.platform_id]):
                exact.append(row)
                break
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise ReadError("assignment identity matches multiple saved tasks")
    # Title alone is not permission to rewrite a saved task with unclear identity.
    return None


def _task_diffs(rows: dict[str, dict], course: Course, readings: list[TaskEvidence], origin: str):
    changes, unchanged, unmatched = [], [], []
    seen = set()
    for task in readings:
        if task.platform_id in seen or not re.fullmatch(r"[1-9][0-9]{0,19}", task.platform_id):
            raise ReadError("repeated or invalid assignment platform id")
        seen.add(task.platform_id)
        row = _matching_saved(rows, course, task, origin)
        platform_id = course.id + "-assignment-" + task.platform_id
        if row is None:
            # Kept out of the summary. Operator can reconcile by actual source, not guess from the slug.
            unmatched.append({"id": platform_id, "url": stable_url(task.url)})
            continue
        task_id, version = row["id"], row["version"]
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}", task_id):
            raise ReadError("invalid saved task id")
        diff = {}
        if task.due_known:
            due = row.get("due_at")
            if _normalize_instant(due) != _normalize_instant(task.due_at):
                diff["due_at"] = {"before": due, "after": task.due_at}
        old_sub = row.get("submission_status") or "unknown"
        if old_sub not in ("submitted", "not_submitted", "unknown"):
            raise ReadError("invalid saved submission status")
        verified = row.get("submission_verified") is True
        if task.submission_status in ("submitted", "not_submitted") and (old_sub != task.submission_status or not verified):
            # A submission once verified elsewhere is not erased by an empty LMS status.
            if not (old_sub == "submitted" and verified and task.submission_status == "not_submitted"):
                diff["submission_status"] = {"before": old_sub, "after": task.submission_status}
        if diff:
            changes.append({"id": task_id, "platform_id": platform_id, "version": version,
                            "url": stable_url(task.url), "fields": diff})
        elif task.due_known and task.submission_status != "unknown" and verified and old_sub == task.submission_status:
            unchanged.append(task_id)
    return changes, unchanged, unmatched


class FileOverLimit(Exception):
    """An attachment exceeded the byte cap before any storage operation."""


def _save_item(brightspace: Brightspace, courses: Courses, course: Course,
               item: Material, when: str) -> str:
    if item.download_path is None:
        return courses.material(course, item, when)
    if item.expected_size is not None and item.expected_size > MAX_FILE:
        raise FileOverLimit
    try:
        data = brightspace.get_file(item.download_path)
    except ResponseTooLarge:
        raise FileOverLimit from None
    if len(data) > MAX_FILE:
        raise FileOverLimit
    if item.expected_size is not None and len(data) != item.expected_size:
        raise ReadError("Brightspace attachment byte count does not match metadata")
    return courses.material(course, replace(item, file=data, download_path=None), when)


def collect(config: Config, selected: tuple[str, ...], brightspace: Brightspace, courses: Courses,
            page_reader=None, *, read_at: str | None = None) -> dict:
    if not selected or len(set(selected)) != len(selected) or set(selected) - set(AREAS):
        raise ValueError("invalid selected areas")
    when = read_at or datetime.now(timezone.utc).isoformat()
    result = {"schema_version": 1, "read_at": when, "dry_run": courses.dry_run,
              "source_url": brightspace.base_url, "areas": {}}
    readers = AreaReader(brightspace, page_reader)
    for area in selected:
        area_report = {"status": "checked", "count": 0, "courses": {}}
        result["areas"][area] = area_report
        for course in config.courses:
            failures = []
            try:
                if area == "assignments":
                    reading = read_assignments(brightspace, course, page_reader)
                elif area == "gradescope":
                    reading = read_gradescope()
                else:
                    reading = readers.read(area, course, when)
            except ReadError as error:
                fallback = "page fallback:" in str(error)
                reading = Reading(source="page" if fallback else "api",
                                  fallback_http=error.http_status if fallback else None, failure=error)
            summary = {"status": "checked", "source": reading.source,
                       "count": reading.count if reading.count is not None else len(reading.records),
                       "fallback_http": reading.fallback_http, "http_status": None, "reason": None,
                       "changes": [], "skips": [], "task_changes": [], "checked_ids": [], "unmatched_tasks": []}
            area_report["courses"][course.slug] = summary
            if reading.failure:
                failures.append(reading.failure)
            ids = set()
            for item in reading.records:
                if item.id in ids:
                    failures.append(ReadError("duplicate material id in source"))
                    continue
                ids.add(item.id)
                try:
                    action = _save_item(brightspace, courses, course, item, when)
                    if action != "unchanged":
                        summary["changes"].append({"id": item.id, "action": action})
                except FileOverLimit:
                    summary["skips"].append({"id": item.id, "reason": "file exceeds the 100 MiB size limit"})
                except ReadError as error:
                    failures.append(error)
            if reading.tasks:
                try:
                    rows = courses.inventory(course, "task")
                    diffs, checked, unmatched = _task_diffs(rows, course, reading.tasks, brightspace.base_url)
                    summary.update(task_changes=diffs, checked_ids=checked, unmatched_tasks=unmatched)
                except ReadError as error:
                    failures.append(error)
            if failures:
                summary.update(status="failed", http_status=next((e.http_status for e in failures if e.http_status), None),
                               reason="; ".join(dict.fromkeys(str(e) for e in failures)))
                area_report["status"] = "failed"
            area_report["count"] += summary["count"]
    result["ok"] = all(value["status"] == "checked" for value in result["areas"].values())
    return result


def human_summary(report: dict) -> str:
    lines = ["Courses collector " + ("DRY RUN (no writes)" if report["dry_run"] else "report")]
    for area, group in report["areas"].items():
        details = []
        for course, row in group["courses"].items():
            if row["status"] == "failed":
                status = f"HTTP {row['http_status']}; " if row["http_status"] else ""
                details.append(f"{course}: {status}{row['reason']}")
            elif row["fallback_http"]:
                details.append(f"{course}: {row['source']} fallback after HTTP {row['fallback_http']}")
            elif row["source"] == "api+page":
                details.append(f"{course}: rendered confirmation for group submissions")
        lines.append(f"{area}: {group['status']} ({group['count']} records)" + ("; " + " | ".join(details) if details else ""))
        for course, row in group["courses"].items():
            for item in row["changes"]:
                lines.append(f"  {course} {item['action']} {item['id']}")
            for item in row["skips"]:
                lines.append(f"  {course} skipped {item['id']}: {item['reason']}")
            for task in row["task_changes"]:
                fields = ", ".join(f"{key} {v['before']!s} -> {v['after']!s}" for key, v in task["fields"].items())
                lines.append(f"  {course} observe {task['id']} v{task['version']}: {fields}")
            if row["unmatched_tasks"]:
                lines.append(f"  {course} {len(row['unmatched_tasks'])} unmatched assignment IDs (see report)")
    return "\n".join(lines)
