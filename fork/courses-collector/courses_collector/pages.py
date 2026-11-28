"""Validate bounded, rendered Brightspace list captures without interpreting page prose."""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Callable
from urllib.parse import parse_qs, urljoin, urlsplit
from zoneinfo import ZoneInfo

from .model import Course, Material, ReadError, Reading, TaskEvidence
from .page_rows import DUE as _DUE, parse_status_cell

_PATHS = {
    'announcements': '/d2l/lms/news/main.d2l?ou={ou}',
    'content': '/d2l/le/content/{ou}/Home',
    'materials': '/d2l/le/content/{ou}/Home',
    'assignments': '/d2l/lms/dropbox/user/folders_list.d2l?ou={ou}',
    'quizzes': '/d2l/lms/quizzing/user/quizzes_list.d2l?ou={ou}',
    'discussions': '/d2l/le/{ou}/discussions/List',
    'grades': '/d2l/lms/grades/my_grades/main.d2l?ou={ou}',
}
_ID = re.compile(r'[1-9][0-9]{0,18}\Z')
_HOST = re.compile(r'[a-z0-9][a-z0-9.-]*[a-z0-9]\Z')
_EMPTY = {
    'assignments': {'no assignments found', 'there are no assignments'},
    'quizzes': {'no quizzes found', 'there are no quizzes'},
    'discussions': {'no discussions found', 'there are no forums', 'there are no topics'},
    'grades': {'no grade items found', 'there are no grade items'},
    'announcements': {'no announcements found', 'there are no announcements', 'no news items found'},
}
_DETAIL_PATH = re.compile(r'/d2l/le/news/([1-9][0-9]{0,18})/([1-9][0-9]{0,18})/view\Z')
_CONTENT_PATH = re.compile(r'/d2l/le/content/([1-9][0-9]{0,18})/Home\Z')
_DISCUSSIONS_PATH = re.compile(r'/d2l/le/([1-9][0-9]{0,18})/discussions/List\Z')
_MAX_ANNOUNCEMENTS = 100
_ATTEMPTS = re.compile(r'\d+\s*(?:/|out of)\s*(?:\d+|unlimited)\Z', re.I)
_GRADE_ROW_ID = re.compile(r'grade[-_]?item[-_]?([1-9][0-9]{0,18})\Z', re.I)


@dataclass(frozen=True)
class PageLink:
    text: str
    href: str


@dataclass(frozen=True)
class PageRow:
    text: str
    cells: tuple[str, ...] = ()
    links: tuple[PageLink, ...] = ()
    header: bool = False
    grade_object_id: str = ''
    dom_id: str = ''


@dataclass(frozen=True)
class PageCapture:
    """Visible structured facts from the main landmark; never whole-document text."""
    url: str
    status: int = 200
    main: bool = True
    rows: tuple[PageRow, ...] = ()
    notices: tuple[str, ...] = ()
    busy: bool = False
    paginated: bool = False
    auth_required: bool = False
    headings: tuple[str, ...] = ()
    body: str | None = None
    body_links: tuple[PageLink, ...] = ()
    announced_at: str | None = None
    content_index: bool = False


def url_parts(url: str):
    """Restrict origin checks to the collector's conventional HTTPS origins."""
    if not isinstance(url, str) or re.search(r'[\\\x00-\x20\x7f]', url):
        return None
    try:
        target = urlsplit(url)
        host = target.hostname or ''
        if (target.scheme != 'https' or not _HOST.fullmatch(host) or
                target.username is not None or target.password is not None or
                target.port not in (None, 443) or target.netloc.lower() not in (host, f'{host}:443')):
            return None
        return target
    except ValueError:
        return None


def checked_origin(origin: str) -> str:
    target = url_parts(origin)
    if target is None or target.path not in ('', '/') or target.query or target.fragment:
        raise ReadError('invalid Brightspace page origin')
    return f'https://{target.hostname}'


def landing_url(origin: str, area: str, org_unit_id: int) -> str:
    suffix = _PATHS.get(area)
    if suffix is None or not _ID.fullmatch(str(org_unit_id)):
        raise ReadError('no approved rendered list route')
    return checked_origin(origin) + suffix.format(ou=org_unit_id)


