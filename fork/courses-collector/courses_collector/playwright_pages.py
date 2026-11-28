"""Stock Playwright capture; lazy optional dependency, no profile or sign-in automation."""
from __future__ import annotations

import re
import time
from urllib.parse import urlsplit

from .model import ReadError
from .pages import (PageCapture, PageLink, PageRow, approved_capture_course, checked_origin,
                    exact_landing, ready_marker, url_parts)

# All other resources, including images, arbitrary GET actions, cross-origin CDN assets,
# API calls, downloads and embedded pages, are intentionally not fetched by the renderer.
_STATIC = re.compile(r'/(?:d2l/(?:common|shared|ui|le/content|lp/(?:web|styles)|lms/(?:dropbox|quizzing|discussions|grades|news))|shared)/[A-Za-z0-9_./-]+\.(?:m?js|css|woff2?|ttf)\Z')
_COOKIE_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")
_COOKIE_VALUE = re.compile(r'[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*\Z')

# Capture facts only from the main content region, including open shadow roots. Exclude
# navigation except for pagination checks. Never click anything or load an extracted link.
_DOM_CAPTURE = r'''area => {
    function closest(node, selector) {
        for (let current = node; current; current = current.parentElement || current.getRootNode().host) {
            if (current.matches && current.matches(selector)) return current;
        }
        return null;
    }
    function visible(node) {
        if (!node.getClientRects().length || closest(node, '[hidden],[aria-hidden="true"],template,inert,[inert]')) return false;
        for (let current = node; current; current = current.parentElement || current.getRootNode().host) {
            const s = getComputedStyle(current);
            if (s.display === 'none' || s.visibility !== 'visible' || s.opacity === '0') return false;
        }
        return true;
    }
    function all(root, selector) {
        const result = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        for (let e = walker.nextNode(); e; e = walker.nextNode()) {
            if (e.matches(selector)) result.push(e);
            if (e.shadowRoot) result.push(...all(e.shadowRoot, selector));
        }
        return result;
    }
    const auth = all(document, 'input[type="password"]').some(visible);
    const main = all(document, 'main,[role="main"],#d2l_body_main,d2l-page-main').find(visible);
    if (!main || auth) return {main: Boolean(main), auth_required: auth};
    const nav = 'nav,[role="navigation"],footer,[role="contentinfo"],d2l-navigation';
    const inContent = e => visible(e) && !closest(e, nav);
    const text = e => (e.innerText || '').trim();
    const href = a => ({text: text(a), href: a.getAttribute('href') || ''});
    const rowSelector = 'tr,[role="row"],d2l-table-row';
    const cellSelector = 'th,td,[role="cell"],[role="gridcell"],[role="rowheader"],[role="columnheader"],d2l-table-cell';
    const rows = [];
    for (const e of all(main, rowSelector).filter(inContent)) {
        const cells = all(e, cellSelector).filter(c => closest(c, rowSelector) === e && inContent(c));
        if (!cells.length) continue;
        const header = cells.every(c => c.matches('th:not([scope="row"]),[role="columnheader"]'));
        rows.push({text: text(e), cells: cells.map(text), header,
            links: all(e, 'a[href]').filter(a => closest(a, rowSelector) === e && inContent(a)).map(href),
            grade_object_id: e.getAttribute('data-grade-object-id') || '', dom_id: e.id});
    }
    // Topics and announcements can be presented in headings/lists rather than tables.
    // Only snapshot title links, not peers' posts or the surrounding navigation shell.
    const extraLink = area === 'discussions' ? /\/discussions\/topics\/[0-9]+\/view\/?(?:[?#]|$)/i :
        area === 'announcements' ? /\/d2l\/le\/news\/[0-9]+\/[0-9]+\/view(?:[?#]|$)/ : null;
    if (extraLink) {
        const bodySelector = '.d2l-html-block-rendered';
        for (const link of all(main, 'a[href]').filter(a => inContent(a) && !closest(a, rowSelector) && !closest(a, bodySelector))) {
            if (!extraLink.test(link.getAttribute('href') || '')) continue;
            rows.push({text: text(link), cells: [], links: [href(link)], header: false});
        }
    }
    const notices = all(main, 'p,span,div,[role="status"],d2l-empty-state')
        .filter(e => inContent(e) && !closest(e, rowSelector) && e.children.length <= 1)
        .map(text).filter(t => t.length > 0 && t.length <= 120);
    const busy = main.matches('[aria-busy="true"]') ||
        all(main, '[aria-busy="true"],[role="progressbar"],d2l-loading-spinner').some(inContent) ||
        notices.some(t => /^loading(?:[. …]+)?$/i.test(t));
    const paginated = all(main, 'a,button,[role="button"],select,d2l-button,d2l-paging,d2l-pagination').some(n => {
        if (!visible(n) || closest(n, '[disabled],[aria-disabled="true"]')) return false;
        const name = (n.getAttribute('aria-label') || n.getAttribute('title') || text(n)).trim();
        if (n.getAttribute('rel') === 'next') return true;
        if (n.matches('select') && /page/i.test(name) && !/per page|page size/i.test(name) && n.options.length > 1) return true;
        return n.matches('d2l-paging,d2l-pagination') || /^(?:go to |show )?(?:next|previous)(?: page)?$/i.test(name) ||
            /^(?:load|show|view) more(?: items| results)?$/i.test(name);
    });
    const result = {url: location.href, main: true, auth_required: false, rows, notices, busy, paginated};
    if (area === 'announcement_detail') {
        const selector = '.d2l-html-block-rendered';
        const blocks = all(main, selector).filter(e => inContent(e) &&
            !closest(e.parentElement || e.getRootNode().host, selector));
        if (blocks.length === 1) {
            const block = blocks[0];
            // innerText preserves rendered paragraph breaks and excludes hidden text.
            // Rendered blocks in an open shadow root are discovered by the same walker.
            result.body = text(block);
            result.body_links = all(block, 'a[href]').filter(inContent).map(href);
        }
        result.headings = all(main, 'h1,h2,h3,[role="heading"]').filter(e => inContent(e) && !closest(e, selector)).map(text);
        const times = all(main, 'time[datetime]').filter(e => inContent(e) && !closest(e, selector));
        if (times.length === 1) result.announced_at = times[0].getAttribute('datetime');
    }
    if (area === 'content' || area === 'materials') {
        result.content_index = all(main, '[role="tree"],a[href]').some(e => inContent(e) &&
            (e.matches('[role="tree"]') || /\/d2l\/le\/content\/[0-9]+\/viewContent\/[0-9]+\/View/i.test(e.getAttribute('href') || '')));
    }
    return result;
}'''


