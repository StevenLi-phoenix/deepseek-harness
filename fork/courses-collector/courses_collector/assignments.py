#!/usr/bin/env python3
"""Read Brightspace assignments through the D2L REST API, not the rendered page.

Why: the browser tools return an empty shell (URL + title only) when a page is read
before it finishes rendering. On 2026-11-22 at 03:00 and 09:00 every read came back
as 189-234 characters with no table rows, and the sync turned that into "not
submitted" for three assignments the owner had handed in the day before. A read that
returns nothing is not evidence that nothing changed.

Rules this file enforces, so no caller can turn silence into a fact:
  * every course's answer carries `status`: "ok", or "failed" with a reason;
  * a payload that is not the shape the API documents is `failed`, not an empty list;
  * a course whose folder list is empty is `failed` — a real course always has some;
  * the process exits non-zero unless every requested course is `ok`;
  * a folder's `status` is "submitted"/"not_submitted" only when a submissions payload
    was actually parsed; otherwise it stays "unknown";
  * "unknown" is a value, never something that reads as "no change".

Usage:
    BS_COOKIE="d2lSessionVal=...; d2lSecureSessionVal=..." ./bs-collect.py [-o out.json]

The cookie header comes from the headless-browser tool (`headless_browser_cookies`,
field `toHeader`); keep it in the environment, never on disk.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Any, Callable

from .model import ReadError
from .transport import Brightspace

BASE = "https://brightspace.nyu.edu/d2l/api/le/1.67"

ET = ZoneInfo("America/New_York")

# A course whose folder list is empty is treated as a broken read, not a course
# without work: every course this account takes has at least one folder.
MIN_FOLDERS = 1

# Two kinds of folder are unreadable through the student API and must be confirmed on
# the rendered page instead: group folders (D2L only grants cross-group reads to a
# teacher) and folders whose availability window has closed (the API answers 403 once
# EndDate is past, which is exactly the state of everything the owner already handed
# in). Both end up `needs_ui`, never `not_submitted`.
#
# Group folders (GroupTypeId != 0) answer 403 to the student API: D2L only lets a
# teacher read a folder's submissions across groups. The web UI shows the learner's
# own group submission, so those folders are reported as `unknown` with needs_ui=True
# and the caller must confirm them on the rendered page (with a row-presence check)
# before any record is written.


def _fetch(path: str, cookie: str) -> Any:
    origin, le_version = BASE.split("/d2l/api/le/")
    return Brightspace(origin, le_version, cookie).get_json(f"/d2l/api/le/{le_version}{path}")


def validate_folders(payload: Any) -> list[dict[str, Any]]:
    """The folder list must be a non-empty list of objects with an integer Id and a Name."""
    if not isinstance(payload, list):
        raise ReadError(f"expected a list, got {type(payload).__name__}")
    if len(payload) < MIN_FOLDERS:
        raise ReadError("empty list")
    folders: list[dict[str, Any]] = []
    for index, row in enumerate(payload):
        if not isinstance(row, dict):
            raise ReadError(f"[{index}] expected an object")
        if type(row.get("Id")) is not int or row["Id"] < 1:
            raise ReadError(f"[{index}] missing integer Id")
        if not isinstance(row.get("Name"), str) or not row["Name"].strip():
            raise ReadError(f"[{index}] missing Name")
        folders.append(row)
    return folders


def validate_submissions(payload: Any) -> list[dict[str, Any]]:
    """The submissions payload is a list of entities, each with an optional Submissions list."""
    if not isinstance(payload, list):
        raise ReadError(f"expected a list, got {type(payload).__name__}")
    submissions: list[dict[str, Any]] = []
    for index, entity in enumerate(payload):
        if not isinstance(entity, dict):
            raise ReadError(f"[{index}] expected an object")
        rows = entity.get("Submissions")
        if rows is None:
            continue
        if not isinstance(rows, list):
            raise ReadError(f"[{index}].Submissions expected a list")
        for row in rows:
            if not isinstance(row, dict):
                raise ReadError(f"[{index}] submission is not an object")
            submissions.append(row)
    return submissions


def iso(value: Any) -> str | None:
    """D2L UTC timestamp -> ISO string in New York time; anything else is null."""
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(ET).isoformat() if parsed.tzinfo is not None else None


def read_course(
    ou: int, cookie: str, fetch: Callable[[str, str], Any], *, attachment_base: str = BASE,
    read_submissions: bool = True,
) -> dict[str, Any]:
    try:
        folders = validate_folders(fetch(f"/{ou}/dropbox/folders/", cookie))
    except ReadError as error:
        return {"org_unit": ou, "status": "failed", "reason": f"folders: {error}", "http_status": error.http_status}

    rows: list[dict[str, Any]] = []
    failures: list[tuple[int, ReadError]] = []
    for folder in folders:
        instructions = folder.get("CustomInstructions") or {}
        attachments = folder.get("Attachments") or []
        if not isinstance(instructions, dict) or not isinstance(instructions.get("Text") or "", str):
            failures.append((folder["Id"], ReadError("invalid assignment instructions")))
            instructions = {}
        if not isinstance(attachments, list) or any(not isinstance(item, dict) for item in attachments):
            failures.append((folder["Id"], ReadError("invalid assignment attachment list")))
            attachments = []
        row: dict[str, Any] = {
            "folder_id": folder["Id"],
            "name": folder["Name"],
            "due_at": iso(folder.get("DueDate")),
            "due_known": "DueDate" in folder and (folder["DueDate"] is None or iso(folder["DueDate"]) is not None),
            "hidden": bool(folder.get("IsHidden")),
            "group": bool(folder.get("GroupTypeId")),
            "status": "unknown",
            "submitted_at": None,
            "files": None,
            # The assignment's own material: what it asks for and what it hands out.
            "requirements": (instructions.get("Text") or "").strip(),
            "attachments": [
                {
                    "name": item.get("FileName"),
                    "size": item.get("Size"),
                    "url": f"{attachment_base}/{ou}/dropbox/folders/{folder['Id']}/attachments/{item.get('Id')}",
                }
                for item in attachments
                if item.get("Id") is not None
            ],
        }
        if not read_submissions or row["hidden"]:
            rows.append(row)
            continue
        if folder.get("GroupTypeId"):
            row["needs_ui"] = True
            row["reason"] = "group folder: student API answers 403"
            rows.append(row)
            continue
        try:
            submissions = validate_submissions(
                fetch(f"/{ou}/dropbox/folders/{folder['Id']}/submissions/", cookie)
            )
        except ReadError as error:
            if error.http_status == 403 or "http 403" in str(error).lower():
                row["needs_ui"] = True
                row["reason"] = "closed to the student API (http 403): confirm on the page"
            else:
                failures.append((folder["Id"], error))
            rows.append(row)
            continue
        row["status"] = "submitted" if submissions else "not_submitted"
        if submissions:
            dated = [item for item in submissions if iso(item.get("SubmissionDate"))]
            latest = (
                max(dated, key=lambda item: iso(item.get("SubmissionDate")) or "")
                if dated
                else submissions[-1]
            )
            row["submitted_at"] = iso(latest.get("SubmissionDate"))
            files = latest.get("Files")
            if files is not None and not isinstance(files, list):
                failures.append((folder["Id"], ReadError("invalid submission file list")))
            else:
                row["files"] = len(files or [])
        rows.append(row)

    result: dict[str, Any] = {
        "org_unit": ou,
        "folders": rows,
        "counts": {
            "folders": len(rows),
            "submitted": sum(1 for row in rows if row["status"] == "submitted"),
            "not_submitted": sum(1 for row in rows if row["status"] == "not_submitted"),
            "unknown": sum(1 for row in rows if row["status"] == "unknown"),
            "needs_ui": sum(1 for row in rows if row.get("needs_ui")),
        },
    }
    if failures:
        result["status"] = "failed"
        first_id, first_error = failures[0]
        result["reason"] = f"{len(failures)} of {len(rows)} folders unreadable (folder {first_id}): {first_error}"
        result["http_status"] = first_error.http_status
    else:
        result["status"] = "ok"
    return result


def collect(
    cookie: str,
    courses: dict[str, int],
    fetch: Callable[[str, str], Any] | None = None,
) -> dict[str, Any]:
    reader = fetch or _fetch
    out: dict[str, Any] = {
        "read_at": datetime.now(ET).isoformat(),
        "expected_courses": len(courses),
        "courses": {},
    }
    for name, ou in courses.items():
        out["courses"][name] = read_course(ou, cookie, reader)
    failed = sorted(name for name, value in out["courses"].items() if value["status"] != "ok")
    out["ok"] = not failed
    out["failed_courses"] = failed
    out["failed_count"] = len(failed)
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("-o", "--out", help="write JSON here instead of stdout")
    parser.add_argument("--course", action="append", help="limit to these short names")
    parser.add_argument("--config", help="private collector configuration JSON")
    args = parser.parse_args(argv)

    cookie = os.environ.get("BS_COOKIE", "").strip()
    if "d2lSessionVal=" not in cookie:
        print("bs-collect: set BS_COOKIE to the browser's cookie header", file=sys.stderr)
        return 2

    from .config import load_config

    try:
        config = load_config(args.config)
        courses = {course.slug: course.org_unit_id for course in config.courses}
    except ReadError as error:
        print(f"bs-collect: {error}", file=sys.stderr)
        return 2
    if args.course:
        unknown = [name for name in args.course if name not in courses]
        if unknown:
            print(f"bs-collect: unknown course {unknown}", file=sys.stderr)
            return 2
        courses = {name: courses[name] for name in args.course}

    client = Brightspace(config.brightspace_origin, config.le_version, cookie)
    version_path = f"/d2l/api/le/{config.le_version}"
    payload = collect(cookie, courses, lambda path, _: client.get_json(version_path + path))
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        ok = payload["expected_courses"] - payload["failed_count"]
        print(f"bs-collect: wrote {args.out} ({ok}/{payload['expected_courses']} courses ok)")
    else:
        print(text)
    if not payload["ok"]:
        print(f"bs-collect: failed courses: {', '.join(payload['failed_courses'])}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