def exact_landing(actual: str, expected: str) -> bool:
    a, b = url_parts(actual), url_parts(expected)
    return bool(a and b and (a.hostname, a.path, a.query, a.fragment) ==
                (b.hostname, b.path, b.query, ''))


def announcement_url(origin: str, ou: str, item: str) -> str:
    if not _ID.fullmatch(ou) or not _ID.fullmatch(item):
        raise ReadError('invalid rendered announcement identity')
    return checked_origin(origin) + f'/d2l/le/news/{ou}/{item}/view?ou={ou}'


def approved_capture_course(origin: str, area: str, url: str) -> str:
    """Resolve a browser request against the fixed route for its declared purpose."""
    target = url_parts(url)
    if target:
        if area == 'announcement_detail':
            match = _DETAIL_PATH.fullmatch(target.path)
            if match and exact_landing(url, announcement_url(origin, match[1], match[2])):
                return match[1]
        else:
            if area in {'content', 'materials'}:
                match = _CONTENT_PATH.fullmatch(target.path)
            elif area == 'discussions':
                match = _DISCUSSIONS_PATH.fullmatch(target.path)
            else:
                match = re.fullmatch(r'ou=([1-9][0-9]{0,18})', target.query)
            if match and exact_landing(url, landing_url(origin, area, int(match[1]))):
                return match[1]
    raise ReadError('no approved rendered list route')


def _normalized(text: str) -> str:
    return ' '.join(text.split()).casefold().rstrip('.')


def _unique_query(query: dict, key: str) -> str:
    values = query.get(key, [])
    return values[0] if len(values) == 1 else ''


def _record_link(area: str, page: str, ou: str, link: PageLink) -> tuple[str, str] | None:
    if not link.href or not link.text.strip() or link.href.strip() != link.href:
        return None
    # urljoin silently removes some control characters. Reject before joining.
    if re.search(r'[\\\x00-\x20\x7f]', link.href):
        return None
    try:
        base, target = url_parts(page), url_parts(urljoin(page, link.href))
        if not base or not target or base.hostname != target.hostname:
            return None
        query = parse_qs(target.query, keep_blank_values=True, max_num_fields=32)
    except ValueError:
        return None
    if area == 'assignments' and target.path in (
        '/d2l/lms/dropbox/user/folder_submit_files.d2l',
        '/d2l/lms/dropbox/user/folder_user_view_feedback.d2l',
    ):
        key = 'db'
    elif area == 'quizzes' and target.path in (
        '/d2l/lms/quizzing/user/quiz_summary.d2l',
        '/d2l/lms/quizzing/user/quizzes_summary.d2l',
    ):
        key = 'qi'
    elif area == 'announcements':
        match = _DETAIL_PATH.fullmatch(target.path)
        if match and match[1] == ou and ('ou' not in query or _unique_query(query, 'ou') == ou):
            return match[2], announcement_url(f'https://{base.hostname}', ou, match[2])
        return None
    elif area == 'discussions':
        match = re.fullmatch(rf'/d2l/le/{ou}/discussions/topics/([1-9][0-9]{{0,18}})/[Vv]iew/?', target.path)
        # Do not let a conflicting query identify another course.
        if match and ('ou' not in query or _unique_query(query, 'ou') == ou):
            topic_id = match.group(1)
            return topic_id, f'https://{base.hostname}/d2l/le/{ou}/discussions/topics/{topic_id}/View'
        return None
    else:
        return None
    object_id = _unique_query(query, key)
    if _unique_query(query, 'ou') == ou and _ID.fullmatch(object_id):
        return object_id, f'https://{base.hostname}{target.path}?ou={ou}&{key}={object_id}'
    return None


def _entries(area: str, page: PageCapture, ou: str):
    for row in page.rows:
        if row.header:
            continue
        matches = [(link, result) for link in row.links
                   if (result := _record_link(area, page.url, ou, link)) is not None]
        if not matches:
            continue
        if len({identity[0] for _, identity in matches}) != 1:
            raise ReadError('ambiguous rows in rendered list')
        # Only take the matching title from the primary row cell. A link on a submission
        # count/feedback cell is not an assignment name. Discussions may be heading/list rows.
        link, (item_id, source) = matches[0]
        if area in {'assignments', 'quizzes'} and row.cells:
            if not any(_normalized(cell).startswith(_normalized(link.text)) for cell in row.cells[:1]):
                continue
        yield row, link.text.strip(), item_id, source


