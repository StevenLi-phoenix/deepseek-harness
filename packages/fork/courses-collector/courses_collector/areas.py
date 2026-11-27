"""GET-only Brightspace area readers using the documented LE API.

The transport owns HTTP credentials/limits. Source text is untrusted data;
this module does not execute it, render it, or treat links in it as requests.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from html.parser import HTMLParser
import re
from typing import Any, Callable, Protocol
from urllib.parse import parse_qsl, unquote, urljoin, urlsplit, urlunsplit

from .model import Course, Material, ReadError, Reading


class ReadClient(Protocol):
    base_url: str
    le_version: str

    def get_json(self, path: str): ...
    def get_file(self, path: str) -> bytes: ...


PageReader = Callable[[str, Course, str], Reading]
Row = dict[str, Any]
MAX_PAGES = 100
MAX_TOC_DEPTH = 64
MAX_MATERIAL_BYTES = 128 * 1024 * 1024
_DATE_FIELDS = {'StartDate': 'starts_at', 'EndDate': 'ends_at', 'DueDate': 'due_at'}


def _object(value: Any, label: str) -> Row:
    if not isinstance(value, dict):
        raise ReadError(f'invalid {label} object')
    return value


def _objects(value: Any, label: str) -> list[Row]:
    if not isinstance(value, list):
        raise ReadError(f'invalid {label} list')
    return [_object(item, label) for item in value]


def _id(value: Any) -> str:
    if type(value) is int:
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,19}', value):
        raise ReadError('invalid Brightspace object ID')
    return value


def _title(row: Row, key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ReadError('missing Brightspace title')
    return value


def _fields(row: Row, fields: dict[str, str]) -> Row:
    # Intentionally never carry arbitrary object fields from LMS payloads.
    return {dest: row[key] for key, dest in fields.items()
            if isinstance(row.get(key), (str, int, float, bool))}


def _rich(value: Any) -> tuple[str | None, str | None]:
    if value is None:
        return None, None
    rich = _object(value, 'rich text')
    text, html = rich.get('Text'), rich.get('Html')
    if isinstance(text, str) and (text or not isinstance(html, str) or not html):
        return text, 'plain'
    if isinstance(html, str):
        return html, 'html'
    raise ReadError('missing rich text representation')


def _displayed(row: Row, key: str) -> dict[str, str]:
    value = row.get(key)
    if value is None:
        return {}
    block = _object(value, 'quiz display block')
    if block.get('IsDisplayed') is not True:
        return {}
    text, fmt = _rich(block.get('Text'))
    return {'text': text, 'format': fmt} if text is not None and fmt is not None else {}


def _ordinary_link(value: Any, origin: str) -> str | None:
    # Only return a reference. Never fetch a platform-supplied destination.
    # Do not archive signed/credentialed targets, even with the signature removed.
    if not isinstance(value, str) or not value or value != value.strip():
        return None
    if any(ord(char) < 32 or char in '\\ ' for char in value):
        return None
    if not value.startswith('https://') and not (value.startswith('/') and not value.startswith('//')):
        return None
    try:
        parts = urlsplit(urljoin(origin, value))
        if parts.scheme != 'https' or not parts.hostname or parts.username or parts.password:
            return None
        keys = {re.sub('[^a-z0-9]', '', key.casefold())
                for key, _ in parse_qsl(parts.query, keep_blank_values=True, max_num_fields=64)}
    except ValueError:
        return None
    sensitive = {'auth', 'authorization', 'accesskey', 'apikey', 'code', 'key', 'policy',
                 'exp', 'expires', 'sig', 'signature', 'samlrequest', 'samlresponse', 'relaystate'}
    if any(key in sensitive or key.startswith(('xamz', 'xgoog'))
           or any(t in key for t in ('token', 'session', 'credential', 'password', 'signature')) for key in keys):
        return None
    return urlunsplit(parts._replace(fragment=''))


class _BodyLinks(HTMLParser):
    def __init__(self, origin: str):
        super().__init__()
        self.origin = origin
        self.links: dict[str, None] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == 'a':
            for field, value in attrs:
                if field == 'href':
                    link = _ordinary_link(value, self.origin)
                    if link is not None:
                        self.links[link] = None


def _body_links(rich: Any, origin: str) -> list[str]:
    if not isinstance(rich, dict) or not isinstance(rich.get('Html'), str):
        return []
    parser = _BodyLinks(origin)
    parser.feed(rich['Html'])
    parser.close()
    return list(parser.links)


def _filename(value: str) -> str:
    if (not value or value in {'.', '..'} or len(value.encode('utf-8')) > 255
            or any(ord(c) < 32 or c in '/\\\x7f' for c in value)):
        raise ReadError('invalid Brightspace download filename')
    return value


def _continuation(value: Any, origin: str, path: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 8192:
        raise ReadError('invalid Brightspace page continuation')
    if any(ord(c) <= 32 or c == '\\' for c in value):
        raise ReadError('unsafe Brightspace page continuation')
    try:
        base = urlsplit(origin)
        target = urlsplit(urljoin(origin + path, value))
    except ValueError:
        raise ReadError('unsafe Brightspace page continuation') from None
    if ((target.scheme, target.netloc) != (base.scheme, base.netloc)
            or target.path != path or target.fragment or not target.query):
        raise ReadError('unsafe Brightspace page continuation')
    return target.path + '?' + target.query


@dataclass(frozen=True)
class TocEntry:
    kind: str
    platform_id: str
    parent_id: str | None
    row: Row


class AreaReader:
    """Read one run's observations; reuse successful directory/inventory GETs."""

    def __init__(self, client: ReadClient, page_reader: PageReader | None = None):
        self.client = client
        self.page_reader = page_reader
        self.origin = client.base_url.rstrip('/')
        self._inventories: dict[tuple[str, int, str], list[Any]] = {}

    def read(self, area: str, course: Course, checked_at: str) -> Reading:
        methods = {'announcements': self._announcements, 'content': self._content,
                   'grades': self._grades, 'discussions': self._discussions,
                   'quizzes': self._quizzes, 'materials': self._materials}
        if area not in methods:
            raise ReadError('unsupported Brightspace area')
        try:
            records = methods[area](course, checked_at)
        except ReadError as error:
            if error.http_status != 403 or self.page_reader is None:
                raise
            try:
                result = self.page_reader(area, course, checked_at)
                if result.failure is not None:
                    raise result.failure
                _unique(result.records)
            except ReadError as page_error:
                raise ReadError(f'Brightspace API HTTP 403; page fallback: {page_error}', 403) from None
            return replace(result, source='page', fallback_http=403)
        _unique(records)
        return Reading(records=records, source='api', count=len(records))

    def _path(self, course: Course, resource: str) -> str:
        return f'/d2l/api/le/{self.client.le_version}/{_id(course.org_unit_id)}{resource}'

    def _get(self, course: Course, resource: str):
        return self.client.get_json(self._path(course, resource))

    def _ui(self, path: str) -> str:
        return self.origin + path

    def _record(self, *, course: Course, platform_id: str, title: str, url: str, kind: str,
                id_type: str | None = None, rich: Any = None, extra: Row | None = None,
                file: bytes | None = None, filename: str | None = None) -> Material:
        text, fmt = _rich(rich)
        metadata = {'platform_id': platform_id, **(extra or {})}
        if fmt is not None:
            metadata['body_format'] = fmt
        links = _body_links(rich, self.origin)
        if links:
            metadata['links'] = links
        return Material(id=f'{course.id}-{id_type or kind}-{platform_id}', title=title, url=url,
                        kind=kind, text=text, file=file, filename=filename, metadata=metadata)

    def _news(self, course: Course, checked_at: str) -> list[Row]:
        key = ('news', course.org_unit_id, checked_at)
        if key not in self._inventories:
            rows = _objects(self._get(course, '/news/'), 'news')
            self._inventories[key] = [row for row in rows
                                     if row.get('IsHidden') is not True and row.get('IsPublished') is not False]
        return self._inventories[key]

    def _announcements(self, course: Course, checked_at: str) -> list[Material]:
        records = []
        ou = course.org_unit_id
        for row in self._news(course, checked_at):
            item = _id(row.get('Id'))
            if row.get('Body') is None:
                raise ReadError('missing Brightspace announcement body')
            records.append(self._record(
                course=course, platform_id=item, title=_title(row, 'Title'), kind='announcement',
                url=self._ui(f'/d2l/le/news/{ou}/{item}/view?ou={ou}'), rich=row['Body'],
                extra=_fields(row, {'CreatedDate': 'created_at', 'StartDate': 'posted_at',
                                     'EndDate': 'ends_at', 'LastModifiedDate': 'modified_at',
                                     'IsPinned': 'pinned'})))
        return records

    def _grades(self, course: Course, _checked_at: str) -> list[Material]:
        path = '/grades/values/myGradeValues/'
        records = []
        for row in _objects(self._get(course, path), 'own grade values'):
            item = _id(row.get('GradeObjectIdentifier'))
            if not isinstance(row.get('DisplayedGrade'), str):
                raise ReadError('missing Brightspace displayed grade')
            records.append(self._record(
                course=course, platform_id=item, title=_title(row, 'GradeObjectName'), kind='grade',
                url=self._ui(self._path(course, f'/grades/{item}/values/myGradeValue')),
                rich=row.get('Comments'), extra={'observed_from': self._ui(self._path(course, path)), **_fields(row, {
                    'DisplayedGrade': 'displayed_grade', 'GradeObjectTypeName': 'grade_type',
                    'PointsNumerator': 'points_numerator', 'PointsDenominator': 'points_denominator',
                    'ReleasedDate': 'released_at', 'LastModified': 'modified_at',
                })}))
        return records

    def _discussions(self, course: Course, _checked_at: str) -> list[Material]:
        base = '/discussions/forums/'
        ou = course.org_unit_id
        records = []
        for forum in _objects(self._get(course, base), 'discussion forums'):
            if forum.get('IsHidden') is True:
                continue
            fid = _id(forum.get('ForumId'))
            records.append(self._record(
                course=course, platform_id=fid, title=_title(forum, 'Name'),
                url=self._ui(self._path(course, f'{base}{fid}')),
                kind='discussion', id_type='discussion-forum', rich=forum.get('Description'),
                extra=_fields(forum, {**_DATE_FIELDS, 'PostStartDate': 'post_starts_at',
                                      'PostEndDate': 'post_ends_at', 'IsLocked': 'locked'})))
            for topic in _objects(self._get(course, f'{base}{fid}/topics/'), 'discussion topics'):
                if topic.get('IsHidden') is True:
                    continue
                if _id(topic.get('ForumId')) != fid:
                    raise ReadError('discussion topic refers to a different forum')
                tid = _id(topic.get('TopicId'))
                records.append(self._record(
                    course=course, platform_id=tid, title=_title(topic, 'Name'), kind='discussion',
                    id_type='discussion-topic', url=self._ui(f'/d2l/le/{ou}/discussions/topics/{tid}/View'),
                    rich=topic.get('Description'), extra={
                        'parent_platform_id': fid, **_fields(topic, {**_DATE_FIELDS,
                        'UnlockStartDate': 'unlocks_at', 'UnlockEndDate': 'locks_at', 'IsLocked': 'locked'}),
                    }))
        return records

    def _quiz_pages(self, course: Course):
        path = self._path(course, '/quizzes/')
        route = path
        seen = set()
        for _ in range(MAX_PAGES):
            if route in seen:
                raise ReadError('repeated Brightspace quiz page continuation')
            seen.add(route)
            page = _object(self.client.get_json(route), 'quiz page')
            yield from _objects(page.get('Objects'), 'quizzes')
            if 'Next' not in page:
                raise ReadError('missing Brightspace quiz pagination state')
            if page['Next'] is None:
                return
            route = _continuation(page['Next'], self.origin, path)
        raise ReadError('Brightspace quiz page limit exceeded')

    def _quizzes(self, course: Course, _checked_at: str) -> list[Material]:
        records = []
        for row in self._quiz_pages(course):
            if row.get('IsActive') is False:
                continue
            item = _id(row.get('QuizId'))
            description = _displayed(row, 'Description')
            instructions = _displayed(row, 'Instructions')
            primary = description or instructions
            metadata = _fields(row, _DATE_FIELDS)
            if instructions and description:
                metadata['instructions'] = instructions['text']
                metadata['instructions_format'] = instructions['format']
            if isinstance(row.get('AttemptsAllowed'), dict):
                metadata.update(_fields(row['AttemptsAllowed'], {'IsUnlimited': 'unlimited_attempts',
                                                                'NumberOfAttemptsAllowed': 'attempts_allowed'}))
            if isinstance(row.get('SubmissionTimeLimit'), dict):
                metadata.update(_fields(row['SubmissionTimeLimit'], {'IsEnforced': 'time_limit_enforced',
                                                                    'TimeLimitValue': 'time_limit_minutes'}))
            if primary:
                metadata['body_format'] = primary['format']
            records.append(self._record(
                course=course, platform_id=item, title=_title(row, 'Name'), kind='quiz',
                url=self._ui(self._path(course, f'/quizzes/{item}')),
                extra=metadata,
                rich={'Text' if primary['format'] == 'plain' else 'Html': primary['text']} if primary else None,
            ))
        return records

    def _toc(self, course: Course, checked_at: str) -> list[TocEntry]:
        key = ('toc', course.org_unit_id, checked_at)
        if key in self._inventories:
            return self._inventories[key]
        toc = _object(self._get(course, '/content/toc'), 'table of contents')
        entries: list[TocEntry] = []
        seen = set()

        def emit(kind: str, platform_id: str, parent: str | None, row: Row) -> None:
            if (kind, platform_id) in seen:
                raise ReadError('duplicate Brightspace content ID')
            seen.add((kind, platform_id))
            entries.append(TocEntry(kind, platform_id, parent, row))

        def walk(modules: list[Row], parent: str | None, depth: int) -> None:
            if depth > MAX_TOC_DEPTH:
                raise ReadError('Brightspace content nesting limit exceeded')
            for module in modules:
                if module.get('IsHidden') is True:
                    continue
                mid = _id(module.get('ModuleId'))
                emit('module', mid, parent, module)
                for topic in _objects(module.get('Topics'), 'content topics'):
                    if topic.get('IsHidden') is not True:
                        emit('topic', _id(topic.get('TopicId')), mid, topic)
                walk(_objects(module.get('Modules'), 'child content modules'), mid, depth + 1)

        walk(_objects(toc.get('Modules'), 'root content modules'), None, 0)
        self._inventories[key] = entries
        return entries

    def _content(self, course: Course, checked_at: str) -> list[Material]:
        records = []
        ou = course.org_unit_id
        for entry in self._toc(course, checked_at):
            item = entry.platform_id
            detail = _object(self._get(course, f'/content/{entry.kind}s/{item}'), 'content detail')
            if _id(detail.get('Id')) != item or detail.get('IsHidden') is True:
                raise ReadError('content detail does not match visible directory item')
            metadata = {
                **_fields(entry.row, {'SortOrder': 'sort_order', 'IsLocked': 'locked', 'IsBroken': 'broken',
                                      'ActivityType': 'activity_type', 'StartDateTime': 'starts_at',
                                      'EndDateTime': 'ends_at'}),
                **_fields(detail, {**_DATE_FIELDS, 'ModuleStartDate': 'starts_at',
                                   'ModuleEndDate': 'ends_at', 'ModuleDueDate': 'due_at'}),
            }
            if entry.parent_id is not None:
                metadata['parent_platform_id'] = entry.parent_id
            if entry.kind == 'topic':
                url = self._ui(f'/d2l/le/content/{ou}/viewContent/{item}/View')
                if entry.row.get('ActivityType') == 2:
                    target = _ordinary_link(entry.row.get('Url'), self.origin)
                    if target:
                        metadata['target_url'] = target
            else:
                url = self._ui(self._path(course, f'/content/modules/{item}'))
            records.append(self._record(
                course=course, platform_id=item, title=_title(entry.row, 'Title'), url=url, kind='content',
                id_type=f'content-{entry.kind}', rich=detail.get('Description'), extra=metadata))
        return records

    def _materials(self, course: Course, checked_at: str) -> list[Material]:
        records = []
        total = 0
        ou = course.org_unit_id

        def download(path: str) -> bytes:
            nonlocal total
            file = self.client.get_file(path)
            if not isinstance(file, bytes):
                raise ReadError('invalid Brightspace file payload')
            total += len(file)
            if total > MAX_MATERIAL_BYTES:
                raise ReadError('Brightspace materials exceed aggregate byte limit')
            return file

        for entry in self._toc(course, checked_at):
            if entry.kind != 'topic' or entry.row.get('IsLocked') is True or entry.row.get('IsBroken') is True:
                continue
            topic, item = entry.row, entry.platform_id
            activity = topic.get('ActivityType')
            if activity == 1:
                path = self._path(course, f'/content/topics/{item}/file')
                raw_url = topic.get('Url')
                if not isinstance(raw_url, str):
                    raise ReadError('missing Brightspace file topic path')
                filename = _filename(unquote(raw_url.split('?', 1)[0].split('#', 1)[0].rsplit('/', 1)[-1]))
                records.append(self._record(
                    course=course, platform_id=item, title=_title(topic, 'Title'),
                    url=self._ui(path), kind='file',
                    id_type='material-topic', filename=filename, file=download(path),
                    extra={'parent_platform_id': entry.parent_id,
                           'content_url': self._ui(f'/d2l/le/content/{ou}/viewContent/{item}/View')},
                ))
            elif activity == 2:
                target = _ordinary_link(topic.get('Url'), self.origin)
                if target is not None:
                    records.append(self._record(
                        course=course, platform_id=item, title=_title(topic, 'Title'),
                        url=self._ui(self._path(course, f'/content/topics/{item}')),
                        id_type='material-topic', kind='link', extra={
                            'parent_platform_id': entry.parent_id, 'target_url': target,
                        }))

        for folder in _objects(self._get(course, '/dropbox/folders/'), 'assignment folders'):
            if folder.get('IsHidden') is True:
                continue
            fid = _id(folder.get('Id'))
            for attach in _objects(folder.get('Attachments', []), 'assignment attachments'):
                aid = _id(attach.get('Id'))
                filename = _filename(_title(attach, 'FileName'))
                path = self._path(course, f'/dropbox/folders/{fid}/attachments/{aid}')
                data = download(path)
                if type(attach.get('Size')) is int and len(data) != attach['Size']:
                    raise ReadError('Brightspace attachment byte count does not match metadata')
                records.append(self._record(
                    course=course, platform_id=aid, title=filename, url=self._ui(path),
                    kind='file', id_type=f'assignment-{fid}-attachment', file=data, filename=filename,
                    extra={'assignment_platform_id': fid},
                ))

        for news in self._news(course, checked_at):
            nid = _id(news.get('Id'))
            for attach in _objects(news.get('Attachments', []), 'announcement attachments'):
                item = _id(attach.get('FileId'))
                filename = _filename(_title(attach, 'FileName'))
                path = self._path(course, f'/news/{nid}/attachments/{item}')
                raw_size = attach.get('FileSize')
                file = download(path)
                if type(raw_size) is int and len(file) != raw_size:
                    raise ReadError('Brightspace attachment byte count does not match metadata')
                records.append(self._record(
                    course=course, platform_id=item, title=filename, url=self._ui(path), kind='file',
                    id_type=f'announcement-{nid}-attachment', file=file, filename=filename,
                    extra={'announcement_id': f'{course.id}-announcement-{nid}'},
                ))
        return records


def _unique(records: list[Material]) -> None:
    if len({record.id for record in records}) != len(records):
        raise ReadError('duplicate Brightspace record ID')


def read_area(area: str, *, course: Course, client: ReadClient, checked_at: str,
              page_reader: PageReader | None = None) -> Reading:
    """Read a single area; use AreaReader when sharing inventories across areas."""
    return AreaReader(client, page_reader).read(area, course, checked_at)