def _make_capture(raw: dict, url: str, status: int) -> PageCapture:
    raw_rows, raw_notices = raw.get('rows', []), raw.get('notices', [])
    if len(raw_rows) > 1000 or len(raw_notices) > 5000:
        raise ReadError('rendered list exceeded capture bounds')
    rows = []
    for row in raw_rows:
        if len(row['text']) > 65_536 or len(row['cells']) > 64 or len(row['links']) > 128:
            raise ReadError('rendered list row exceeded capture bounds')
        rows.append(PageRow(row['text'], tuple(row['cells']),
                            tuple(PageLink(link['text'], link['href']) for link in row['links']),
                            row['header'], row.get('grade_object_id', ''), row.get('dom_id', '')))
    body = raw.get('body')
    body_links, headings = raw.get('body_links', []), raw.get('headings', [])
    if ((body is not None and len(body) > 1_048_576) or len(body_links) > 256 or len(headings) > 128):
        raise ReadError('rendered announcement exceeded capture bounds')
    return PageCapture(
        url=raw.get('url', url), status=status, main=raw['main'], rows=tuple(rows),
        notices=tuple(sorted(set(raw_notices))), busy=raw.get('busy', False),
        paginated=raw.get('paginated', False), auth_required=raw['auth_required'],
        headings=tuple(headings), body=body, announced_at=raw.get('announced_at'),
        body_links=tuple(PageLink(link['text'], link['href']) for link in body_links),
        content_index=raw.get('content_index', False),
    )


def _safe_request(expected: str, url: str, method: str, resource_type: str, is_main_document: bool) -> bool:
    if method != 'GET':
        return False
    if resource_type == 'document':
        return is_main_document and exact_landing(url, expected)
    target, source = url_parts(url), url_parts(expected)
    return bool(target and source and target.hostname == source.hostname and not target.fragment and
                resource_type in {'script', 'stylesheet', 'font'} and _STATIC.fullmatch(target.path) and
                not any(piece in ('', '.', '..') for piece in target.path.split('/')[1:]))