def _empty(area: str, page: PageCapture) -> bool:
    return any(_normalized(notice) in _EMPTY[area] for notice in page.notices)


def _assignment_columns(page: PageCapture) -> tuple[tuple[str, ...], int] | None:
    for row in page.rows:
        columns = tuple(_normalized(cell) for cell in row.cells)
        if row.header and columns and columns[0] in {'assignment', 'assignments'}:
            matches = [i for i, label in enumerate(columns) if label in {'completion status', 'submission status'}]
            if len(matches) == 1:
                return columns, matches[0]
    return None


def _assignment_entries(page: PageCapture, ou: str):
    header = _assignment_columns(page)
    if header is None:
        return []
    columns, status_col = header
    entries = []
    for row in page.rows:
        if row.header or not row.cells or len(row.cells) == 1:
            continue
        if len(row.cells) != len(columns) or not row.cells[0].strip():
            raise ReadError('rendered assignment list contains unreadable rows')
        title, _, details = row.cells[0].strip().partition('\n')
        if not title.strip():
            raise ReadError('rendered assignment row has no title')
        matches = []
        for link in row.links:
            result = _record_link('assignments', page.url, ou, link)
            if result is not None:
                matches.append((link, result))
            elif re.search(r'folder_(?:submit_files|user_view_feedback)\.d2l(?:[?#]|$)', link.href, re.I):
                raise ReadError('rendered assignment row links outside the expected course')
        if len({identity[0] for _, identity in matches}) > 1:
            raise ReadError('ambiguous rows in rendered assignment list')
        # Closed rows may not link the title, but their column text is still evidence.
        # API/list-level fallback must not derive a new task ID from a display title.
        primary = next(((link, ident) for link, ident in matches if link.text.strip() == title.strip()), None)
        item_id, source = primary[1] if primary else matches[0][1] if matches else ('', page.url)
        if not details:
            details = row.cells[0]
        entries.append((title.strip(), item_id, source, details, row.cells[status_col]))
    return entries


def _grade_columns(page: PageCapture) -> tuple[str, ...] | None:
    for row in page.rows:
        columns = tuple(_normalized(cell) for cell in row.cells)
        if row.header and columns and columns[0] == 'grade item' and {'points', 'grade', 'weight achieved'}.intersection(columns[1:]):
            return columns
    return None


def ready_marker(area: str, page: PageCapture, ou: str) -> bool:
    """Presence of content-specific DOM evidence, independent of browser load events."""
    if not page.main or page.busy or page.auth_required:
        return False
    if area == 'announcement_detail':
        return bool(page.body and page.body.strip() and any(heading.strip() for heading in page.headings))
    if area in {'content', 'materials'}:
        return page.content_index
    if _empty(area, page):
        return True
    if area == 'grades':
        columns = _grade_columns(page)
        return bool(columns and any(not row.header and len(row.cells) == len(columns) for row in page.rows))
    if area == 'assignments':
        return bool(_assignment_entries(page, ou))
    return any(_entries(area, page, ou))


