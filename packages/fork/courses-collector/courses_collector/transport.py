"""Bounded HTTPS requests with no credential-bearing redirects."""
from __future__ import annotations

import json
import socket
from dataclasses import dataclass
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .config import BRIGHTSPACE_ORIGIN
from .model import ReadError

MAX_JSON = 16 * 1024 * 1024
MAX_FILE = 100 * 1024 * 1024


@dataclass(frozen=True)
class Reply:
    status: int
    body: bytes
    content_type: str = ""
    disposition: str = ""


Fetch = Callable[[Request, int], Reply]


class ResponseTooLarge(ReadError):
    """The byte limit was exceeded before returning a response body."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_https(request: Request, max_bytes: int) -> Reply:
    try:
        with build_opener(NoRedirect()).open(request, timeout=30) as response:
            size = response.headers.get("Content-Length", "")
            if request.get_method() == "GET" and size.isdecimal() and int(size) > max_bytes:
                raise ResponseTooLarge("response exceeds byte limit")
            body = response.read(max_bytes + 1)
            if len(body) > max_bytes:
                raise ResponseTooLarge("response exceeds byte limit")
            return Reply(response.status, body, response.headers.get_content_type(),
                         response.headers.get("Content-Disposition", ""))
    except HTTPError as error:
        error.close()
        return Reply(error.code, b"")
    except (URLError, socket.timeout, OSError):
        raise ReadError("network request failed") from None


def json_body(reply: Reply):
    try:
        return json.loads(reply.body)
    except (UnicodeDecodeError, ValueError):
        raise ReadError("response was not JSON", reply.status) from None


def _check_header(secret: str) -> None:
    if not secret or any(not 32 <= ord(char) <= 126 for char in secret):
        raise ReadError("missing or invalid runtime credential")


def _check_route(route: str) -> None:
    try:
        parts = urlsplit(route)
    except ValueError:
        raise ReadError("unsafe Brightspace read path") from None
    decoded = unquote(parts.path)
    if (parts.scheme or parts.netloc or not parts.path.startswith("/d2l/") or parts.fragment
            or any(ord(c) < 32 or c == "\\" for c in unquote(route))
            or any(part in (".", "..") for part in decoded.split("/"))
            or "//" in decoded):
        raise ReadError("unsafe Brightspace read path")


class Brightspace:
    def __init__(self, base_url: str, le_version: str, cookie: str, fetch: Fetch = fetch_https):
        if fetch is fetch_https and base_url != BRIGHTSPACE_ORIGIN:
            raise ReadError("Brightspace origin is not the approved NYU endpoint; no credentials sent")
        _check_header(cookie)
        self.base_url = base_url
        self.le_version = le_version
        self._cookie = cookie
        self._fetch = fetch

    def _get(self, route: str, media: str, limit: int) -> Reply:
        _check_route(route)
        reply = self._fetch(Request(self.base_url + route, headers={"Cookie": self._cookie, "Accept": media}), limit)
        if not 200 <= reply.status < 300:
            raise ReadError(f"Brightspace {urlsplit(route).path}: HTTP {reply.status}", reply.status)
        return reply

    def get_json(self, route: str):
        return json_body(self._get(route, "application/json", MAX_JSON))

    def get_file(self, route: str) -> bytes:
        try:
            reply = self._get(route, "*/*", MAX_FILE)
        except ResponseTooLarge:
            raise ResponseTooLarge("file exceeds the 100 MiB size limit") from None
        if reply.status != 200 or (reply.content_type == "text/html" and not reply.disposition):
            raise ReadError("response was not a verified file download", reply.status)
        return reply.body
