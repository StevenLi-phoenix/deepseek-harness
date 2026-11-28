"""Load private, non-secret collector configuration."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .model import Course, ReadError

BRIGHTSPACE_ORIGIN = "https://brightspace.nyu.edu"
COURSES_API_BASE = "https://api.lishuyu.app/courses"

SAFE_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,95}\Z")


@dataclass(frozen=True)
class Config:
    brightspace_origin: str
    courses_base_url: str
    courses: tuple[Course, ...]
    le_version: str = "1.67"


def https_url(raw: object, *, origin: bool = False) -> str:
    if not isinstance(raw, str):
        raise ReadError("expected an HTTPS URL")
    try:
        parts = urlsplit(raw)
        good = (parts.scheme == "https" and parts.hostname and parts.port in (None, 443)
                and not parts.username and not parts.password and not parts.query and not parts.fragment
                and (not origin or parts.path in ("", "/")))
    except ValueError:
        good = False
    if not good or any(char.isspace() or char == "\\" for char in raw):
        raise ReadError("invalid HTTPS service URL")
    # Normalize explicit default ports so same-origin comparisons are reliable.
    return f"https://{parts.hostname}{parts.path.rstrip('/')}"


def load_config(filename: str | None = None) -> Config:
    home = Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh")
    path = Path(filename) if filename else home / "data" / "courses" / "collector.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ReadError("cannot read collector configuration JSON") from None
    if not isinstance(data, dict) or set(data) - {"brightspace_origin", "courses_base_url", "courses", "le_version"}:
        raise ReadError("invalid collector configuration object")
    rows = data.get("courses")
    if not isinstance(rows, dict) or not rows:
        raise ReadError("configure at least one course")
    courses = []
    for slug, row in rows.items():
        if (not SAFE_ID.fullmatch(slug) or not isinstance(row, dict)
                or set(row) - {"id", "org_unit_id", "assignment_submissions"}
                or not isinstance(row.get("id"), str) or not SAFE_ID.fullmatch(row["id"])
                or type(row.get("org_unit_id")) is not int or row["org_unit_id"] < 1
                or type(row.get("assignment_submissions", True)) is not bool):
            raise ReadError("invalid private course entry")
        courses.append(Course(slug, row["id"], row["org_unit_id"], row.get("assignment_submissions", True)))
    if len({c.id for c in courses}) != len(courses) or len({c.org_unit_id for c in courses}) != len(courses):
        raise ReadError("duplicate course id or org unit")
    version = data.get("le_version", "1.67")
    if not isinstance(version, str) or not re.fullmatch(r"1\.[0-9]{1,3}", version):
        raise ReadError("invalid LE version")
    brightspace = https_url(data.get("brightspace_origin"), origin=True)
    service = https_url(data.get("courses_base_url"))
    if brightspace != BRIGHTSPACE_ORIGIN:
        raise ReadError("Brightspace origin is not the approved NYU endpoint; no credentials sent")
    if service != COURSES_API_BASE:
        raise ReadError("courses base URL is not the approved API endpoint; no credentials sent")
    return Config(brightspace, service, tuple(courses), version)