class RenderedPageReader:
    """Page fallback over an injected capture function; no navigation from untrusted links."""

    def __init__(self, origin: str, capture: Callable[[str, str], PageCapture], *,
                 timezone_id: str = 'America/New_York'):
        self.origin = checked_origin(origin)
        self.capture = capture
        self.timezone = ZoneInfo(timezone_id)

    def _capture(self, area: str, course: Course, *, expected: str | None = None) -> PageCapture:
        if expected is None:
            expected = landing_url(self.origin, area, course.org_unit_id)
        page = self.capture(expected, area)
        if not isinstance(page, PageCapture) or not exact_landing(page.url, expected):
            raise ReadError('rendered page did not stay on the requested course list')
        if page.status != 200:
            raise ReadError('rendered list returned non-200 status', page.status)
        if page.auth_required:
            raise ReadError('rendered list requires sign-in')
        if page.paginated:
            raise ReadError('rendered list pagination or an active filter prevents full coverage')
        if not ready_marker(area, page, str(course.org_unit_id)):
            raise ReadError('rendered page lacks complete list content markers')
        return page

    def _assignment_rows(self, course: Course):
        page = self._capture('assignments', course)
        entries = _assignment_entries(page, str(course.org_unit_id))
        if bool(entries) == _empty('assignments', page):
            raise ReadError('rendered assignment list has conflicting evidence')
        return entries

    def assignment_statuses(self, course: Course, names: list[str]) -> dict[str, str]:
        """Resolve each known API title with exactly one matching rendered status cell."""
        entries = self._assignment_rows(course)
        by_name = {}
        for title, _, _, _, status_cell in entries:
            status = parse_status_cell(status_cell) if course.assignment_submissions else 'unknown'
            by_name[title] = status if title not in by_name else 'unknown'
        return {name: by_name.get(name, 'unknown') for name in names}

    def assignment_page(self, course: Course) -> str:
        """Legacy plain-text representation; prefer assignment_statuses for attribution."""
        entries = self._assignment_rows(course)
        titles = [entry[0] for entry in entries]
        if len(set(titles)) != len(titles) or any(a != b and a in b for a in titles for b in titles):
            raise ReadError('assignment names require structured row lookup')
        text = []
        for title, _, _, details, status_cell in entries:
            status = parse_status_cell(status_cell) if course.assignment_submissions else 'unknown'
            due = _DUE.search(' '.join(details.split()))
            text.append('\n'.join([title, f'Due on {due[1]}' if due else '',
                                  ' '.join(status_cell.split()) if status != 'unknown' else '']))
        return '\n'.join(text)

    def assignment_task_rows(self, course: Course) -> list[TaskEvidence]:
        entries = self._assignment_rows(course)
        ids = [entry[1] for entry in entries]
        if '' in ids or len(set(ids)) != len(ids):
            raise ReadError('rendered assignment rows lack unique platform IDs')
        tasks = []
        for title, item_id, url, details, status_cell in entries:
            details = ' '.join(details.split())
            due = _DUE.search(details)
            due_at = None
            if re.search(r'\bdue\s+(?:on|date)\b', details, re.I) and not due:
                raise ReadError('rendered assignment deadline format is unknown')
            if due:
                try:
                    local = datetime.strptime(due[1], '%b %d, %Y %I:%M %p')
                    first = local.replace(tzinfo=self.timezone, fold=0)
                    if first.utcoffset() != local.replace(tzinfo=self.timezone, fold=1).utcoffset():
                        raise ReadError('rendered assignment deadline is ambiguous or nonexistent')
                    due_at = first.isoformat()
                except ValueError:
                    raise ReadError('rendered assignment deadline is invalid') from None
            status = parse_status_cell(status_cell) if course.assignment_submissions else 'unknown'
            if status == 'unknown' and course.assignment_submissions:
                raise ReadError('rendered assignment row submission status is unreadable')
            tasks.append(TaskEvidence(item_id, title, url, due_at, status, due_known=bool(due)))
        return tasks

    def _announcements(self, course: Course, page: PageCapture) -> list[Material]:
        entries = list(_entries('announcements', page, str(course.org_unit_id)))
        _check_entry_coverage('announcements', page, entries)
        if len(entries) > _MAX_ANNOUNCEMENTS:
            raise ReadError('rendered announcement index exceeds detail capture limit')
        records = []
        for _, title, item_id, url in entries:
            detail = self._capture('announcement_detail', course, expected=url)
            if not any(_normalized(heading) == _normalized(title) for heading in detail.headings):
                raise ReadError('rendered announcement title does not match its index item')
            metadata = {'platform_id': item_id, 'body_format': 'text'}
            links = _announcement_body_links(detail)
            if links:
                metadata['links'] = links
            if detail.announced_at:
                try:
                    moment = datetime.fromisoformat(detail.announced_at.replace('Z', '+00:00'))
                    if moment.utcoffset() is not None:
                        metadata['posted_at'] = moment.isoformat()
                except ValueError:
                    pass
            records.append(Material(f'{course.id}-announcement-{item_id}', title, url, 'announcement',
                                    detail.body, metadata=metadata))
        return records

    def __call__(self, area: str, course: Course, checked_at: str) -> Reading:
        if area == 'assignments':
            tasks = self.assignment_task_rows(course)
            return Reading(source='page', count=len(tasks), tasks=tasks)
        page = self._capture(area, course)
        if area in {'content', 'materials'}:
            # Visible links prove the index loaded, not that collapsed modules, nested
            # topics or every attachment are present. Never claim full coverage from it.
            raise ReadError('rendered content index cannot prove complete hierarchy or files')
        if area == 'announcements':
            records = self._announcements(course, page)
        elif area == 'grades':
            records = _grades(course, page)
        else:
            entries = list(_entries(area, page, str(course.org_unit_id)))
            _check_entry_coverage(area, page, entries)
            records = []
            kind = 'quiz' if area == 'quizzes' else 'discussion-topic'
            for row, title, item_id, url in entries:
                metadata = {'platform_id': item_id}
                if area == 'quizzes':
                    values = [cell.strip() for cell in row.cells[1:] if _ATTEMPTS.fullmatch(cell.strip())]
                    if len(values) == 1:
                        metadata['attempts_display'] = values[0]
                text = row.text.strip() or None if area == 'quizzes' else None
                records.append(Material(f'{course.id}-{kind}-{item_id}', title, url,
                                        'discussion' if area == 'discussions' else 'quiz', text,
                                        metadata=metadata))
        return Reading(records=records, source='page', count=len(records))


