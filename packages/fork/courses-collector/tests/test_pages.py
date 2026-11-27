"""Synthetic rendered capture and network-policy tests; no browser/network required."""
from dataclasses import replace
from types import SimpleNamespace
import unittest

from courses_collector.model import Course, ReadError
from courses_collector.pages import PageCapture, PageLink, PageRow, RenderedPageReader, landing_url
from courses_collector.playwright_pages import PlaywrightCapture, _route_get, _safe_request

ORIGIN = 'https://learn.example.test'
COURSE = Course('demo', 'demo-course', 42)
AT = '2040-02-02T20:10:10Z'


def capture_for(area, rows=(), **fields):
    return PageCapture(landing_url(ORIGIN, area, COURSE.org_unit_id), rows=tuple(rows), **fields)


def reader_for(page):
    return RenderedPageReader(ORIGIN, lambda url, area: page)


class RenderedListTests(unittest.TestCase):
    def test_shell_wrong_status_url_and_loading_rejected(self):
        area = 'quizzes'
        page = capture_for(area)
        quiz = PageRow('Workshop', ('Workshop', '0 / 2'), (
            PageLink('Workshop', '/d2l/lms/quizzing/user/quiz_summary.d2l?ou=42&qi=501'),))
        for changed in (
            page, replace(page, status=403, rows=(quiz,)), replace(page, main=False, rows=(quiz,)),
            replace(page, auth_required=True, rows=(quiz,)), replace(page, busy=True, rows=(quiz,)),
            replace(page, paginated=True, rows=(quiz,)), replace(page, rows=(quiz,), url=page.url.replace('42', '43')),
            replace(page, rows=(quiz,), url=page.url + '#section'),
            replace(page, rows=(quiz,), url=page.url.replace('learn.example.test', 'other.example.test')),
        ):
            with self.subTest(changed=changed), self.assertRaises(ReadError):
                reader_for(changed)(area, COURSE, AT)

    def test_quiz_safe_link_identity_and_attempt_cell(self):
        page = capture_for('quizzes', [PageRow('Workshop\n0 / 2', ('Workshop', '0 / 2'), (
            PageLink('Workshop', '/d2l/lms/quizzing/user/quiz_summary.d2l?qi=501&ou=42&transient=example'),))])
        called = []

        def capture(url, area):
            called.append((url, area))
            return page

        reading = RenderedPageReader(ORIGIN, capture)('quizzes', COURSE, AT)
        self.assertEqual(called, [(page.url, 'quizzes')])
        self.assertEqual((reading.source, reading.count), ('page', 1))
        quiz = reading.records[0]
        self.assertEqual(quiz.id, 'demo-course-quiz-501')
        self.assertEqual(quiz.url, ORIGIN + '/d2l/lms/quizzing/user/quiz_summary.d2l?ou=42&qi=501')
        self.assertEqual(quiz.metadata['attempts_display'], '0 / 2')

    def test_unsafe_wrong_course_and_duplicate_query_quiz_links_not_evidence(self):
        for href in (
            '/d2l/lms/quizzing/user/quiz_start_frame_auto.d2l?qi=501&ou=42',
            '/d2l/lms/quizzing/user/quiz_summary.d2l?qi=501&ou=41',
            '/d2l/lms/quizzing/user/quiz_summary.d2l?qi=501&ou=42&ou=41',
            '//other.example.test/d2l/lms/quizzing/user/quiz_summary.d2l?qi=501&ou=42',
            '//learn.example.test:444/d2l/lms/quizzing/user/quiz_summary.d2l?qi=501&ou=42',
        ):
            page = capture_for('quizzes', [PageRow('Workshop', ('Workshop', '0 / 2'), (PageLink('Workshop', href),))])
            with self.subTest(href=href), self.assertRaises(ReadError):
                reader_for(page)('quizzes', COURSE, AT)

    def test_topic_rows_do_not_include_posts_or_external_links(self):
        page = capture_for('discussions', [PageRow('Forum topic\nParticipant message is not collected', (), (
            PageLink('Forum topic', '/d2l/le/42/discussions/topics/100/View?session=ephemeral'),))])
        topic, = reader_for(page)('discussions', COURSE, AT).records
        self.assertEqual((topic.id, topic.kind, topic.url, topic.text), (
            'demo-course-discussion-topic-100', 'discussion', ORIGIN + '/d2l/le/42/discussions/topics/100/View', None))

    def test_announcement_requires_proven_index_permalink_and_body(self):
        root = '/d2l/le/news/42/701/view'
        index = capture_for('announcements', [PageRow('Notice', (), (PageLink('Notice', root + '?ou=42&session=demo'),))])
        detail_url = ORIGIN + root + '?ou=42'
        detail = PageCapture(detail_url, headings=('Announcements', 'Notice'), body='First paragraph.\n\nSecond paragraph.',
                             body_links=(PageLink('Resource', 'https://articles.example.test/source#section'),
                                         PageLink('Signed', '/resource?credential=demo')),
                             announced_at='2040-02-02T15:00:00-05:00')
        calls = []

        def capture(url, area):
            calls.append((url, area))
            return index if area == 'announcements' else detail

        result = RenderedPageReader(ORIGIN, capture)('announcements', COURSE, AT)
        self.assertEqual(calls, [(index.url, 'announcements'), (detail_url, 'announcement_detail')])
        notice, = result.records
        self.assertEqual((notice.id, notice.url, notice.text), ('demo-course-announcement-701', detail_url, detail.body))
        self.assertEqual(notice.metadata['links'], ['https://articles.example.test/source'])
        self.assertEqual(notice.metadata['posted_at'], detail.announced_at)
        for invalid in (replace(detail, url=detail_url.replace('701', '702')), replace(detail, body=''),
                        replace(detail, headings=('Unrelated',)), replace(detail, main=False)):
            with self.subTest(invalid=invalid), self.assertRaises(ReadError):
                RenderedPageReader(ORIGIN, lambda url, area: index if area == 'announcements' else invalid)(
                    'announcements', COURSE, AT)
        for bad in (replace(index, paginated=True), replace(index, rows=(
                    PageRow('Notice', (), (PageLink('Notice', root.replace('/42/', '/43/')),)),))):
            calls.clear()
            with self.assertRaises(ReadError):
                RenderedPageReader(ORIGIN, lambda url, area: (calls.append(area), bad)[1])('announcements', COURSE, AT)
            self.assertEqual(calls, ['announcements'])

    def test_content_and_materials_attempt_fixed_index_and_fail_closed(self):
        for area in ('content', 'materials'):
            calls = []
            page = capture_for(area, content_index=True)
            reader = RenderedPageReader(ORIGIN, lambda url, purpose: (calls.append((url, purpose)), page)[1])
            with self.assertRaisesRegex(ReadError, 'cannot prove complete hierarchy or files'):
                reader(area, COURSE, AT)
            self.assertEqual(calls, [(ORIGIN + '/d2l/le/content/42/Home', area)])

    def test_grade_table_and_synthetic_stable_id(self):
        headers = PageRow('', ('Grade Item', 'Points', 'Grade'), header=True)
        stable = PageRow('Workshop: 7 / 10', ('Workshop', '7 / 10', '70%'), grade_object_id='19')
        no_id = PageRow('Essay: 8 / 10', ('Essay', '8 / 10', '80%'))
        page = capture_for('grades', [headers, stable, no_id])
        got = reader_for(page)('grades', COURSE, AT)
        self.assertEqual(got.records[0].id, 'demo-course-grade-19')
        self.assertEqual(got.records[0].metadata['points_display'], '7 / 10')
        self.assertTrue(got.records[1].id.startswith('demo-course-grade-page-'))
        page = replace(page, rows=(headers, stable, replace(no_id, cells=('Essay', '9 / 10', '90%'))))
        self.assertEqual(reader_for(page)('grades', COURSE, AT).records[1].id, got.records[1].id)

    def test_empty_requires_explicit_content_and_loaded_page(self):
        for area, exact in [('assignments', 'No assignments found.'), ('quizzes', 'There are no quizzes.'),
                            ('discussions', 'No discussions found.'), ('grades', 'No grade items found.')]:
            with self.subTest(area=area):
                page = capture_for(area, notices=(exact,))
                self.assertEqual(reader_for(page)(area, COURSE, AT).count, 0)
                with self.assertRaises(ReadError):
                    reader_for(replace(page, busy=True))(area, COURSE, AT)

    def test_partial_lists_and_ambiguous_grade_id_fail(self):
        header = PageRow('', ('Grade Item', 'Points'), header=True)
        grade = PageRow('', ('Workshop', '7 / 10'), grade_object_id='19')
        with self.assertRaises(ReadError):
            reader_for(capture_for('grades', [header, grade, grade]))('grades', COURSE, AT)
        quiz = PageRow('Workshop', ('Workshop', '0 / 2'), (
            PageLink('Workshop', '/d2l/lms/quizzing/user/quiz_summary.d2l?ou=42&qi=501'),))
        bad_quiz = PageRow('Unknown item', ('Unknown item', '0 / 1'))
        with self.assertRaises(ReadError):
            reader_for(capture_for('quizzes', [quiz, bad_quiz]))('quizzes', COURSE, AT)

    def test_assignment_status_uses_column_and_exact_unique_name_even_when_unlinked(self):
        header = PageRow('', ('Assignments', 'Completion Status', 'Evaluation Status'), header=True)
        linked = PageRow('', ('Lab', 'Not Submitted', '1 Submission'), (
            PageLink('Lab', '/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=42&db=15'),))
        closed = PageRow('', ('Lab final\nDue on Feb 2, 2040 8:00 PM', '1 Submission, 2 Files', ''))
        doubled = PageRow('', ('Repeated', '1 Submission', ''))
        reader = reader_for(capture_for('assignments', [header, linked, closed, doubled, doubled]))
        self.assertEqual(reader.assignment_statuses(COURSE, ['Lab', 'Lab final', 'Repeated', 'Missing']), {
            'Lab': 'not_submitted', 'Lab final': 'submitted', 'Repeated': 'unknown', 'Missing': 'unknown'})
        with self.assertRaises(ReadError):
            reader.assignment_task_rows(COURSE)
        with self.assertRaises(ReadError):
            reader.assignment_page(COURSE)
        single = reader_for(capture_for('assignments', [header, closed]))
        self.assertIn('Lab final\nDue on Feb 2, 2040 8:00 PM\n1 Submission, 2 Files', single.assignment_page(COURSE))
        externally_submitted = replace(COURSE, assignment_submissions=False)
        self.assertEqual(single.assignment_statuses(externally_submitted, ['Lab final']), {'Lab final': 'unknown'})

    def test_assignment_list_only_uses_proven_ids_and_real_dates(self):
        header = PageRow('', ('Assignment', 'Submission Status'), header=True)
        data = PageRow('', ('Workshop\nDue on Feb 2, 2040 8:00 PM', '1 Submission'), (
            PageLink('Workshop', '/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=42&db=15'),))
        read = reader_for(capture_for('assignments', [header, data]))
        task, = read.assignment_task_rows(COURSE)
        self.assertEqual((task.platform_id, task.due_at, task.submission_status), ('15', '2040-02-02T20:00:00-05:00', 'submitted'))
        self.assertTrue(task.due_known)
        without_due = replace(data, cells=('Workshop', '1 Submission'))
        omitted_task, = reader_for(capture_for('assignments', [header, without_due])).assignment_task_rows(COURSE)
        self.assertIsNone(omitted_task.due_at)
        self.assertFalse(omitted_task.due_known)
        for unsafe in (replace(data, links=(PageLink('Workshop', data.links[0].href.replace('ou=42', 'ou=41')),)),
                       replace(data, cells=('Workshop\nDue on tomorrow', '1 Submission'))):
            with self.assertRaises(ReadError):
                reader_for(capture_for('assignments', [header, unsafe])).assignment_task_rows(COURSE)


