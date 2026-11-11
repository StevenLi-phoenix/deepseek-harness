#!/usr/bin/env python3
"""The login door: the one narrow window from the event service to NapCat's WebUI.

NapCat's WebUI can open a shell in the container, browse its files, and read the QQ session. The event service
(user dsh-runtime) must not hold that token. This process runs in its own container next to NapCat, holds the
WebUI token itself (it reads webui.json from the napcat-config volume, mounted read-only), and offers exactly two
things on 127.0.0.1:
    GET  /v1/login           what NapCat's login looks like now: online / waiting for a scan (with the QR link) / ...
    POST /v1/login/refresh   ask NapCat for a fresh QR code
Callers authenticate with the OneBot access token they already have (onebot11.json in the same volume). Everything
NapCat answers is untrusted: only a few typed fields are passed on, capped. Neither tokens nor the QR link are logged;
the log names only state changes.

Configuration (environment): DOOR_CFG (/cfg), DOOR_UPSTREAM (http://napcat:6099), DOOR_BIND (0.0.0.0), DOOR_PORT (3002).
Python standard library only; the image already carries python3.
"""
import hashlib
import hmac
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

CFG = os.environ.get("DOOR_CFG", "/cfg")
UPSTREAM = os.environ.get("DOOR_UPSTREAM", "http://napcat:6099").rstrip("/")
BIND = os.environ.get("DOOR_BIND", "0.0.0.0")
PORT = int(os.environ.get("DOOR_PORT", "3002"))
# Status answers are shared for this long, so open pages cost NapCat at most one round of calls per interval.
CACHE_S = float(os.environ.get("DOOR_CACHE_S", "1.5"))
# While QQ is logged in nothing on the page changes, so NapCat is asked this rarely.
CACHE_ONLINE_S = float(os.environ.get("DOOR_CACHE_ONLINE_S", "60"))
# A fresh code is not asked for while QQ is logged in, nor this soon after it logged in: a new code then only
# invites the account to be signed out.
RECENT_LOGIN_S = float(os.environ.get("DOOR_RECENT_LOGIN_S", "600"))
# A WebUI credential is valid for an hour; renew before that.
CREDENTIAL_S = 50 * 60
# NapCat renews its code by itself every ~2 minutes; a manual refresh is allowed this often.
REFRESH_GAP_S = float(os.environ.get("DOOR_REFRESH_GAP_S", "10"))
UPSTREAM_TIMEOUT_S = 5

PHASES = {"waiting_qrcode", "generating_qrcode", "qrcode_scanned", "initializing", "ready", "offline", "reconnecting"}


def log(message):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), "login-door:", message, file=sys.stderr, flush=True)


class UpstreamError(Exception):
    """NapCat could not be asked: `kind` is unreachable, auth, or protocol."""

    def __init__(self, kind):
        super().__init__(kind)
        self.kind = kind


def read_secret(file, *path):
    """A string field of a JSON file in the config volume, or None. Never logged."""
    try:
        with open(os.path.join(CFG, file), encoding="utf-8") as handle:
            value = json.load(handle)
        for key in path:
            value = value[key]
        return value if isinstance(value, str) and value != "" else None
    except (OSError, ValueError, LookupError, TypeError):
        return None


