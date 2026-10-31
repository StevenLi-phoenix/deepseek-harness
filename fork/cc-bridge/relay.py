#!/usr/bin/env python3
"""dsh-cc-bridge relay: lets the DSH event agent and Claude Code sessions on this Mac talk.

Claude Code sessions listen on 0600 unix sockets owned by the owner's account, so the DSH service
user (`dsh-runtime`) cannot reach them. This relay runs as the owner and sits between the two:

  Claude Code sessions  <-- cc-peer protocol -->  relay  <-- JSON lines -->  DSH (dsh-runtime)

  * Inbox socket (0600, state dir 0700): Claude Code sessions send to it with their native
    SendMessage tool (`uds:<path>`), and it shows up in their ListAgents as the peer `dsh`.
  * DSH socket (0600 + an ACL entry for `dsh-runtime`, in a 0700 directory): the DSH plugin lists
    sessions, sends to one, and receives what sessions sent.

Every connection is checked with LOCAL_PEERCRED / LOCAL_PEERPID. Inbound senders are identified by
the pid of the connecting process (matched against the session registry), never by what the
message says about itself. Messages in both directions are untrusted data: the text only carries
a label saying who sent it, and nothing here confers the owner's authority on either side.

The wire format of Claude Code's peer messages is internal and versioned by its `peerProtocol`
field. Everything that depends on it lives in the `cc-wire` section below; `--self-test` and the
relay's own log lines tell when a Claude Code update changed it.

Standard library only, Python 3.9+.
"""

import argparse
import asyncio
import json
import logging
import os
import pwd
import re
import signal
import socket
import subprocess
import sys
import time
import uuid
from collections import deque
from typing import Any, Callable, Deque, Dict, List, Optional, Set, Tuple

VERSION = '0.1.0'
LOG = logging.getLogger('dsh-cc-bridge')

LINE_LIMIT = 1 << 20  # Claude Code drops a connection whose line exceeds 1 MiB.
FIRST_LINE_DEADLINE = 5.0
CONNECT_TIMEOUT = 5.0
DEFAULT_MAX_TEXT = 8000
LOCAL_PEERCRED = 0x001
LOCAL_PEERPID = 0x002
SOL_LOCAL = 0

# ---------------------------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------------------------


def now_ms() -> int:
    return int(time.time() * 1000)


def preview(text: str, n: int = 60) -> str:
    flat = ' '.join(text.split())
    return flat if len(flat) <= n else flat[:n] + '...'


def peer_cred(sock: Any) -> Tuple[Optional[int], Optional[int]]:
    """(uid, pid) of the process on the other end of a connected unix socket, None where unknown."""
    uid = None
    pid = None
    try:
        raw = sock.getsockopt(SOL_LOCAL, LOCAL_PEERCRED, 76)
        uid = int.from_bytes(raw[4:8], sys.byteorder)  # struct xucred: cr_version, cr_uid, ...
    except OSError:
        pass
    try:
        pid = sock.getsockopt(SOL_LOCAL, LOCAL_PEERPID)
    except OSError:
        pass
    return uid, pid


def process_start(pid: int) -> Optional[str]:
    """Claude Code's own liveness token: `ps -o lstart=` under LC_ALL=C TZ=UTC."""
    try:
        out = subprocess.run(['ps', '-o', 'lstart=', '-p', str(pid)], capture_output=True, text=True, timeout=2,
                             env={'PATH': '/bin:/usr/bin', 'LC_ALL': 'C', 'TZ': 'UTC'})
    except (OSError, subprocess.SubprocessError):
        return None
    text = out.stdout.strip()
    return text if out.returncode == 0 and text else None