class BrowserGuardTests(unittest.TestCase):
    def test_network_allowlist(self):
        expected = landing_url(ORIGIN, 'quizzes', 42)
        self.assertTrue(_safe_request(expected, expected, 'GET', 'document', True))
        self.assertTrue(_safe_request(expected, ORIGIN + '/d2l/common/example.js', 'GET', 'script', False))
        for url, method, kind, main in (
            (expected, 'POST', 'document', True), (expected, 'GET', 'document', False),
            (expected + '&x=1', 'GET', 'document', True),
            (ORIGIN + '/d2l/lms/quizzing/user/quiz_start_frame_auto.d2l?ou=42&qi=9', 'GET', 'document', True),
            (ORIGIN + '/d2l/common/example.js', 'GET', 'xhr', False),
            (ORIGIN + '/d2l/common/../example.js', 'GET', 'script', False),
            ('https://unexpected.example.test/d2l/common/example.js', 'GET', 'script', False),
            ('https://learn.example.test:444/d2l/common/example.js', 'GET', 'script', False),
        ):
            with self.subTest(url=url, method=method, kind=kind):
                self.assertFalse(_safe_request(expected, url, method, kind, main))

    def test_network_redirects_blocked_and_only_html_documents_admitted(self):
        expected = landing_url(ORIGIN, 'grades', 42)
        frame = object()
        request = SimpleNamespace(resource_type='document', is_navigation_request=lambda: True,
                                  frame=frame, url=expected, method='GET')
        for status, headers, outcome in (
            (302, {'location': 'https://login.example.test'}, ('abort', 'blockedbyclient')),
            (200, {'content-type': 'application/json'}, ('abort', 'blockedbyclient')),
            (200, {'content-type': 'text/html', 'content-disposition': 'attachment'}, ('abort', 'blockedbyclient')),
            (200, {'content-type': 'text/html; charset=utf-8'}, ('fulfill', 200)),
            (403, {}, ('fulfill', 403)),
        ):
            actions = []
            response = SimpleNamespace(url=expected, status=status, headers=headers,
                                       dispose=lambda: actions.append(('dispose',)))

            def fake_fetch(**kwargs):
                actions.append(('fetch', kwargs))
                return response

            route = SimpleNamespace(fetch=fake_fetch, abort=lambda reason: actions.append(('abort', reason)),
                                    fulfill=lambda response: actions.append(('fulfill', response.status)))
            _route_get(route, request, expected, SimpleNamespace(main_frame=frame), 5000)
            self.assertEqual(actions, [('fetch', {'max_redirects': 0, 'timeout': 5000}), outcome, ('dispose',)])

    def test_production_capture_rejects_wrong_route_and_no_session_before_launch(self):
        with PlaywrightCapture(ORIGIN, cookie_header='') as capture:
            with self.assertRaisesRegex(ReadError, 'approved rendered list route'):
                capture(ORIGIN + '/d2l/lms/quizzing/user/quiz_start_frame_auto.d2l?ou=42', 'quizzes')
            with self.assertRaisesRegex(ReadError, 'authorized Brightspace session'):
                capture(landing_url(ORIGIN, 'quizzes', 42), 'quizzes')


if __name__ == '__main__':
    unittest.main()