class Upstream:
    """NapCat's WebUI API: sign in with the WebUI token, then call QQLogin endpoints."""

    def __init__(self):
        self._credential = None
        self._credential_at = 0.0
        self._lock = threading.Lock()

    def _request(self, method, path, body=None, credential=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(UPSTREAM + "/api" + path, data=data, method=method)
        request.add_header("content-type", "application/json")
        if credential is not None:
            request.add_header("authorization", "Bearer " + credential)
        try:
            with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_S) as response:
                raw = response.read(1_000_000)
        except urllib.error.HTTPError as error:
            raw = error.read(1_000_000)
        except (urllib.error.URLError, OSError):
            raise UpstreamError("unreachable") from None
        try:
            answer = json.loads(raw)
        except ValueError:
            raise UpstreamError("protocol") from None
        if not isinstance(answer, dict):
            raise UpstreamError("protocol")
        return answer

    def _sign_in(self):
        token = read_secret("webui.json", "token")
        if token is None:
            raise UpstreamError("auth")
        digest = hashlib.sha256((token + ".napcat").encode()).hexdigest()
        answer = self._request("POST", "/auth/login", {"hash": digest})
        data = answer.get("data")
        credential = data.get("Credential") if isinstance(data, dict) else None
        if answer.get("code") != 0 or not isinstance(credential, str):
            raise UpstreamError("auth")
        self._credential, self._credential_at = credential, time.time()

    def call(self, method, path, body=None):
        """The `data` of a NapCat answer. Signs in on demand and once more when the credential was refused."""
        with self._lock:
            for attempt in (0, 1):
                if self._credential is None or time.time() - self._credential_at > CREDENTIAL_S:
                    self._sign_in()
                answer = self._request(method, path, body, self._credential)
                refused = answer.get("code") != 0 and str(answer.get("message", "")).lower().startswith("unauthorized")
                if refused and attempt == 0:
                    self._credential = None
                    continue
                if refused:
                    raise UpstreamError("auth")
                if answer.get("code") != 0:
                    return {"__error": str(answer.get("message", ""))[:200]}
                data = answer.get("data")
                return data if isinstance(data, dict) else {}
        raise UpstreamError("protocol")


def clean_text(value, limit):
    """A short single-line string, or None."""
    if not isinstance(value, str):
        return None
    text = re.sub(r"[\x00-\x1f\x7f]", " ", value).strip()[:limit]
    return text or None


def clean_qr_url(value):
    """The QR link is an https URL on a qq.com host; anything else is dropped."""
    if not isinstance(value, str) or len(value) > 600:
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    host = parts.hostname or ""
    if parts.scheme != "https" or not (host == "qq.com" or host.endswith(".qq.com")) or not value.isprintable() or " " in value:
        return None
    return value


def shape(check, info):
    """The answer the event service gets, built from NapCat's CheckLoginStatus and GetQQLoginInfo data."""
    phase = check.get("loginPhase")
    phase = phase if phase in PHASES else None
    qr = clean_qr_url(check.get("qrcodeurl"))
    if check.get("isLogin") is True:
        login = "online"
    elif check.get("isOffline") is True:
        login = "offline"
    elif phase == "qrcode_scanned":
        login = "scanned"
    elif phase == "initializing":
        login = "logging-in"
    elif phase == "reconnecting":
        login = "restarting"
    elif phase in ("waiting_qrcode", "generating_qrcode"):
        login = "qr" if qr is not None else "preparing"
    else:
        login = "unknown"
    uin = info.get("uin")
    uin = str(uin) if isinstance(uin, (str, int)) and re.fullmatch(r"[0-9]{1,20}", str(uin)) else None
    return {
        "v": 1,
        "napcat": "up",
        "login": login,
        "phase": phase,
        "uin": uin if login in ("online", "offline") else None,
        "nickname": clean_text(info.get("nick"), 64) if login in ("online", "offline") else None,
        "qrUrl": qr if login == "qr" else None,
        "error": clean_text(check.get("loginError"), 200),
        "at": int(time.time() * 1000),
    }