def _route_get(route, request, expected: str, page, timeout_ms: int):
    try:
        # The first navigation of a popup can begin before a frame has been attached.
        main = (request.resource_type == 'document' and request.is_navigation_request()
                and request.frame == page.main_frame)
    except Exception:
        route.abort('blockedbyclient')
        return
    if not _safe_request(expected, request.url, request.method, request.resource_type, main):
        route.abort('blockedbyclient')
        return
    response = None
    try:
        # A plain route.continue_() would let browser-followed redirects bypass this guard.
        response = route.fetch(max_redirects=0, timeout=timeout_ms)
        if 300 <= response.status < 400 or not exact_landing(response.url, request.url):
            route.abort('blockedbyclient')
        elif main and response.status == 200 and (
            response.headers.get('content-type', '').split(';')[0].strip().lower() not in {'text/html', 'application/xhtml+xml'}
            or 'attachment' in response.headers.get('content-disposition', '').lower()
        ):
            route.abort('blockedbyclient')
        else:
            route.fulfill(response=response)
    except Exception:
        # Never put auth headers, browser errors, request URLs or page text into reports.
        route.abort('failed')
    finally:
        if response is not None:
            response.dispose()


def _cookies(origin: str, header: str):
    if not header:
        raise ReadError('rendered fallback requires an authorized Brightspace session')
    host = urlsplit(origin).hostname
    cookies = []
    names = set()
    for part in header.split(';'):
        name, eq, value = part.strip().partition('=')
        if (not eq or not _COOKIE_NAME.fullmatch(name) or not _COOKIE_VALUE.fullmatch(value)
                or name in names):
            raise ReadError('rendered fallback session cookies have an unsupported format')
        names.add(name)
        cookies.append({'name': name, 'value': value, 'domain': host, 'path': '/', 'secure': True, 'httpOnly': True})
    return cookies


class PlaywrightCapture:
    """Lazily start stock Chromium, with a fresh isolated context for each approved list."""

    def __init__(self, origin: str, *, cookie_header: str, timeout_ms: int = 12_000,
                 timezone_id: str = 'America/New_York'):
        self.origin = checked_origin(origin)
        if not 1_000 <= timeout_ms <= 60_000:
            raise ValueError('render timeout must be between 1000 and 60000 milliseconds')
        self.timeout_ms = timeout_ms
        self.timezone_id = timezone_id
        self._cookie_header = cookie_header
        self._playwright = None
        self._browser = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def close(self):
        try:
            if self._browser is not None:
                self._browser.close()
        except Exception:
            pass
        finally:
            self._browser = None
            if self._playwright is not None:
                try:
                    self._playwright.stop()
                except Exception:
                    pass
                self._playwright = None

    def _start(self):
        if self._browser is not None:
            return
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise ReadError('rendered fallback requires the optional browser dependency') from None
        try:
            self._playwright = sync_playwright().start()
            self._browser = self._playwright.chromium.launch(headless=True, timeout=self.timeout_ms)
        except Exception:
            self.close()
            raise ReadError('could not start the rendered fallback browser') from None

    def __call__(self, url: str, area: str) -> PageCapture:
        ou = approved_capture_course(self.origin, area, url)
        cookies = _cookies(self.origin, self._cookie_header)
        self._start()
        context = None
        try:
            context = self._browser.new_context(
                service_workers='block', accept_downloads=False, locale='en-US', timezone_id=self.timezone_id)
            context.add_cookies(cookies)
            page = context.new_page()
            context.route_web_socket('**/*', lambda socket: socket.close())
            context.route('**/*', lambda route, request: _route_get(route, request, url, page, self.timeout_ms))
            deadline = time.monotonic() + self.timeout_ms / 1000
            response = page.goto(url, wait_until='domcontentloaded', timeout=self.timeout_ms)
            if response is None or not exact_landing(response.url, url) or not exact_landing(page.url, url):
                raise ReadError('rendered browser did not stay on the requested course list')
            if response.status != 200:
                raise ReadError('rendered list returned non-200 status', response.status)
            previous = None
            stable_since = None
            while time.monotonic() < deadline:
                raw = page.evaluate(_DOM_CAPTURE, area)
                snapshot = _make_capture(raw, page.url, response.status)
                if not exact_landing(snapshot.url, url) or not exact_landing(page.url, url):
                    raise ReadError('rendered browser did not stay on the requested course list')
                if snapshot.auth_required:
                    raise ReadError('rendered list requires sign-in')
                if ready_marker(area, snapshot, ou):
                    if snapshot != previous:
                        previous, stable_since = snapshot, time.monotonic()
                    elif time.monotonic() - stable_since >= 0.45:
                        return snapshot
                else:
                    previous, stable_since = None, None
                page.wait_for_timeout(125)
            raise ReadError('rendered list did not show stable content markers before timeout')
        except ReadError:
            raise
        except Exception:
            raise ReadError('could not load the rendered Brightspace list') from None
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception:
                    pass
