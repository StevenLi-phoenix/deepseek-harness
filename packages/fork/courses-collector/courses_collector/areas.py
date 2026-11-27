"""GET-only Brightspace area readers using the documented LE API.

The transport owns HTTP credentials/limits. Source text is untrusted data;
this module does not execute it, render it, or treat links in it as requests.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
import hashlib
from html.parser import HTMLParser
import re
from typing import Any, Callable, Protocol
from urllib.parse import parse_qsl, unquote, urljoin, urlsplit, urlunsplit

from .model import Course, Material, NeedsUI, ReadError, Reading


class ReadClient(Protocol):
    base_url: str
    le_version: str

    def get_json(self, path: str): ...


PageReader = Callable[[str, Course, str], Reading]
Row = dict[str, Any]
MAX_PAGES = 100
MAX_TOC_DEPTH = 64
MAX_NO_ID_NOTICES = 20
MAX_TOC_DESCRIPTION_BYTES = 2 * 1024 * 1024
MAX_OPAQUE_ID_BYTES = 256
_UNSAFE_DOWNLOAD_ID = 'Brightspace ID is not a safe single download path segment'
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


@dataclass(frozen=True)
class InventoryId:
    raw: int | str
    key: str
    segment: str | None


def _inventory_id(value: Any) -> InventoryId:
    if type(value) is int and 0 < value < 10**20:
        numeric = str(value)
        return InventoryId(value, numeric, numeric)
    if type(value) is not str or not value.strip() or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ReadError('invalid Brightspace inventory ID')
    try:
        raw_bytes = value.encode('utf-8')
    except UnicodeEncodeError:
        raise ReadError('invalid Brightspace inventory ID encoding') from None
    if len(raw_bytes) > MAX_OPAQUE_ID_BYTES:
        raise ReadError('Brightspace inventory ID exceeds byte limit')
    if re.fullmatch(r'[1-9][0-9]{0,19}', value):
        return InventoryId(value, value, value)
    # Type-framed digest; 128 bits leaves space for both parent and attachment IDs.
    key = 'opaque-' + hashlib.sha256(b'str\0' + raw_bytes).hexdigest()[:32]
    segment = value if re.fullmatch(r'[A-Za-z0-9._~-]+', value) and value not in {'.', '..'} else None
    return InventoryId(value, key, segment)


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


@dataclass
class MissingIds:
    count: int = 0
    items: list[dict[str, str]] = field(default_factory=list)

    def identify(self, value: Any, course: Course, source: str, kind: str, label: Any) -> InventoryId | None:
        if value is not None:
            return _inventory_id(value)
        self.count += 1
        if len(self.items) < MAX_NO_ID_NOTICES:
            clipped = ''.join(c if c.isprintable() else ' ' for c in label[:120]) if isinstance(label, str) else ''
            title = ' '.join(clipped.split()) or f'(untitled {kind})'
            self.items.append({'id': f'{course.id}-{source}-no-id-{self.count}', 'reason': f'no_id:{title}'})
        return None

    def report(self, course: Course, source: str) -> list[dict[str, str]]:
        omitted = self.count - len(self.items)
        if omitted:
            return [*self.items, {'id': f'{course.id}-{source}-no-id-overflow',
                                  'reason': f'no_id:{omitted} more items omitted'}]
        return list(self.items)


@dataclass(frozen=True)
class TocEntry:
    kind: str
    platform_id: InventoryId
    parent_id: InventoryId | None
    row: Row


class AreaReader:
    """Read one run's observations; reuse successful directory/inventory GETs."""

    def __init__(self, client: ReadClient, page_reader: PageReader | None = None):
        self.client = client
        self.page_reader = page_reader
        self.origin = client.base_url.rstrip('/')
        self._inventories: dict[tuple[str, int, str], list[Any]] = {}
        self._missing_ids: dict[tuple[str, int, str], MissingIds] = {}

    def read(self, area: str, course: Course, checked_at: str) -> Reading:
        methods = {'announcements': self._announcements, 'content': self._content,
                   'grades': self._grades, 'discussions': self._discussions,
                   'quizzes': self._quizzes, 'materials': self._materials}
        if area not in methods:
            raise ReadError('unsupported Brightspace area')
        try:
            records = methods[area](course, checked_at)
        except ReadError as error:
            status = error.http_status
            needs_ui = area == 'discussions' and status == 403
            if status != 403 and not (area == 'quizzes' and status == 404):
                raise
            if self.page_reader is None:
                if needs_ui:
                    raise NeedsUI(f'{error}; no rendered discussion reader', 403) from None
                raise
            try:
                result = self.page_reader(area, course, checked_at)
                if result.failure is not None:
                    raise result.failure
                _unique(result.records)
            except ReadError as page_error:
                error_type = NeedsUI if needs_ui else ReadError
                raise error_type(f'{error}; page fallback: {page_error}', status) from None
            return replace(result, source='page', fallback_http=status)
        _unique(records)
        missing = self._missing_ids.get((area, course.org_unit_id, checked_at))
        skips = missing.report(course, 'toc' if area == 'content' else area) if missing else []
        return Reading(records=records, source='api', count=len(records), skips=skips)

    def _path(self, course: Course, resource: str) -> str:
        return f'/d2l/api/le/{self.client.le_version}/{_id(course.org_unit_id)}{resource}'

    def _get(self, course: Course, resource: str):
        return self.client.get_json(self._path(course, resource))

    def _ui(self, path: str) -> str:
        return self.origin + path

    def _record(self, *, course: Course, platform_id: str | InventoryId, title: str, url: str, kind: str,
                id_type: str | None = None, rich: Any = None, extra: Row | None = None,
                download_path: str | None = None, expected_size: int | None = None,
                filename: str | None = None, skip_reason: str | None = None) -> Material:
        text, fmt = _rich(rich)
        key = platform_id.key if isinstance(platform_id, InventoryId) else platform_id
        raw_id = platform_id.raw if isinstance(platform_id, InventoryId) else platform_id
        metadata = {'platform_id': raw_id, **(extra or {})}
        if fmt is not None:
            metadata['body_format'] = fmt
        links = _body_links(rich, self.origin)
        if links:
            metadata['links'] = links
        return Material(id=f'{course.id}-{id_type or kind}-{key}', title=title, url=url,
                        kind=kind, text=text, filename=filename, download_path=download_path,
                        expected_size=expected_size, metadata=metadata, skip_reason=skip_reason)

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

        missing = MissingIds()

        def emit(kind: str, platform_id: InventoryId, parent: InventoryId | None, row: Row) -> None:
            key = kind, platform_id.key
            if key in seen:
                raise ReadError('duplicate Brightspace content ID')
            seen.add(key)
            entries.append(TocEntry(kind, platform_id, parent, row))

        def walk(modules: list[Row], parent: InventoryId | None, depth: int) -> None:
            if depth > MAX_TOC_DEPTH:
                raise ReadError('Brightspace content nesting limit exceeded')
            for module in modules:
                if module.get('IsHidden') is True:
                    continue
                mid = missing.identify(module.get('ModuleId'), course, 'toc', 'module', module.get('Title'))
                topics, children = module.get('Topics'), module.get('Modules')
                if mid is None:
                    # A skipped parent gives its children no parent identity. Keep any identified rows.
                    topics = [] if topics is None else topics
                    children = [] if children is None else children
                else:
                    emit('module', mid, parent, module)
                for topic in _objects(topics, 'content topics'):
                    if topic.get('IsHidden') is True:
                        continue
                    topic_id = topic.get('TopicId')
                    if topic_id is None:
                        topic_id = topic.get('Identifier')
                    tid = missing.identify(topic_id, course, 'toc', 'topic', topic.get('Title'))
                    if tid is not None:
                        emit('topic', tid, mid, topic)
                walk(_objects(children, 'child content modules'), mid, depth + 1)

        walk(_objects(toc.get('Modules'), 'root content modules'), None, 0)
        self._inventories[key] = entries
        self._missing_ids[('content', course.org_unit_id, checked_at)] = missing
        return entries

    def _toc_source(self, course: Course, selector: str) -> str:
        # The fragment identifies the row in our evidence; it is not an API route.
        return self._ui(self._path(course, '/content/toc')) + '#' + selector

    def _content(self, course: Course, checked_at: str) -> list[Material]:
        records = []
        total_description_bytes = 0
        for entry in self._toc(course, checked_at):
            item = entry.platform_id
            metadata = _fields(entry.row, {
                **_DATE_FIELDS, 'SortOrder': 'sort_order', 'IsLocked': 'locked', 'IsBroken': 'broken',
                'ActivityType': 'activity_type', 'StartDateTime': 'starts_at', 'EndDateTime': 'ends_at',
                'DueDateTime': 'due_at', 'LastModifiedDate': 'modified_at',
            })
            if entry.parent_id is not None:
                metadata['parent_platform_id'] = entry.parent_id.raw
            if entry.kind == 'topic' and entry.row.get('ActivityType') == 2:
                target = _ordinary_link(entry.row.get('Url'), self.origin)
                if target:
                    metadata['target_url'] = target
            description = entry.row.get('Description')
            if isinstance(description, str):
                description = {'Text': description}
            text, _ = _rich(description)
            if text is not None:
                try:
                    total_description_bytes += len(text.encode('utf-8'))
                except UnicodeEncodeError:
                    raise ReadError('invalid Brightspace ToC description encoding') from None
                if total_description_bytes > MAX_TOC_DESCRIPTION_BYTES:
                    raise ReadError('Brightspace ToC descriptions exceed the 2 MiB aggregate limit')
            records.append(self._record(
                course=course, platform_id=item, title=_title(entry.row, 'Title'),
                url=self._toc_source(course, f'{entry.kind}-{item.key}'), kind='content',
                id_type=f'content-{entry.kind}', rich=description, extra=metadata))
        return records

    def _file_record(self, *, course: Course, item: InventoryId, title: str,
                     id_type: str, fallback_url: str, route: str, ids: tuple[InventoryId, ...],
                     filename: str | None, extra: Row, expected_size: int | None = None) -> Material:
        segments = [item_id.segment for item_id in ids]
        path = None if None in segments else self._path(course, route.format(*segments))
        return self._record(
            course=course, platform_id=item, title=title, kind='file', id_type=id_type,
            url=self._ui(path) if path is not None else fallback_url, filename=filename,
            download_path=path, expected_size=expected_size, extra=extra,
            skip_reason=_UNSAFE_DOWNLOAD_ID if path is None else None,
        )

    def _materials(self, course: Course, checked_at: str) -> list[Material]:
        records = []

        entries = self._toc(course, checked_at)
        toc_missing = self._missing_ids[('content', course.org_unit_id, checked_at)]
        missing = MissingIds(toc_missing.count, list(toc_missing.items))
        for entry in entries:
            if entry.kind != 'topic' or entry.row.get('IsLocked') is True or entry.row.get('IsBroken') is True:
                continue
            topic, item = entry.row, entry.platform_id
            parent = entry.parent_id.raw if entry.parent_id is not None else None
            activity = topic.get('ActivityType')
            if type(activity) is int and activity == 1:
                title = _title(topic, 'Title')
                raw_url = topic.get('Url')
                filename = None
                if isinstance(raw_url, str):
                    candidate = unquote(raw_url.split('?', 1)[0].split('#', 1)[0].rsplit('/', 1)[-1])
                    try:
                        filename = _filename(candidate)
                    except ReadError:
                        pass  # A payload URL is optional filename evidence, never a download route.
                records.append(self._file_record(
                    course=course, item=item, title=title, id_type='material-topic', filename=filename,
                    fallback_url=self._toc_source(course, f'file-topic-{item.key}'),
                    route='/content/topics/{}/file', ids=(item,),
                    extra={'parent_platform_id': parent, 'content_url': self._toc_source(course, f'topic-{item.key}')},
                ))
            elif type(activity) is int and activity == 2:
                target = _ordinary_link(topic.get('Url'), self.origin)
                if target is not None:
                    records.append(self._record(
                        course=course, platform_id=item, title=_title(topic, 'Title'),
                        url=self._toc_source(course, f'link-topic-{item.key}'),
                        id_type='material-topic', kind='link', extra={
                            'parent_platform_id': parent, 'target_url': target,
                        }))

        for folder in _objects(self._get(course, '/dropbox/folders/'), 'assignment folders'):
            if folder.get('IsHidden') is True:
                continue
            fid = missing.identify(folder.get('Id'), course, 'materials', 'assignment folder', folder.get('Name'))
            if fid is None:
                continue
            for attach in _objects(folder.get('Attachments', []), 'assignment attachments'):
                aid = missing.identify(attach.get('Id'), course, 'materials', 'assignment attachment', attach.get('FileName'))
                if aid is None:
                    continue
                filename = _filename(_title(attach, 'FileName'))
                records.append(self._file_record(
                    course=course, item=aid, title=filename, id_type=f'assignment-{fid.key}-attachment',
                    fallback_url=self._ui(self._path(course, '/dropbox/folders/')) + f'#attachment-{fid.key}-{aid.key}',
                    route='/dropbox/folders/{}/attachments/{}', ids=(fid, aid), filename=filename,
                    expected_size=_file_size(attach.get('Size')), extra={'assignment_platform_id': fid.raw},
                ))

        for news in self._news(course, checked_at):
            nid = missing.identify(news.get('Id'), course, 'materials', 'announcement', news.get('Title'))
            if nid is None:
                continue
            for attach in _objects(news.get('Attachments', []), 'announcement attachments'):
                item = missing.identify(attach.get('FileId'), course, 'materials', 'announcement attachment', attach.get('FileName'))
                if item is None:
                    continue
                filename = _filename(_title(attach, 'FileName'))
                records.append(self._file_record(
                    course=course, item=item, title=filename, id_type=f'announcement-{nid.key}-attachment',
                    fallback_url=self._ui(self._path(course, '/news/')) + f'#attachment-{nid.key}-{item.key}',
                    route='/news/{}/attachments/{}', ids=(nid, item), filename=filename,
                    expected_size=_file_size(attach.get('FileSize')),
                    extra={'announcement_id': f'{course.id}-announcement-{nid.key}',
                           'announcement_platform_id': nid.raw},
                ))
        self._missing_ids[('materials', course.org_unit_id, checked_at)] = missing
        return records


def _file_size(value: Any) -> int | None:
    if value is None:
        return None
    if type(value) is not int or value < 0:
        raise ReadError('invalid Brightspace attachment size')
    return value


def _unique(records: list[Material]) -> None:
    if len({record.id for record in records}) != len(records):
        raise ReadError('duplicate Brightspace record ID')


def read_area(area: str, *, course: Course, client: ReadClient, checked_at: str,
              page_reader: PageReader | None = None) -> Reading:
    """Read a single area; use AreaReader when sharing inventories across areas."""
    return AreaReader(client, page_reader).read(area, course, checked_at)