class Door:
    def __init__(self, upstream):
        self.upstream = upstream
        self._cached = None
        self._cached_at = 0.0
        self._last_refresh = 0.0
        self._lock = threading.Lock()
        self._last_state = None
        self._auth_logged = 0.0
        self._online_since = None

    def _note(self, state):
        if state != self._last_state:
            log(f"state: {self._last_state or 'start'} -> {state}")
            self._last_state = state

    def status(self, fresh=False):
        with self._lock:
            ttl = CACHE_ONLINE_S if self._cached is not None and self._cached.get("login") == "online" else CACHE_S
            if not fresh and self._cached is not None and time.time() - self._cached_at < ttl:
                return self._cached
            try:
                check = self.upstream.call("POST", "/QQLogin/CheckLoginStatus", {})
                info = self.upstream.call("POST", "/QQLogin/GetQQLoginInfo", {}) if check.get("isLogin") is True or check.get("isOffline") is True else {}
                body = shape(check, info)
                if body["login"] == "online" and (self._cached or {}).get("login") != "online":
                    self._online_since = time.time()
                self._note(f"napcat up, login {body['login']}")
            except UpstreamError as error:
                body = {"v": 1, "napcat": "down", "reason": error.kind, "at": int(time.time() * 1000)}
                self._note(f"napcat down ({error.kind})")
            self._cached, self._cached_at = body, time.time()
            return body

    def refresh(self):
        """Ask NapCat for a new code, unless QQ is logged in or just was, or a code was asked for a moment ago."""
        current = self.status()
        reason = None
        if current.get("napcat") != "up":
            reason = "unreachable"
        elif current.get("login") == "online":
            reason = "logged-in"
        elif self._online_since is not None and time.time() - self._online_since < RECENT_LOGIN_S:
            reason = "recently-logged-in"
        else:
            with self._lock:
                if time.time() - self._last_refresh < REFRESH_GAP_S:
                    reason = "too-soon"
                else:
                    self._last_refresh = time.time()
        refreshed = False
        if reason is None:
            try:
                answer = self.upstream.call("POST", "/QQLogin/RefreshQRcode", {})
                refreshed = "__error" not in answer
                if not refreshed:
                    reason = "napcat-refused"
                log("QR refresh requested" + ("" if refreshed else " (NapCat refused)"))
            except UpstreamError as error:
                reason = "unreachable"
                log(f"QR refresh failed ({error.kind})")
        else:
            log(f"QR refresh not asked: {reason}")
        body = dict(self.status(fresh=True) if refreshed else current)
        body["refreshed"] = refreshed
        if reason is not None:
            body["reason"] = reason
        return body

    def auth_failed(self):
        """Log a refused caller at most once a minute."""
        if time.time() - self._auth_logged > 60:
            self._auth_logged = time.time()
            log("a request was refused (bad or missing token)")


def make_handler(door):
    class Handler(BaseHTTPRequestHandler):
        server_version = "login-door"
        sys_version = ""

        def log_message(self, *_args):
            pass

        def _send(self, code, body):
            payload = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _authorized(self):
            expected = read_secret("onebot11.json", "network", "websocketServers", 0, "token")
            if expected is None:
                self._send(503, {"error": "the door has no token to check against"})
                return False
            header = self.headers.get("authorization", "")
            given = header[7:] if header.lower().startswith("bearer ") else ""
            if not hmac.compare_digest(given.encode(), expected.encode()):
                door.auth_failed()
                self._send(401, {"error": "unauthorized"})
                return False
            return True

        def do_GET(self):
            if self.path != "/v1/login":
                return self._send(404, {"error": "not found"})
            if self._authorized():
                self._send(200, door.status())

        def do_POST(self):
            if self.path != "/v1/login/refresh":
                return self._send(404, {"error": "not found"})
            if self._authorized():
                self._send(200, door.refresh())

        def do_PUT(self):
            self._send(405, {"error": "method not allowed"})

        do_DELETE = do_PATCH = do_PUT

    return Handler


class DoorServer(ThreadingHTTPServer):
    """The door's listener, binding without resolving its own host name.

    HTTPServer.server_bind asks socket.getfqdn() for server_name, and that call blocks for tens of seconds where
    reverse DNS is slow or absent (a macOS CI runner does it), during which the door looks like it never started.
    Nothing here uses server_name: the door answers on the address it bound.
    """

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port


def main():
    server = DoorServer((BIND, PORT), make_handler(Door(Upstream())))
    log(f"listening on {BIND}:{PORT}, NapCat at {UPSTREAM}")
    server.serve_forever()


if __name__ == "__main__":
    main()
