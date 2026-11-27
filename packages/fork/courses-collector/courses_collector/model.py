"""Values shared by the collector's transport, readers and report pipeline."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class ReadError(Exception):
    """A source read or storage operation that did not yield usable evidence."""

    def __init__(self, reason: str, http_status: int | None = None):
        super().__init__(reason)
        self.http_status = http_status


class NeedsUI(ReadError):
    """A verified learner-API permission gap requiring rendered evidence."""


@dataclass(frozen=True)
class Course:
    slug: str
    id: str
    org_unit_id: int
    # When a different platform owns submissions, the Brightspace status is not evidence.
    assignment_submissions: bool = True


@dataclass(frozen=True)
class Material:
    id: str
    title: str
    url: str
    kind: str
    text: str | None = None
    file: bytes | None = None
    filename: str | None = None
    download_path: str | None = None
    expected_size: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    skip_reason: str | None = None


@dataclass(frozen=True)
class TaskEvidence:
    platform_id: str
    title: str
    url: str
    due_at: str | None
    submission_status: str = 'unknown'
    due_known: bool = True


@dataclass
class Reading:
    records: list[Material] = field(default_factory=list)
    source: str = 'api'
    fallback_http: int | None = None
    count: int | None = None
    tasks: list[TaskEvidence] = field(default_factory=list)
    failure: ReadError | None = None