def _announcement_body_links(detail: PageCapture) -> list[str]:
    links = {}
    for link in detail.body_links:
        if (not link.href.startswith(('https://', '/')) or link.href.startswith('//')
                or not url_parts(link.href if link.href.startswith('https://') else urljoin(detail.url, link.href))):
            continue
        target = url_parts(urljoin(detail.url, link.href))
        # Do not preserve signed or session-bearing URLs from rendered body content.
        # Retaining queryless references is intentionally stricter than fetching them.
        if target and not target.query:
            links[target._replace(fragment='').geturl()] = None
    return list(links)


def _check_entry_coverage(area, page, entries):
    ids = [entry[2] for entry in entries]
    if len(set(ids)) != len(ids) or bool(entries) == _empty(area, page):
        raise ReadError('rendered list has duplicate or conflicting evidence')
    # Non-linked titled cells are common for inaccessible/closed items. Treat them as
    # unreadable rather than turning a partial list into an area-wide successful sync.
    expected_rows = {id(entry[0]) for entry in entries}
    if any(not row.header and id(row) not in expected_rows and (
        (len(row.cells) > 1 and row.cells[0].strip()) or
        (area in {'announcements', 'discussions'} and not row.cells and row.links)
    ) for row in page.rows):
        raise ReadError('rendered list contains unreadable rows')


def _grades(course: Course, page: PageCapture) -> list[Material]:
    columns = _grade_columns(page)
    records = []
    used = set()
    category = ''
    for row in page.rows:
        if row.header or not row.cells or not any(cell.strip() for cell in row.cells):
            continue
        if len(row.cells) == 1 and columns:
            category = row.cells[0].strip()
            continue
        if not columns or len(row.cells) != len(columns) or not row.cells[0].strip():
            raise ReadError('rendered grades list contains unreadable rows')
        title = row.cells[0].strip()
        object_id = row.grade_object_id
        if not _ID.fullmatch(object_id):
            match = _GRADE_ROW_ID.fullmatch(row.dom_id)
            object_id = match[1] if match else ''
        if object_id:
            item_id = f'{course.id}-grade-{object_id}'
        else:
            # Some student layouts expose no grade-object identifier. Do not invent an API ID.
            fingerprint = hashlib.sha256(f'{category}\0{title}'.encode()).hexdigest()[:24]
            item_id = f'{course.id}-grade-page-{fingerprint}'
        if item_id in used:
            raise ReadError('rendered grades list contains indistinguishable rows')
        used.add(item_id)
        metadata = {'source': 'page'}
        if category:
            metadata['category'] = category
        for heading, value in zip(columns[1:], row.cells[1:]):
            if heading and value.strip():
                metadata[heading.replace(' ', '_') + '_display'] = value.strip()
        records.append(Material(item_id, title, page.url, 'grade', row.text.strip() or None, metadata=metadata))
    if bool(records) == _empty('grades', page):
        raise ReadError('rendered grades list has conflicting evidence')
    return records
