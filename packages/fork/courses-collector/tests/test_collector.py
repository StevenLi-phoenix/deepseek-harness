"""Transport-injected regressions for the complete collector and write ordering."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlsplit
from unittest.mock import patch

from courses_collector.cli import main, write_report
from courses_collector.collector import AREAS, collect, human_summary
from courses_collector.config import BRIGHTSPACE_ORIGIN, COURSES_API_BASE, Config, load_config
from courses_collector.model import Course, Material, ReadError
from courses_collector.pages import PageCapture, PageLink, PageRow, RenderedPageReader
from courses_collector.store import Courses
from courses_collector.transport import MAX_FILE, Brightspace, Reply, ResponseTooLarge

ORIGIN = 'https://school.example'
BASE = 'https://records.example/courses'
COURSE = Course('demo', 'example-term-demo', 900001)
NOW = '2026-11-27T12:30:00+00:00'
LE = '/d2l/api/le/1.67/900001'
ASSIGNMENT = ORIGIN + '/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=900001&db=21'
NEWS = ORIGIN + '/d2l/le/news/900001/8/view?ou=900001'


def reply(value, status=200):
    return Reply(status, json.dumps(value).encode(), 'application/json')


class FakeWire:
    def __init__(self):
        self.lms = {}
        self.rows = {}
        self.files = set()
        self.requests = []
        self.conflict = False

    def __call__(self, request, _limit):
        url = urlsplit(request.full_url)
        body = request.data
        method = request.get_method()
        self.requests.append((url.hostname, method, url.path, body))
        if url.hostname == 'school.example':
            assert method == 'GET' and request.get_header('Cookie') == 'd2lSessionVal=fictional'
            assert not request.get_header('Authorization')
            route = url.path + ('?' + url.query if url.query else '')
            value = self.lms.get(route, Reply(404, b''))
            if isinstance(value, Exception):
                raise value
            return value if isinstance(value, Reply) else reply(value)
        assert url.hostname == 'records.example'
        assert request.get_header('Authorization') == 'Bearer fictional'
        assert not request.get_header('Cookie')
        if url.path.startswith('/courses/v1/files/'):
            sha = url.path.rsplit('/', 1)[1]
            if method == 'HEAD':
                return Reply(200 if sha in self.files else 404, b'')
            assert method == 'PUT' and hashlib.sha256(body).hexdigest() == sha
            self.files.add(sha)
            return reply({'ok': True, 'sha256': sha, 'size': len(body), 'created': True}, 201)
        assert method == 'POST'
        op = url.path.rsplit('/', 1)[1]
        args = json.loads(body)
        if op == 'query':
            entity = args['kind']
            rows = [{**x['data'], 'kind': entity, 'id': x['id'], 'version': x['version']}
                    for x in self.rows.values() if x['kind'] == entity]
            result = {'records': rows, 'next_offset': None, 'total': len(rows)}
        elif op == 'get':
            result = self.rows[args['id']]
        else:
            assert op == 'save_material'
            assert 'sha256' not in args or args['sha256'] in self.files
            if self.conflict:
                return reply({'ok': True, 'result': {'conflict': True}})
            current = self.rows.get(args['id'], {'version': 0})
            assert args['expected_version'] == current['version']
            assert args.get('evidence', {}).get('observed_at') == NOW
            result = {'id': args['id'], 'version': current['version'] + 1, 'kind': 'material', 'data': args}
            self.rows[args['id']] = result
        return reply({'ok': True, 'result': result})

    def add_task(self, *, due=None, submitted='unknown', verified=False, source=True):
        self.rows['saved-task'] = {'id': 'saved-task', 'kind': 'task', 'version': 4, 'data': {
            'course_id': COURSE.id, 'title': 'Lab', 'due_at': due,
            'submission_status': submitted, 'submission_verified': verified,
            'source_links': [{'url': ASSIGNMENT, 'kind': 'requirements'}] if source else [],
        }}

    def add_assignment(self, *, due='2026-11-28T00:00:00Z', submissions=None):
        self.lms[f'{LE}/dropbox/folders/'] = [
            {'Id': 21, 'Name': 'Lab', 'DueDate': due, 'IsHidden': False, 'GroupTypeId': 0},
        ]
        self.lms[f'{LE}/dropbox/folders/21/submissions/'] = ([{'Submissions': []}]
                                                               if submissions is None else submissions)

    def add_announcements(self, text):
        self.lms[f'{LE}/news/'] = [{'Id': 8, 'Title': 'Announcement', 'Body': {'Text': text}}]

    def operations(self, op):
        return [item for item in self.requests if item[2].endswith('/v1/ops/' + op)]


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.wire = FakeWire()
        self.config = Config(ORIGIN, BASE, (COURSE,))
        self.lms = Brightspace(ORIGIN, '1.67', 'd2lSessionVal=fictional', self.wire)

    def run_areas(self, *areas, dry=False, page=None):
        return collect(self.config, areas, self.lms, Courses(BASE, 'fictional', self.wire, dry_run=dry),
                       page, read_at=NOW)

    def course(self, report, area):
        return report['areas'][area]['courses']['demo']

    def test_assignment_diff_uses_instant_identity_and_verified_status(self):
        self.wire.add_assignment(submissions=[{'Submissions': [{'Files': []}]}])
        self.wire.add_task(due='2026-11-27T19:00:00-05:00')
        report = self.run_areas('assignments')
        self.assertTrue(report['ok'])
        delta = self.course(report, 'assignments')['task_changes'][0]
        self.assertEqual(delta['id'], 'saved-task')
        self.assertEqual(delta['version'], 4)
        self.assertEqual(delta['fields'], {'submission_status': {'before': 'unknown', 'after': 'submitted'}})
        self.assertFalse(self.wire.operations('save_material'))

    def test_unmatched_title_never_creates_or_updates_a_task(self):
        self.wire.add_assignment()
        self.wire.add_task(source=False)
        row = self.course(self.run_areas('assignments'), 'assignments')
        self.assertEqual(row['task_changes'], [])
        self.assertEqual(row['unmatched_tasks'][0]['id'], f'{COURSE.id}-assignment-21')

    def test_known_existing_verified_submission_is_not_erased(self):
        self.wire.add_assignment(due=None)
        self.wire.add_task(submitted='submitted', verified=True)
        row = self.course(self.run_areas('assignments'), 'assignments')
        self.assertEqual(row['task_changes'], [])
        self.assertEqual(row['checked_ids'], [])

    def test_unchanged_verified_row_keeps_checked_id(self):
        self.wire.add_assignment(due=None)
        self.wire.add_task(submitted='not_submitted', verified=True)
        row = self.course(self.run_areas('assignments'), 'assignments')
        self.assertEqual(row['checked_ids'], ['saved-task'])
        self.assertEqual(row['task_changes'], [])

    def test_empty_render_after_403_is_failed_never_not_submitted(self):
        self.wire.add_assignment(due=None, submissions=Reply(403, b''))
        self.wire.add_task()
        page = RenderedPageReader(ORIGIN, lambda url, area: PageCapture(url))
        report = self.run_areas('assignments', page=page)
        row = self.course(report, 'assignments')
        self.assertEqual((row['status'], row['http_status'], row['source']), ('failed', 403, 'api+page'))
        self.assertEqual(row['task_changes'], [])
        self.assertIn('HTTP 403', human_summary(report))

    def test_403_uses_exact_rendered_status_column(self):
        self.wire.add_assignment(due=None, submissions=Reply(403, b''))
        self.wire.add_task()
        page = RenderedPageReader(ORIGIN, lambda url, area: PageCapture(url, rows=(
            PageRow('', ('Assignments', 'Completion Status'), header=True),
            PageRow('', ('Lab', '1 Submission, 1 File'), (PageLink('Lab', ASSIGNMENT),)),
        )))
        report = self.run_areas('assignments', page=page)
        row = self.course(report, 'assignments')
        self.assertTrue(report['ok'])
        self.assertEqual((row['source'], row['fallback_http']), ('api+page', 403))
        self.assertEqual(row['task_changes'][0]['fields']['submission_status']['after'], 'submitted')

    def test_areas_selection_and_explicit_gradescope_failure(self):
        report = self.run_areas('gradescope', dry=True)
        self.assertEqual(list(report['areas']), ['gradescope'])
        self.assertFalse(report['ok'])
        self.assertFalse(self.wire.requests)
        self.assertEqual(self.course(report, 'gradescope')['reason'], 'not_implemented')
        self.assertEqual(len(AREAS), 8)

    def test_announcements_are_verbatim_incremental_and_never_in_reports(self):
        body = '  First paragraph\n\nSecond paragraph é\n'
        self.wire.add_announcements(body)
        dry = self.run_areas('announcements', dry=True)
        self.assertEqual(self.course(dry, 'announcements')['changes'][0]['action'], 'new')
        self.assertFalse(self.wire.operations('save_material'))
        report = self.run_areas('announcements')
        key = f'{COURSE.id}-announcement-8'
        self.assertEqual(self.wire.rows[key]['data']['content'], body)
        self.assertEqual(self.wire.rows[key]['data']['url'], NEWS)
        self.assertNotIn('First paragraph', human_summary(report) + json.dumps(report))
        self.assertEqual(self.course(self.run_areas('announcements'), 'announcements')['changes'], [])
        self.assertEqual(len(self.wire.operations('save_material')), 1)
        self.wire.add_announcements(body + '\n')
        self.assertEqual(self.course(self.run_areas('announcements'), 'announcements')['changes'][0]['action'], 'changed')
        self.assertEqual(self.wire.rows[key]['data']['content'], body + '\n')

    def test_file_written_first_and_only_for_changed_content(self):
        mat = Material(COURSE.id + '-material-8', 'Slides', NEWS, 'file', file=b'%PDF-fake', filename='slides.pdf')
        dry = Courses(BASE, 'fictional', self.wire, dry_run=True)
        self.assertEqual(dry.material(COURSE, mat, NOW), 'new')
        self.assertFalse(any(row[1] != 'POST' for row in self.wire.requests))
        self.assertEqual(Courses(BASE, 'fictional', self.wire).material(COURSE, mat, NOW), 'new')
        mutating = [method for _, method, route, _ in self.wire.requests if method == 'PUT' or route.endswith('/save_material')]
        self.assertEqual(mutating, ['PUT', 'POST'])
        self.assertEqual(Courses(BASE, 'fictional', self.wire).material(COURSE, mat, NOW), 'unchanged')
        self.assertEqual(len(self.wire.operations('save_material')), 1)

    def test_shared_material_does_not_break_course_inventory_or_gain_ownership(self):
        self.wire.rows['shared'] = {'id': 'shared', 'kind': 'material', 'version': 1, 'data': {'course_id': None}}
        self.wire.add_announcements('Body')
        report = self.run_areas('announcements', dry=True)
        row = self.course(report, 'announcements')
        self.assertTrue(report['ok'])
        self.assertEqual(row['changes'], [{'id': f'{COURSE.id}-announcement-8', 'action': 'new'}])
        self.assertFalse(self.wire.operations('get'))
        exact_id = f'{COURSE.id}-announcement-8'
        self.wire.rows[exact_id] = {'id': exact_id, 'kind': 'material', 'version': 1, 'data': {'course_id': None}}
        report = self.run_areas('announcements', dry=True)
        row = self.course(report, 'announcements')
        self.assertFalse(report['ok'])
        self.assertEqual(row['changes'], [])
        self.assertIn('baseline is for another course', row['reason'])
        self.assertFalse(self.wire.operations('save_material'))

    def test_task_without_course_ownership_is_still_rejected(self):
        self.wire.add_assignment()
        self.wire.add_task()
        self.wire.rows['saved-task']['data']['course_id'] = None
        report = self.run_areas('assignments', dry=True)
        row = self.course(report, 'assignments')
        self.assertFalse(report['ok'])
        self.assertIn('record scope', row['reason'])
        self.assertEqual(row['task_changes'], [])

    def test_optimistic_conflict_is_not_a_saved_change(self):
        self.wire.add_announcements('Body')
        self.wire.conflict = True
        report = self.run_areas('announcements')
        self.assertFalse(report['ok'])
        self.assertEqual(self.course(report, 'announcements')['changes'], [])

    def test_cross_origin_unsafe_routes_do_not_receive_cookie(self):
        for route in ('//another.example/d2l/a', '/d2l/../a', '/d2l/%2e%2e/a'):
            with self.subTest(route=route), self.assertRaises(ReadError):
                self.lms.get_json(route)
        self.assertEqual(self.wire.requests, [])

    def test_non_json_and_login_html_are_not_data_or_file(self):
        self.wire.lms[f'{LE}/news/'] = Reply(200, b'<html>Sign in</html>', 'text/html')
        report = self.run_areas('announcements')
        self.assertFalse(report['ok'])
        with self.assertRaises(ReadError):
            self.lms.get_file(f'{LE}/news/')

    def test_materials_skip_each_oversized_file_but_compare_later_files(self):
        self.wire.lms[f'{LE}/content/toc'] = {'Modules': [{'ModuleId': 1, 'Modules': [], 'Topics': [
            {'TopicId': 8, 'Title': 'Stream is too large', 'ActivityType': 1, 'Url': '/content/large.pdf'},
        ]}]}
        self.wire.lms[f'{LE}/content/topics/8/file'] = ResponseTooLarge('stream exceeds limit')
        self.wire.lms[f'{LE}/dropbox/folders/'] = []
        self.wire.lms[f'{LE}/news/'] = [{'Id': 8, 'Attachments': [
            {'FileId': 1, 'FileName': 'declared-large.pdf', 'FileSize': MAX_FILE + 1},
            {'FileId': 2, 'FileName': 'small.txt', 'FileSize': 3},
        ]}]
        self.wire.lms[f'{LE}/news/8/attachments/2'] = Reply(200, b'txt', 'text/plain')
        report = self.run_areas('materials', dry=True)
        row = self.course(report, 'materials')
        self.assertTrue(report['ok'])
        self.assertEqual(row['count'], 3)
        self.assertEqual([x['id'] for x in row['skips']], [
            f'{COURSE.id}-material-topic-8', f'{COURSE.id}-announcement-8-attachment-1',
        ])
        self.assertEqual(row['changes'], [{'id': f'{COURSE.id}-announcement-8-attachment-2', 'action': 'new'}])
        self.assertNotIn(f'{LE}/news/8/attachments/1', [x[2] for x in self.wire.requests])
        self.assertFalse(self.wire.operations('save_material'))
        self.assertFalse(any(request[1] == 'PUT' for request in self.wire.requests))
        self.assertIn('100 MiB', human_summary(report))

    def test_material_attachment_size_mismatch_is_a_failure_not_a_policy_skip(self):
        self.wire.lms[f'{LE}/content/toc'] = {'Modules': []}
        self.wire.lms[f'{LE}/dropbox/folders/'] = []
        self.wire.lms[f'{LE}/news/'] = [{'Id': 8, 'Attachments': [
            {'FileId': 2, 'FileName': 'small.txt', 'FileSize': 4},
        ]}]
        self.wire.lms[f'{LE}/news/8/attachments/2'] = Reply(200, b'txt', 'text/plain')
        report = self.run_areas('materials', dry=True)
        row = self.course(report, 'materials')
        self.assertFalse(report['ok'])
        self.assertIn('byte count does not match', row['reason'])
        self.assertEqual(row['skips'], [])

    def test_unapproved_destinations_fail_preflight_before_transport(self):
        for origins in (
            {'courses_base_url': 'https://unapproved.example/courses', 'brightspace_origin': BRIGHTSPACE_ORIGIN},
            {'courses_base_url': COURSES_API_BASE, 'brightspace_origin': 'https://unapproved.example'},
            {'courses_base_url': COURSES_API_BASE + '/wrong', 'brightspace_origin': BRIGHTSPACE_ORIGIN},
        ):
            with self.subTest(origins=origins), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / 'config.json'
                path.write_text(json.dumps({**origins, 'courses': {
                    COURSE.slug: {'id': COURSE.id, 'org_unit_id': COURSE.org_unit_id},
                }}), encoding='utf-8')
                errors = io.StringIO()
                with patch('courses_collector.cli.Brightspace') as lms, patch('courses_collector.cli.Courses') as service, \
                        contextlib.redirect_stderr(errors):
                    self.assertEqual(main(['--config', str(path), '--dry-run']), 2)
                    lms.assert_not_called()
                    service.assert_not_called()
                self.assertIn('no credentials sent', errors.getvalue())
                self.assertNotIn('unapproved.example', errors.getvalue())
        with self.assertRaisesRegex(ReadError, 'no credentials sent'):
            Courses(BASE, 'synthetic')
        with self.assertRaisesRegex(ReadError, 'no credentials sent'):
            Brightspace(ORIGIN, '1.67', 'synthetic')

    def test_missing_credentials_fail_before_network_io(self):
        errors = io.StringIO()
        with patch.dict(os.environ, {'BS_COOKIE': '', 'COURSES_PAT': ''}), \
                patch('courses_collector.cli.load_config', return_value=self.config), contextlib.redirect_stderr(errors):
            self.assertEqual(main(['--areas', 'announcements', '--dry-run']), 2)
        self.assertIn('BS_COOKIE and COURSES_PAT', errors.getvalue())

    def test_config_and_report_have_no_secret_fields_and_private_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'config.json'
            config.write_text(json.dumps({'courses_base_url': COURSES_API_BASE, 'brightspace_origin': BRIGHTSPACE_ORIGIN, 'courses': {
                COURSE.slug: {'id': COURSE.id, 'org_unit_id': COURSE.org_unit_id},
            }}), encoding='utf-8')
            self.assertEqual(load_config(str(config)), Config(BRIGHTSPACE_ORIGIN, COURSES_API_BASE, (COURSE,)))
            report = Path(folder) / 'report.json'
            write_report(str(report), '{}\n')
            self.assertEqual(report.read_text(encoding='utf-8'), '{}\n')
            self.assertEqual(report.stat().st_mode & 0o777, 0o600)