class TokenBucket:
    """`capacity` events at once, refilled evenly over `per` seconds."""

    def __init__(self, capacity: int, per: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.capacity = float(capacity)
        self.rate = capacity / per
        self.tokens = float(capacity)
        self.clock = clock
        self.at = clock()

    def take(self) -> bool:
        now = self.clock()
        self.tokens = min(self.capacity, self.tokens + (now - self.at) * self.rate)
        self.at = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False


class KeyedLimiter:
    """One bucket per key (a session pid), pruned when idle so the table stays small."""

    def __init__(self, capacity: int, per: float, clock: Callable[[], float] = time.monotonic, max_keys: int = 256) -> None:
        self.capacity, self.per, self.clock, self.max_keys = capacity, per, clock, max_keys
        self.buckets: Dict[str, TokenBucket] = {}

    def take(self, key: str) -> bool:
        bucket = self.buckets.get(key)
        if bucket is None:
            if len(self.buckets) >= self.max_keys:
                self.buckets.pop(next(iter(self.buckets)))
            bucket = self.buckets[key] = TokenBucket(self.capacity, self.per, self.clock)
        return bucket.take()


# ---------------------------------------------------------------------------------------------
# cc-wire: everything that depends on Claude Code's internal peer protocol (peerProtocol 1)
# ---------------------------------------------------------------------------------------------

TAG = 'cross-session-message'
_ADDR = r'A-Za-z0-9%:_/.\\-'
_WRAPPER = re.compile(
    r'^<' + TAG + r'(?: from="([' + _ADDR + r']+)")?(?: from-session="([A-Za-z0-9_-]{1,80})")?'
    r'(?: hop-chain="([0-9a-f]{24}(?:,[0-9a-f]{24}){0,31})")?(?: from-name="([^"<>\n\r]+)")?'
    r'(?: from-mode="(bypass|prompting)")?(?: from-plugin="([^"<>\n\r]+)")?>\n([\s\S]*)\n</' + TAG + r'>$')


def encode_address(path: str) -> str:
    return 'uds:' + re.sub(r'[^A-Za-z0-9:_/.\\-]', lambda m: ''.join('%%%02X' % b for b in m.group(0).encode()), path)


def clean_attr(value: str) -> str:
    return ' '.join(re.sub(r'["<>]', '', value).split())[:64]


def escape_body(text: str) -> str:
    """Defang a closing tag inside the body the way Claude Code does (`</tag` becomes `<\\/tag`)."""
    return re.sub(r'(?i)<(/\s*' + TAG + ')', lambda m: '<\\' + m.group(1), text)


def wrap_message(text: str, from_address: str, from_name: str, mode: str = 'prompting') -> str:
    attrs = 'from="%s" from-name="%s" from-mode="%s"' % (from_address, clean_attr(from_name), mode)
    return '<%s %s>\n%s\n</%s>' % (TAG, attrs, escape_body(text), TAG)


def parse_wrapper(content: str) -> Optional[Dict[str, Any]]:
    m = _WRAPPER.match(content)
    if m is None:
        return None
    return {'from': m.group(1), 'fromSession': m.group(2), 'hopChain': m.group(3), 'fromName': m.group(4),
            'fromMode': m.group(5), 'fromPlugin': m.group(6), 'body': m.group(7)}


def build_frame(text: str, from_address: str, from_name: str, mode: str = 'prompting') -> Dict[str, Any]:
    return {'msgV': 1, 'msg_id': str(uuid.uuid4()), 'type': 'user',
            'message': {'role': 'user', 'content': wrap_message(text, from_address, from_name, mode)},
            'priority': 'next', 'from': from_address}


def key_path(sessions_dir: str, pid: int, socket_path: str) -> str:
    import hashlib
    return os.path.join(sessions_dir, '%d.%s.key' % (pid, hashlib.sha256(socket_path.encode()).hexdigest()))


def read_peer_token(sessions_dir: str, pid: int, socket_path: str) -> Optional[str]:
    try:
        with open(key_path(sessions_dir, pid, socket_path), 'r') as fh:
            token = json.load(fh).get('peerToken')
    except (OSError, ValueError, AttributeError):
        return None
    return token if isinstance(token, str) and re.fullmatch(r'[0-9a-f]{32}', token) else None


# ---------------------------------------------------------------------------------------------
# session registry
# ---------------------------------------------------------------------------------------------

LISTABLE_KINDS = ('interactive', 'bg')


class Registry:
    """The live Claude Code sessions on this Mac, from `~/.claude/sessions/<pid>.json`."""

    def __init__(self, sessions_dir: str, own_pid: int, ttl: float = 15.0,
                 clock: Callable[[], float] = time.monotonic,
                 start_of: Callable[[int], Optional[str]] = process_start) -> None:
        self.dir, self.own_pid, self.ttl, self.clock, self.start_of = sessions_dir, own_pid, ttl, clock, start_of
        self.cache: List[Dict[str, Any]] = []
        self.loaded = -1e9

    def _read(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        try:
            names = os.listdir(self.dir)
        except OSError as e:
            LOG.warning('session registry unreadable: %s', e)
            return out
        for name in names:
            m = re.fullmatch(r'(\d+)\.json', name)
            if m is None:
                continue
            pid = int(m.group(1))
            if pid == self.own_pid:
                continue
            try:
                with open(os.path.join(self.dir, name), 'r') as fh:
                    rec = json.load(fh)
            except (OSError, ValueError):
                continue
            if not isinstance(rec, dict) or rec.get('pid') != pid or not isinstance(rec.get('messagingSocketPath'), str):
                continue
            if rec.get('kind') not in LISTABLE_KINDS or rec.get('spare') is True:
                continue
            if rec.get('dshBridge') is True:
                continue
            start = self.start_of(pid)
            if start is None or rec.get('procStart') != start:
                continue
            out.append(rec)
        return out

    def sessions(self, refresh: bool = False) -> List[Dict[str, Any]]:
        if refresh or self.clock() - self.loaded > self.ttl:
            self.cache = self._read()
            self.loaded = self.clock()
        return self.cache

    def by_pid(self, pid: Optional[int]) -> Optional[Dict[str, Any]]:
        if pid is None:
            return None
        for rec in self.sessions():
            if rec['pid'] == pid:
                return rec
        for rec in self.sessions(refresh=True):
            if rec['pid'] == pid:
                return rec
        return None

    def resolve(self, selector: str) -> Tuple[Optional[Dict[str, Any]], str]:
        """One session for a name, `pid`, or session id prefix; otherwise why not."""
        sel = selector.strip()
        if not sel:
            return None, 'name the session to send to (see cc_list_sessions)'
        recs = self.sessions(refresh=True)
        low = sel.lower()
        hits = [r for r in recs if str(r.get('name', '')).lower() == low]
        if not hits and re.fullmatch(r'(?:pid:)?\d+', low):
            hits = [r for r in recs if r['pid'] == int(low.replace('pid:', ''))]
        if not hits and len(low) >= 6:
            hits = [r for r in recs if str(r.get('sessionId', '')).lower().startswith(low)]
        if len(hits) == 1:
            return hits[0], ''
        if not hits:
            return None, 'no live Claude Code session matches "%s"' % sel
        return None, '"%s" matches %d sessions (%s); use the pid' % (
            sel, len(hits), ', '.join('%s pid %d' % (r.get('name', '?'), r['pid']) for r in hits))


def public_view(rec: Dict[str, Any]) -> Dict[str, Any]:
    """What DSH may know about a session: no socket path, no tokens, no bridge ids."""
    view = {'name': rec.get('name') or os.path.basename(str(rec.get('cwd', '?'))), 'pid': rec['pid'],
            'sessionId': rec.get('sessionId'), 'cwd': rec.get('cwd'), 'kind': rec.get('kind'),
            'status': rec.get('status'), 'entrypoint': rec.get('entrypoint'), 'version': rec.get('version'),
            'startedAt': rec.get('startedAt'), 'updatedAt': rec.get('updatedAt'), 'tmux': rec.get('tmux')}
    return {k: v for k, v in view.items() if v is not None}


# ---------------------------------------------------------------------------------------------
# peer record: how Claude Code's ListAgents finds this relay
# ---------------------------------------------------------------------------------------------


def write_peer_record(sessions_dir: str, pid: int, name: str, socket_path: str, session_id: str,
                      start: Optional[str]) -> Optional[str]:
    if start is None:
        return None
    path = os.path.join(sessions_dir, '%d.json' % pid)
    stamp = now_ms()
    rec = {'pid': pid, 'sessionId': session_id, 'cwd': '/', 'startedAt': stamp, 'procStart': start,
           'peerProtocol': 1, 'peerFeatures': [], 'kind': 'daemon', 'entrypoint': 'dsh-cc-bridge', 'pidDomain': 'darwin',
           'messagingSocketPath': socket_path, 'name': name, 'nameSource': 'user', 'nameSince': stamp,
           'status': 'idle', 'updatedAt': stamp, 'statusUpdatedAt': stamp, 'dshBridge': True}
    tmp = '%s.tmp.%d' % (path, pid)
    with open(tmp, 'w') as fh:
        json.dump(rec, fh)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    return path


def sweep_peer_records(sessions_dir: str, keep_pid: int) -> None:
    """Remove records an earlier relay run left behind (its pid is gone)."""
    try:
        names = os.listdir(sessions_dir)
    except OSError:
        return
    for name in names:
        m = re.fullmatch(r'(\d+)\.json', name)
        if m is None or int(m.group(1)) == keep_pid:
            continue
        path = os.path.join(sessions_dir, name)
        try:
            with open(path, 'r') as fh:
                rec = json.load(fh)
            if rec.get('dshBridge') is True:
                os.kill(int(m.group(1)), 0)
        except ProcessLookupError:
            try:
                os.unlink(path)
                LOG.info('removed the peer record of a dead relay: %s', name)
            except OSError:
                pass
        except (OSError, ValueError):
            pass


# ---------------------------------------------------------------------------------------------
# the relay
# ---------------------------------------------------------------------------------------------


class Config:
    def __init__(self, **kw: Any) -> None:
        home = os.path.expanduser('~')
        self.state_dir = kw.get('state_dir') or os.path.join(home, '.local/state/dsh-cc-bridge')
        self.sessions_dir = kw.get('sessions_dir') or os.path.join(home, '.claude/sessions')
        self.inbox_socket = kw.get('inbox_socket') or os.path.join(self.state_dir, 'cc.sock')
        self.dsh_dir = kw.get('dsh_dir') or '/Users/Shared/dsh-cc-bridge'
        self.dsh_socket = kw.get('dsh_socket') or os.path.join(self.dsh_dir, 'dsh.sock')
        self.dsh_user = kw.get('dsh_user', 'dsh-runtime')
        self.allowed_uids: Set[int] = set(kw.get('allowed_uids') or [])
        self.peer_name = kw.get('peer_name') or 'dsh'
        self.register = kw.get('register', True)
        self.max_text = kw.get('max_text') or DEFAULT_MAX_TEXT
        self.send_per_min = kw.get('send_per_min') or 6      # per target session
        self.send_total_per_min = kw.get('send_total_per_min') or 20
        self.inbound_per_min = kw.get('inbound_per_min') or 6  # per sending session
        self.inbound_total_per_min = kw.get('inbound_total_per_min') or 30
        self.pending_max = kw.get('pending_max') or 100
        self.pending_ttl = kw.get('pending_ttl') or 3600.0
        self.targets: Optional[List[str]] = kw.get('targets')  # lower-case names DSH may message; None = any


class Relay:
    def __init__(self, cfg: Config, registry: Optional[Registry] = None, clock: Callable[[], float] = time.monotonic,
                 cred: Callable[[Any], Tuple[Optional[int], Optional[int]]] = peer_cred) -> None:
        self.cfg = cfg
        self.registry = registry or Registry(cfg.sessions_dir, os.getpid())
        self.clock = clock
        self.cred = cred
        self.own_uid = os.getuid()
        self.clients: Set['asyncio.StreamWriter'] = set()
        self.pending: Deque[Dict[str, Any]] = deque()
        self.send_by_target = KeyedLimiter(cfg.send_per_min, 60.0, clock)
        self.send_total = TokenBucket(cfg.send_total_per_min, 60.0, clock)
        self.in_by_sender = KeyedLimiter(cfg.inbound_per_min, 60.0, clock)
        self.in_total = TokenBucket(cfg.inbound_total_per_min, 60.0, clock)
        self.notice_limiter = KeyedLimiter(1, 60.0, clock)
        self.servers: List[Any] = []
        self.peer_record: Optional[str] = None
        self.stats = {'sent': 0, 'received': 0, 'dropped_in': 0, 'refused_out': 0}

    # -- startup / shutdown ------------------------------------------------------------------

    @staticmethod
    def _private_dir(path: str) -> None:
        if os.path.islink(path):
            raise RuntimeError('%s is a symlink' % path)
        os.makedirs(path, mode=0o700, exist_ok=True)
        st = os.stat(path)
        if st.st_uid != os.getuid():
            raise RuntimeError('%s is not owned by this user' % path)
        os.chmod(path, 0o700)

    @staticmethod
    def _unlink_stale(path: str) -> None:
        if not os.path.lexists(path):
            return
        probe = socket.socket(socket.AF_UNIX)
        probe.settimeout(0.5)
        try:
            probe.connect(path)
        except (ConnectionRefusedError, FileNotFoundError):
            os.unlink(path)
            return
        except OSError:
            os.unlink(path)
            return
        finally:
            probe.close()
        raise RuntimeError('another relay is already listening on %s' % path)

    def _grant_dsh_user(self, *paths: str) -> bool:
        """Let the DSH service user in without opening anything to the group or the world."""
        user = self.cfg.dsh_user
        if not user:
            return False
        try:
            pwd.getpwnam(user)
        except KeyError:
            LOG.warning('user %s does not exist; the DSH socket is reachable by %d only', user, self.own_uid)
            return False
        for path in paths:
            perm = 'search' if os.path.isdir(path) else 'read,write'
            subprocess.run(['/bin/chmod', '-N', path], check=False, capture_output=True)
            res = subprocess.run(['/bin/chmod', '+a', 'user:%s allow %s' % (user, perm), path], capture_output=True, text=True)
            if res.returncode != 0:
                LOG.error('could not grant %s access to %s: %s', user, path, res.stderr.strip())
                return False
        return True

    async def start(self) -> None:
        os.umask(0o077)
        self._private_dir(self.cfg.state_dir)
        self._private_dir(os.path.dirname(self.cfg.inbox_socket))
        self._private_dir(self.cfg.dsh_dir)
        allowed = {self.own_uid}
        if self.cfg.dsh_user:
            try:
                allowed.add(pwd.getpwnam(self.cfg.dsh_user).pw_uid)
            except KeyError:
                pass
        allowed |= self.cfg.allowed_uids
        self.cfg.allowed_uids = allowed

        self._unlink_stale(self.cfg.inbox_socket)
        self.servers.append(await asyncio.start_unix_server(self._on_inbox, path=self.cfg.inbox_socket, limit=LINE_LIMIT + 4096))
        os.chmod(self.cfg.inbox_socket, 0o600)

        self._unlink_stale(self.cfg.dsh_socket)
        self.servers.append(await asyncio.start_unix_server(self._on_dsh, path=self.cfg.dsh_socket, limit=LINE_LIMIT + 4096))
        os.chmod(self.cfg.dsh_socket, 0o600)
        if self.cfg.dsh_user and not self._grant_dsh_user(self.cfg.dsh_dir, self.cfg.dsh_socket):
            LOG.warning('DSH socket access for %s was not granted', self.cfg.dsh_user)

        if self.cfg.register:
            pid = os.getpid()
            sweep_peer_records(self.cfg.sessions_dir, pid)
            try:
                self.peer_record = write_peer_record(self.cfg.sessions_dir, pid, self.cfg.peer_name, self.cfg.inbox_socket,
                                                     str(uuid.uuid4()), process_start(pid))
            except OSError as e:
                LOG.warning('peer record not written, ListAgents will not list "%s": %s', self.cfg.peer_name, e)
            LOG.info('peer record: %s', self.peer_record)
        LOG.info('relay %s up: inbox=%s dsh=%s allowed uids=%s targets=%s', VERSION, self.cfg.inbox_socket,
                 self.cfg.dsh_socket, sorted(self.cfg.allowed_uids), self.cfg.targets or 'any')

    async def stop(self) -> None:
        for server in self.servers:
            server.close()
        for w in list(self.clients):
            w.close()
        for path in (self.cfg.inbox_socket, self.cfg.dsh_socket, self.peer_record):
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
        LOG.info('relay stopped (%s)', self.stats)

    # -- Claude Code -> DSH ------------------------------------------------------------------

    async def _on_inbox(self, reader: 'asyncio.StreamReader', writer: 'asyncio.StreamWriter') -> None:
        sock = writer.get_extra_info('socket')
        uid, pid = self.cred(sock)
        try:
            if uid != self.own_uid:
                LOG.warning('inbox: refused a connection from uid %s (pid %s)', uid, pid)
                return
            first = True
            while True:
                try:
                    line = await asyncio.wait_for(reader.readline(), FIRST_LINE_DEADLINE if first else 30.0)
                except asyncio.TimeoutError:
                    LOG.info('inbox: closed a silent connection from pid %s', pid)
                    return
                except (ValueError, asyncio.LimitOverrunError):
                    LOG.warning('inbox: line over %d chars from pid %s, dropped the connection', LINE_LIMIT, pid)
                    return
                first = False
                if not line:
                    return
                await self._on_inbox_line(line, pid)
        except (ConnectionError, OSError) as e:
            LOG.debug('inbox: connection from pid %s ended: %s', pid, e)
        finally:
            writer.close()

    async def _on_inbox_line(self, line: bytes, pid: Optional[int]) -> None:
        try:
            frame = json.loads(line)
        except ValueError:
            LOG.warning('inbox: unparseable line from pid %s (%d bytes)', pid, len(line))
            return
        kind = frame.get('type') if isinstance(frame, dict) else None
        if kind == 'auth':
            return  # the registry's uid check is the boundary; no key is published for this inbox
        if kind == 'control':
            LOG.info('inbox: control frame from pid %s: action=%s status=%s reason=%s', pid, frame.get('action'),
                     frame.get('status'), frame.get('reason') or frame.get('drop_reason'))
            self._broadcast({'event': 'status', 'at': now_ms(), 'pid': pid, 'action': frame.get('action'),
                             'status': frame.get('status'), 'reason': frame.get('reason') or frame.get('drop_reason')})
            return
        if kind != 'user':
            LOG.info('inbox: ignored frame type %r from pid %s', kind, pid)
            return
        content = (frame.get('message') or {}).get('content')
        if not isinstance(content, str):
            LOG.info('inbox: user frame without text content from pid %s', pid)
            return
        rec = self.registry.by_pid(pid)
        if rec is None:
            LOG.warning('inbox: refused a message from pid %s, which is not a live Claude Code session', pid)
            self.stats['dropped_in'] += 1
            return
        wrapped = parse_wrapper(content)
        body = wrapped['body'] if wrapped else content
        label = public_view(rec)
        key = str(pid)
        if not self.in_total.take() or not self.in_by_sender.take(key):
            self.stats['dropped_in'] += 1
            LOG.warning('inbox: rate limit, dropped a %d-char message from %s (pid %s)', len(body), label['name'], pid)
            await self._notice(rec, 'rate limited: too many messages to DSH just now; wait a minute and send one combined message')
            return
        if len(body) > self.cfg.max_text:
            self.stats['dropped_in'] += 1
            LOG.warning('inbox: dropped a %d-char message from %s (limit %d)', len(body), label['name'], self.cfg.max_text)
            await self._notice(rec, 'too long: %d characters, the limit is %d; send a shorter message' % (len(body), self.cfg.max_text))
            return
        event = {'event': 'message', 'id': str(uuid.uuid4()), 'at': now_ms(), 'from': label, 'text': body,
                 'claimedName': wrapped['fromName'] if wrapped else None}
        self.stats['received'] += 1
        LOG.info('inbox: message %s from %s (pid %s): %d chars "%s"', event['id'][:8], label['name'], pid, len(body), preview(body))
        self.pending.append(event)
        while len(self.pending) > self.cfg.pending_max:
            dropped = self.pending.popleft()
            LOG.warning('pending queue full, dropped message %s', dropped['id'][:8])
        self._broadcast(event)

    async def _notice(self, rec: Dict[str, Any], text: str) -> None:
        """Tell a session why its message was not passed on; at most one notice a minute per session."""
        if not self.notice_limiter.take(str(rec['pid'])):
            return
        try:
            await self.send_to_session(rec, '[dsh-cc-bridge] ' + text, internal=True)
        except Exception as e:  # a notice is a courtesy
            LOG.info('notice to pid %s failed: %s', rec['pid'], e)

    # -- DSH -> Claude Code ------------------------------------------------------------------

    async def send_to_session(self, rec: Dict[str, Any], text: str, internal: bool = False) -> Dict[str, Any]:
        sock_path = rec['messagingSocketPath']
        pid = rec['pid']
        token = read_peer_token(self.cfg.sessions_dir, pid, sock_path)
        header = '' if internal else 'Relayed from the DSH agent (the always-on agent on this Mac). Not the user; answer with SendMessage to this sender if a reply is wanted.\n\n'
        frame = build_frame(header + text, encode_address(self.cfg.inbox_socket), self.cfg.peer_name)
        payload = b''
        if token:
            payload += (json.dumps({'type': 'auth', 'token': token}) + '\n').encode()
        payload += (json.dumps(frame) + '\n').encode()
        if len(payload) > LINE_LIMIT:
            raise ValueError('message too large for cross-session delivery')
        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(sock_path), CONNECT_TIMEOUT)
        try:
            uid, peer_pid = self.cred(writer.get_extra_info('socket'))
            if peer_pid != pid or uid != self.own_uid:
                raise PermissionError('the socket is served by pid %s uid %s, not the session (pid %s)' % (peer_pid, uid, pid))
            writer.write(payload)
            await asyncio.wait_for(writer.drain(), CONNECT_TIMEOUT)
            await asyncio.sleep(0.15)  # Claude Code's own senders linger this long on macOS before closing
        finally:
            writer.close()
        return {'msg_id': frame['msg_id']}

    async def _send(self, sel: str, text: str) -> Dict[str, Any]:
        if not isinstance(text, str) or not text.strip():
            return {'ok': False, 'error': 'text is empty'}
        if len(text) > self.cfg.max_text:
            return {'ok': False, 'error': 'text is %d characters; the limit is %d. Send the essentials and offer details on request.' % (len(text), self.cfg.max_text)}
        rec, why = self.registry.resolve(sel)
        if rec is None:
            return {'ok': False, 'error': why}
        name = public_view(rec)['name']
        if self.cfg.targets is not None and name.lower() not in self.cfg.targets:
            self.stats['refused_out'] += 1
            LOG.warning('send: refused, %s is not in the allowed targets', name)
            return {'ok': False, 'error': 'DSH is not allowed to message the session "%s"' % name}
        if not self.send_total.take() or not self.send_by_target.take(str(rec['pid'])):
            self.stats['refused_out'] += 1
            LOG.warning('send: rate limit for %s (pid %s)', name, rec['pid'])
            return {'ok': False, 'error': 'rate limit: too many messages to %s just now; batch them into one and wait a minute' % name}
        try:
            result = await self.send_to_session(rec, text)
        except Exception as e:
            self.stats['refused_out'] += 1
            LOG.warning('send: to %s (pid %s) failed: %s: %s', name, rec['pid'], type(e).__name__, e)
            return {'ok': False, 'error': 'could not deliver to %s: %s' % (name, e)}
        self.stats['sent'] += 1
        LOG.info('send: %s (pid %s) <- %d chars "%s" msg %s', name, rec['pid'], len(text), preview(text), result['msg_id'][:8])
        return {'ok': True, 'to': public_view(rec), 'msg_id': result['msg_id']}

    # -- DSH-facing server -------------------------------------------------------------------

    def _broadcast(self, event: Dict[str, Any]) -> None:
        data = (json.dumps(event) + '\n').encode()
        for w in list(self.clients):
            try:
                w.write(data)
            except Exception:
                self.clients.discard(w)

    async def _on_dsh(self, reader: 'asyncio.StreamReader', writer: 'asyncio.StreamWriter') -> None:
        sock = writer.get_extra_info('socket')
        uid, pid = self.cred(sock)
        if uid not in self.cfg.allowed_uids:
            LOG.warning('dsh: refused a connection from uid %s (pid %s)', uid, pid)
            writer.close()
            return
        LOG.info('dsh: client connected (uid %s pid %s)', uid, pid)
        self.clients.add(writer)
        try:
            while True:
                try:
                    line = await reader.readline()
                except (ValueError, asyncio.LimitOverrunError):
                    LOG.warning('dsh: oversized line from pid %s, dropped the connection', pid)
                    return
                if not line:
                    return
                try:
                    req = json.loads(line)
                    if not isinstance(req, dict):
                        raise ValueError('not an object')
                except ValueError:
                    writer.write(b'{"ok":false,"error":"bad json"}\n')
                    continue
                resp = await self._handle(req, writer)
                if resp is not None:
                    resp['id'] = req.get('id')
                    writer.write((json.dumps(resp) + '\n').encode())
                    await writer.drain()
        except (ConnectionError, OSError) as e:
            LOG.debug('dsh: connection ended: %s', e)
        finally:
            self.clients.discard(writer)
            writer.close()
            LOG.info('dsh: client disconnected (pid %s)', pid)

    async def _handle(self, req: Dict[str, Any], writer: 'asyncio.StreamWriter') -> Optional[Dict[str, Any]]:
        op = req.get('op')
        if op == 'hello':
            self._expire_pending()
            for event in list(self.pending):  # at-least-once: whatever was never acknowledged goes out again
                writer.write((json.dumps(event) + '\n').encode())
            return {'ok': True, 'version': VERSION, 'name': self.cfg.peer_name, 'maxText': self.cfg.max_text,
                    'targets': self.cfg.targets, 'pending': len(self.pending)}
        if op == 'list':
            recs = self.registry.sessions(refresh=True)
            return {'ok': True, 'sessions': [public_view(r) for r in sorted(recs, key=lambda r: -(r.get('updatedAt') or 0))]}
        if op == 'send':
            return await self._send(str(req.get('to', '')), req.get('text'))
        if op == 'ack':
            ids = set(i for i in (req.get('ids') or []) if isinstance(i, str))
            self.pending = deque(e for e in self.pending if e['id'] not in ids)
            return {'ok': True, 'pending': len(self.pending)}
        if op == 'stats':
            return {'ok': True, 'stats': dict(self.stats), 'pending': len(self.pending), 'clients': len(self.clients)}
        return {'ok': False, 'error': 'unknown op'}

    def _expire_pending(self) -> None:
        cutoff = now_ms() - int(self.cfg.pending_ttl * 1000)
        while self.pending and self.pending[0]['at'] < cutoff:
            self.pending.popleft()


# ---------------------------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------------------------


def parse_args(argv: Optional[List[str]] = None) -> Config:
    p = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    p.add_argument('--state-dir')
    p.add_argument('--sessions-dir')
    p.add_argument('--inbox-socket')
    p.add_argument('--dsh-dir')
    p.add_argument('--dsh-socket')
    p.add_argument('--dsh-user', default=os.environ.get('DSH_CC_BRIDGE_DSH_USER', 'dsh-runtime'))
    p.add_argument('--name', dest='peer_name', default=os.environ.get('DSH_CC_BRIDGE_NAME', 'dsh'))
    p.add_argument('--no-register', dest='register', action='store_false', help='do not write the peer record ListAgents reads')
    p.add_argument('--targets', default=os.environ.get('DSH_CC_BRIDGE_TARGETS'),
                   help='comma-separated session names DSH may message (default: any)')
    p.add_argument('--max-text', type=int, default=DEFAULT_MAX_TEXT)
    p.add_argument('--verbose', action='store_true')
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, stream=sys.stderr,
                        format='%(asctime)s %(levelname)s %(message)s')
    targets = [t.strip().lower() for t in a.targets.split(',') if t.strip()] if a.targets else None
    return Config(state_dir=a.state_dir, sessions_dir=a.sessions_dir, inbox_socket=a.inbox_socket, dsh_dir=a.dsh_dir,
                  dsh_socket=a.dsh_socket, dsh_user=a.dsh_user, peer_name=a.peer_name, register=a.register,
                  max_text=a.max_text, targets=targets)


async def amain(cfg: Config) -> None:
    relay = Relay(cfg)
    await relay.start()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    await relay.stop()


def main(argv: Optional[List[str]] = None) -> None:
    cfg = parse_args(argv)
    asyncio.run(amain(cfg))


if __name__ == '__main__':
    main()
