"""Optimistic, content-addressed persistence through the existing courses API."""
from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import parse_qsl, urlsplit
from urllib.request import Request

from .model import Course, Material, ReadError
from .transport import Fetch, MAX_JSON, _check_header, fetch_https, json_body

SECRET_QUERY = {"token", "access_token", "code", "session", "key", "auth", "sig", "signature", "exp", "d2lsessionval"}
STAMP = "courses-collector/v1 "


def _json(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False).encode("utf-8")


def _hash(value) -> str:
    return hashlib.sha256(_json(value)).hexdigest()


def stable_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        query = parse_qsl(parsed.query, max_num_fields=100)
    except ValueError:
        raise ReadError("invalid source URL") from None
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or any(ord(c) < 32 or c == "\\" for c in url)
            or any(k.lower() in SECRET_QUERY or k.lower().startswith("x-amz-") for k, _ in query)):
        raise ReadError("source URL is not a stable, credential-free HTTPS URL")
    return url


class Courses:
    def __init__(self, base_url: str, pat: str, fetch: Fetch = fetch_https, *, dry_run: bool = False):
        _check_header(pat)
        self._base_url, self._fetch, self._dry_run = base_url, fetch, dry_run
        self._auth = {"Authorization": "Bearer " + pat, "X-Courses-Agent": "courses-collector"}
        self._inventories: dict[str, dict[str, dict]] = {}
        self._uploaded: set[str] = set()

    @property
    def dry_run(self) -> bool:
        return self._dry_run

    def call(self, op: str, args: dict):
        if op not in {"query", "get", "save_material"} or (self._dry_run and op == "save_material"):
            raise ReadError("courses operation not permitted in this mode")
        request = Request(self._base_url + f"/v1/ops/{op}", data=_json(args), method="POST",
                          headers={**self._auth, "Content-Type": "application/json", "Accept": "application/json"})
        reply = self._fetch(request, MAX_JSON)
        if not 200 <= reply.status < 300:
            raise ReadError(f"courses {op}: HTTP {reply.status}", reply.status)
        body = json_body(reply)
        if not isinstance(body, dict) or body.get("ok") is not True or "result" not in body:
            raise ReadError(f"courses {op}: invalid response", reply.status)
        return body["result"]

    def inventory(self, course: Course, kind: str) -> dict[str, dict]:
        cache_key = course.id + ":" + kind
        if cache_key in self._inventories:
            return self._inventories[cache_key]
        offset = 0
        rows: dict[str, dict] = {}
        for _ in range(100):
            page = self.call("query", {"kind": kind, "course_id": course.id, "offset": offset, "limit": 100})
            if not isinstance(page, dict) or not isinstance(page.get("records"), list) or "next_offset" not in page:
                raise ReadError("courses query: missing pagination fields")
            for row in page["records"]:
                if (not isinstance(row, dict) or row.get("kind") != kind or row.get("course_id") != course.id
                        or not isinstance(row.get("id"), str) or not row["id"]
                        or row["id"] in rows or type(row.get("version")) is not int or row["version"] <= 0):
                    raise ReadError("courses query: invalid or repeated record")
                rows[row["id"]] = row
            next_offset = page["next_offset"]
            if next_offset is None:
                self._inventories[cache_key] = rows
                return rows
            if type(next_offset) is not int or next_offset != offset + len(page["records"]) or next_offset <= offset:
                raise ReadError("courses query: invalid pagination offset")
            offset = next_offset
        raise ReadError("courses query: page limit reached")

    def _file(self, digest: str, item: Material) -> None:
        if self._dry_run:
            raise ReadError("file upload not permitted in dry run")
        if digest in self._uploaded:
            return
        url = self._base_url + "/v1/files/" + digest
        existing = self._fetch(Request(url, method="HEAD", headers=self._auth), 0)
        if existing.status == 200:
            self._uploaded.add(digest)
            return
        if existing.status != 404:
            raise ReadError(f"courses file HEAD: HTTP {existing.status}", existing.status)
        headers = {**self._auth, "Content-Type": "application/octet-stream"}
        if item.filename and item.filename.isascii() and all(32 <= ord(c) <= 126 for c in item.filename):
            headers["X-Filename"] = item.filename[:300]
        request = Request(url, data=item.file, method="PUT", headers=headers)
        reply = self._fetch(request, MAX_JSON)
        if reply.status not in (200, 201):
            raise ReadError(f"courses file PUT: HTTP {reply.status}", reply.status)
        body = json_body(reply)
        if (not isinstance(body, dict) or body.get("ok") is not True or body.get("sha256") != digest
                or body.get("size") != len(item.file or b"")):
            raise ReadError("courses file PUT: receipt did not verify the file", reply.status)
        self._uploaded.add(digest)

    def material(self, course: Course, item: Material, observed_at: str) -> str:
        """Return unchanged/new/changed; in dry-run the latter two are previews."""
        if (not item.id.startswith(course.id + "-") or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,199}", item.id)
                or not item.title or len(item.title.encode("utf-16-le")) > 32_000):
            raise ReadError("invalid material id or title")
        url = stable_url(item.url)
        if item.file == b"":
            raise ReadError("courses service cannot store a zero-byte file")
        if item.text and len(item.text.encode("utf-16-le")) > 400_000:
            raise ReadError("material body exceeds service limit; not truncated")
        digest = hashlib.sha256(item.file).hexdigest() if item.file is not None else None
        current = {"title": item.title, "url": url, "content": item.text or None, "sha256": digest}
        metadata = {"kind": item.kind, "filename": item.filename, **item.metadata}
        fingerprint = _hash({**current, "metadata": metadata})
        evidence_detail = STAMP + _json({"sha256": fingerprint, "metadata": metadata}).decode("utf-8")
        if len(evidence_detail.encode("utf-16-le")) > 32_000:
            raise ReadError("material metadata exceeds service limit; not truncated")
        inventory = self.inventory(course, "material")
        summary = inventory.get(item.id)
        version = 0
        if summary is not None:
            row = self.call("get", {"id": item.id, "detail": "full", "expand": ["evidence"]})
            if (not isinstance(row, dict) or row.get("id") != item.id or row.get("kind") != "material"
                    or row.get("version") != summary["version"] or not isinstance(row.get("data"), dict)):
                raise ReadError("courses material baseline changed or is invalid")
            old = row["data"]
            version = summary["version"]
            if old.get("course_id") != course.id:
                raise ReadError("courses material baseline is for another course")
            evidence = old.get("evidence") or {}
            old_detail = evidence.get("detail", "") if isinstance(evidence, dict) else ""
            same_values = _hash({field: old.get(field) for field in current}) == _hash(current)
            if same_values and (old_detail == evidence_detail or not str(old_detail).startswith(STAMP)):
                return "unchanged"
            if any(current[field] is None and old.get(field) is not None for field in ("content", "sha256")):
                raise ReadError("courses service cannot clear a missing material content field")
        change = "changed" if version else "new"
        if self._dry_run:
            return change
        if digest:
            self._file(digest, item)
        request_id = "collector-" + _hash([item.id, version, fingerprint, observed_at])
        result = self.call("save_material", {
            "id": item.id, "course_id": course.id, "expected_version": version, "request_id": request_id,
            **{key: value for key, value in current.items() if value is not None},
            "evidence": {"kind": "platform", "url": url, "observed_at": observed_at, "detail": evidence_detail},
        })
        if (not isinstance(result, dict) or result.get("duplicate") or result.get("conflict")
                or result.get("id") != item.id or result.get("kind") != "material" or result.get("version") != version + 1):
            raise ReadError("courses material write was not applied; check for duplicate identity or version conflict")
        return change
