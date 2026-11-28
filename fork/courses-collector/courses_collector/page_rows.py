#!/usr/bin/env python3
"""Turn a captured Brightspace assignments page into per-folder submission rows.

The API cannot answer two kinds of folder (group folders, and folders whose
availability window has closed: both answer 403 to a student). The rendered page can,
so this script parses it mechanically instead of letting a model eyeball it — that is
how "the page came back empty" turned into "nothing changed" on 2026-11-22.

Input: the JSON that `headless_browser_read` printed, or its `text`/`content` string,
on stdin. Output: JSON on stdout with, for every requested name, one of
  submitted <date?>/<files?>  |  not_submitted  |  unreadable (reason)
Exit code 0 only when every requested folder was resolved.

Usage:
    BS_PAGE_JSON=/tmp/page.json bs-page-rows.py "Name one" "Name two"
    headless read output | bs-page-rows.py --file /tmp/page.json --names names.txt
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any

STATUS_SUBMITTED = re.compile(r"(\d+)\s+Submission", re.IGNORECASE)
STATUS_NONE = re.compile(r"Not\s+Submitted", re.IGNORECASE)
STATUS_CELL = re.compile(r"[1-9]\d*\s+Submissions?(?:\s*,\s*\d+\s+Files?)?", re.I)
DUE = re.compile(r"Due on ([A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M)")


def page_text(payload: Any) -> str:
    """Accept the read tool's JSON, its nested `text`, or a plain string."""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        text = payload.get("text")
        if isinstance(text, str):
            return text
        if isinstance(text, dict) and isinstance(text.get("content"), str):
            return text["content"]
        for key in ("content", "body"):
            if isinstance(payload.get(key), str):
                return payload[key]
    raise SystemExit("bs-page-rows: no text found in the input")


def parse_status_cell(cell: str) -> str:
    """Use only the supplied status cell, not surrounding text or navigation."""
    value = ' '.join(cell.split())
    if STATUS_NONE.fullmatch(value):
        return 'not_submitted'
    return 'submitted' if STATUS_CELL.fullmatch(value) else 'unknown'


def split_row(chunk: str) -> dict[str, Any]:
    """Read one folder's text block into a status."""
    status: dict[str, Any] = {"status": "unreadable", "reason": "no status cell"}
    if STATUS_NONE.search(chunk):
        status = {"status": "not_submitted"}
    else:
        match = STATUS_SUBMITTED.search(chunk)
        if match:
            files = re.search(r"(\d+)\s+File", chunk)
            status = {
                "status": "submitted",
                "submission_count": int(match.group(1)),
                "files": int(files.group(1)) if files else None,
            }
    due = DUE.search(chunk)
    if due:
        status["due_text"] = due.group(1)
    return status


def parse(text: str, names: list[str]) -> dict[str, Any]:
    positions: list[tuple[int, str]] = []
    for name in names:
        index = text.find(name)
        if index >= 0:
            positions.append((index, name))
    positions.sort()
    rows: dict[str, Any] = {}
    for order, (start, name) in enumerate(positions):
        end = positions[order + 1][0] if order + 1 < len(positions) else len(text)
        rows[name] = split_row(text[start:end])
    out: dict[str, Any] = {"rows": {}, "unreadable": [], "page_chars": len(text)}
    for name in names:
        row = rows.get(name, {"status": "unreadable", "reason": "name not on the page"})
        out["rows"][name] = row
        if row["status"] == "unreadable":
            out["unreadable"].append(name)
    out["ok"] = not out["unreadable"]
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("names", nargs="*", help="folder names to resolve")
    parser.add_argument("--file", help="read the captured JSON from this file")
    parser.add_argument("--names-file", help="one folder name per line")
    args = parser.parse_args()

    names = list(args.names)
    if args.names_file:
        with open(args.names_file, encoding="utf-8") as handle:
            names.extend(line.strip() for line in handle if line.strip())
    if not names:
        print("bs-page-rows: give at least one folder name", file=sys.stderr)
        return 2

    raw = open(args.file, encoding="utf-8").read() if args.file else sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = raw
    text = page_text(payload)
    result = parse(text, names)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
