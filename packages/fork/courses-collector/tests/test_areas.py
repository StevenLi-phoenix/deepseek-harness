"""Synthetic wire fixtures; this suite never opens a socket or reads runtime state."""
from __future__ import annotations

import unittest
from dataclasses import dataclass, field

from courses_collector.areas import MAX_TOC_DESCRIPTION_BYTES, AreaReader, read_area
from courses_collector.model import Course, Material, NeedsUI, ReadError, Reading


COURSE = Course('fixture', 'sample-term-fixture', 123)
ORIGIN = 'https://lms.example.test'
PREFIX = '/d2l/api/le/1.92/123'
AT = '2030-09-14T01:02:03Z'
BODY = '\nFirst line.  \n\n Second line.\n'


@dataclass
class FakeClient:
    replies: dict
    base_url: str = ORIGIN
    le_version: str = '1.92'
    calls: list = field(default_factory=list)

    def _get(self, kind, path):
        self.calls.append((kind, path))
        result = self.replies[path]
        if isinstance(result, Exception):
            raise result
        return result

    def get_json(self, path):
        return self._get('json', path)

    def get_file(self, path):
        return self._get('file', path)


def read(area, routes, page_reader=None):
    client = FakeClient({PREFIX + path: value for path, value in routes.items()})
    return read_area(area, course=COURSE, client=client, page_reader=page_reader, checked_at=AT), client


class AreaTests(unittest.TestCase):
    def test_toc_missing_ids_skip_only_that_row_and_keep_identified_children(self):
        routes = {
            '/content/toc': {'Modules': [{
                'Title': 'Unnamed identity', 'Topics': [
                    {'TopicId': None, 'Title': 'No topic ID', 'ActivityType': 1},
                    {'TopicId': 5, 'Title': 'PDF', 'ActivityType': 1, 'Url': '/content/fixture.pdf'},
                ], 'Modules': [{'ModuleId': 9, 'Title': 'Nested', 'Modules': [], 'Topics': []}],
            }]},
            '/dropbox/folders/': [], '/news/': [],
        }
        client = FakeClient({PREFIX + path: value for path, value in routes.items()})
        reader = AreaReader(client)
        content = reader.read('content', COURSE, AT)
        materials = reader.read('materials', COURSE, AT)
        self.assertEqual([x.id for x in content.records], [
            f'{COURSE.id}-content-topic-5', f'{COURSE.id}-content-module-9',
        ])
        self.assertTrue(all('parent_platform_id' not in item.metadata for item in content.records))
        self.assertEqual([x.download_path for x in materials.records], [PREFIX + '/content/topics/5/file'])
        self.assertEqual([x['reason'] for x in materials.skips], ['no_id:Unnamed identity', 'no_id:No topic ID'])
        self.assertEqual(content.skips, materials.skips)
        self.assertEqual(client.calls.count(('json', PREFIX + '/content/toc')), 1)

    def test_toc_missing_id_notices_are_bounded_and_invalid_ids_still_fail(self):
        toc = {'Modules': [{'ModuleId': 10, 'Title': 'Deck', 'Modules': [], 'Topics': [
            {'Title': 'No ID'} for _ in range(65)
        ]}]}
        result, _ = read('content', {'/content/toc': toc})
        self.assertEqual(len(result.skips), 21)
        self.assertEqual(result.skips[-1]['reason'], 'no_id:45 more items omitted')
        for invalid_id in ('control\ncharacter', 'a' * 513, ''):
            with self.subTest(invalid_id=invalid_id), self.assertRaises(ReadError):
                read('content', {'/content/toc': {'Modules': [
                    {'ModuleId': invalid_id, 'Title': 'Invalid'},
                ]}})

    def test_announcement_is_verbatim_and_uses_the_per_course_id(self):
        result, client = read('announcements', {'/news/': [
            {'Id': 31, 'Title': 'Readings', 'Body': {'Text': BODY, 'Html':
                '<p>Read <a href="https://library.example.test/read?id=5">the handout</a>.'
                '<a href="https://library.example.test/?token=secret">Signed</a></p>'},
             'CreatedDate': '2030-09-12T04:00:00Z', 'Attachments': []},
            {'Id': 32, 'Title': 'Draft', 'IsPublished': False},
        ]})
        self.assertEqual(result.count, 1)
        self.assertEqual(result.records[0].text, BODY)
        self.assertEqual(result.records[0].metadata['links'], ['https://library.example.test/read?id=5'])
        self.assertNotIn('token=secret', repr(result))
        self.assertEqual(result.records[0].id, 'sample-term-fixture-announcement-31')
        self.assertEqual(result.records[0].url, ORIGIN + '/d2l/le/news/123/31/view?ou=123')
        self.assertEqual(client.calls, [('json', PREFIX + '/news/')])

    def test_own_grade_only_and_no_instructor_private_comments(self):
        result, client = read('grades', {'/grades/values/myGradeValues/': [
            {'GradeObjectIdentifier': '8', 'GradeObjectName': 'Score', 'DisplayedGrade': ' 0 / 2 ',
             'PointsNumerator': 0, 'Comments': {'Text': BODY}, 'PrivateComments': {'Text': 'private!'}},
        ]})
        grade = result.records[0]
        self.assertEqual(grade.id, 'sample-term-fixture-grade-8')
        self.assertEqual(grade.url, ORIGIN + PREFIX + '/grades/8/values/myGradeValue')
        self.assertEqual(grade.text, BODY)
        self.assertEqual(grade.metadata['displayed_grade'], ' 0 / 2 ')
        self.assertEqual(grade.metadata['points_numerator'], 0)
        self.assertNotIn('private!', repr(grade))
        self.assertEqual(len(client.calls), 1)

    def test_quiz_paginates_without_fetching_attempts_or_exposing_secret_fields(self):
        second = PREFIX + '/quizzes/?bookmark=next%2Bkey'
        result, client = read('quizzes', {
            '/quizzes/': {'Objects': [
                {'QuizId': 1, 'Name': 'One', 'Password': 'secret password', 'DueDate': '2030-09-15T00:00:00Z',
                 'EndDate': '2030-09-15T01:00:00Z',
                 'Description': {'Text': {'Text': BODY}, 'IsDisplayed': True},
                 'Instructions': {'Text': {'Text': 'Hidden'}, 'IsDisplayed': False}},
            ], 'Next': ORIGIN + second},
            '/quizzes/?bookmark=next%2Bkey': {'Objects': [{'QuizId': 2, 'Name': 'Two'}], 'Next': None},
        })
        self.assertEqual(result.count, 2)
        self.assertEqual(client.calls, [('json', PREFIX + '/quizzes/'), ('json', second)])
        quiz = result.records[0]
        self.assertEqual(quiz.metadata['due_at'], '2030-09-15T00:00:00Z')
        self.assertEqual(quiz.metadata['ends_at'], '2030-09-15T01:00:00Z')
        self.assertEqual(quiz.text, BODY)
        self.assertNotIn('secret password', repr(quiz))
        self.assertNotIn('Hidden', repr(quiz))

    def test_quiz_rejects_unsafe_and_repeated_continuations(self):
        for link in ('https://evil.example.test' + PREFIX + '/quizzes/?p=2',
                     PREFIX + '/quizzes/8/attempts/', PREFIX + '/quizzes/'):
            with self.subTest(link=link):
                client = FakeClient({PREFIX + '/quizzes/': {'Objects': [], 'Next': link}})
                with self.assertRaises(ReadError):
                    read_area('quizzes', course=COURSE, client=client, checked_at=AT)
                self.assertEqual(client.calls, [('json', PREFIX + '/quizzes/')])

    def test_discussion_reads_forums_and_topic_prompts_not_posts(self):
        result, client = read('discussions', {
            '/discussions/forums/': [{'ForumId': 1, 'Name': 'Forum', 'Description': {'Text': BODY}}],
            '/discussions/forums/1/topics/': [
                {'ForumId': 1, 'TopicId': 2, 'Name': 'Topic', 'Description': {'Text': BODY}},
                {'ForumId': 1, 'TopicId': 3, 'Name': 'Hidden', 'IsHidden': True},
            ],
        })
        self.assertEqual([r.id for r in result.records], [
            'sample-term-fixture-discussion-forum-1', 'sample-term-fixture-discussion-topic-2'])
        self.assertEqual(result.records[-1].text, BODY)
        self.assertEqual(len(client.calls), 2)

    def test_content_and_materials_share_inventory_without_visiting_topics(self):
        routes = {
            '/content/toc': {'Modules': [{
                'ModuleId': 1, 'Title': 'Module', 'Description': {'Text': BODY}, 'Modules': [], 'Topics': [
                    {'TopicId': 2, 'Title': 'Slides', 'ActivityType': 1, 'Url': '/content/slides%20A.pdf'},
                    {'TopicId': 3, 'Title': 'Link', 'ActivityType': 2, 'Url': 'https://library.example.test/path?id=7'},
                    {'TopicId': 4, 'Title': 'Quiz', 'ActivityType': 4, 'Url': '/d2l/lms/quizzing/start'},
                    {'TopicId': 5, 'Title': 'Signed', 'ActivityType': 2, 'Url': 'https://library.example.test/path?X-Amz-Signature=secret'},
                ],
            }]},
            '/news/': [{'Id': 6, 'Title': 'Notice', 'Body': {'Text': BODY}, 'Attachments': [
                {'FileId': 7, 'FileName': 'handout.txt', 'FileSize': 7},
            ]}],
            '/news/6/attachments/7': b'handout',
            '/dropbox/folders/': [{'Id': 8, 'Attachments': [{'Id': 9, 'FileName': 'template.txt', 'Size': 8}]}],
            '/dropbox/folders/8/attachments/9': b'template',
        }
        client = FakeClient({PREFIX + path: value for path, value in routes.items()})
        reader = AreaReader(client)
        content = reader.read('content', COURSE, AT)
        self.assertEqual(content.count, 5)
        self.assertEqual(content.records[0].text, BODY)
        self.assertEqual(content.records[1].metadata['parent_platform_id'], 1)
        self.assertIsNone(content.records[1].text)
        self.assertEqual(content.records[1].url, ORIGIN + PREFIX + '/content/toc#topic-2')
        reader.read('announcements', COURSE, AT)
        materials = reader.read('materials', COURSE, AT)
        self.assertEqual([r.id for r in materials.records], [
            'sample-term-fixture-material-topic-2', 'sample-term-fixture-material-topic-3',
            'sample-term-fixture-assignment-8-attachment-9', 'sample-term-fixture-announcement-6-attachment-7',
        ])
        self.assertEqual(materials.records[0].filename, 'slides A.pdf')
        self.assertEqual(materials.records[0].download_path, PREFIX + '/content/topics/2/file')
        self.assertEqual(materials.records[0].url, ORIGIN + PREFIX + '/content/topics/2/file')
        self.assertEqual(materials.records[1].url, ORIGIN + PREFIX + '/content/toc#link-topic-3')
        self.assertEqual(materials.records[1].metadata['target_url'], 'https://library.example.test/path?id=7')
        urls = [item.url for item in content.records + materials.records]
        self.assertEqual(len(set(urls)), len(urls))
        self.assertEqual(materials.records[2].download_path, PREFIX + '/dropbox/folders/8/attachments/9')
        self.assertEqual(materials.records[2].expected_size, 8)
        self.assertEqual(materials.records[3].download_path, PREFIX + '/news/6/attachments/7')
        self.assertEqual(materials.records[3].expected_size, 7)
        self.assertEqual(client.calls.count(('json', PREFIX + '/content/toc')), 1)
        self.assertEqual(client.calls.count(('json', PREFIX + '/news/')), 1)
        self.assertEqual(len([p for p in client.calls if p[0] == 'file']), 0)
        self.assertNotIn('X-Amz-Signature', repr(content))

    def test_nested_directory_preserves_hierarchy_and_excludes_hidden_subtrees(self):
        result, client = read('content', {
            '/content/toc': {'Modules': [
                {'ModuleId': 10, 'Title': 'Root', 'Topics': [], 'Modules': [
                    {'ModuleId': 11, 'Title': 'Nested', 'Description': {'Html': '<p>Nested only</p>'},
                     'Modules': [], 'Topics': [
                        {'TopicId': 13, 'Title': 'Read', 'ActivityType': 1, 'Description': BODY},
                    ]},
                    {'ModuleId': 12, 'Title': 'Hidden', 'IsHidden': True},
                ]},
            ]},
        })
        self.assertEqual(result.count, 3)
        self.assertEqual(result.records[1].metadata['parent_platform_id'], 10)
        self.assertEqual(result.records[2].metadata['parent_platform_id'], 11)
        self.assertEqual(result.records[1].text, '<p>Nested only</p>')
        self.assertEqual(result.records[1].metadata['body_format'], 'html')
        self.assertEqual(result.records[2].text, BODY)
        self.assertEqual(client.calls, [('json', PREFIX + '/content/toc')])

    def test_toc_description_budget_is_cumulative_utf8_and_exact(self):
        half = 'é' * (MAX_TOC_DESCRIPTION_BYTES // 4)
        module = {'ModuleId': 1, 'Title': 'A', 'Description': half, 'Modules': [], 'Topics': [
            {'TopicId': 2, 'Title': 'B', 'Description': {'Text': half}},
        ]}
        routes = {'/content/toc': {'Modules': [module]}}
        result, client = read('content', routes)
        self.assertEqual([record.text for record in result.records], [half, half])
        self.assertEqual(client.calls, [('json', PREFIX + '/content/toc')])
        module['Topics'][0]['Description']['Text'] += 'x'
        with self.assertRaisesRegex(ReadError, '2 MiB aggregate limit'):
            read('content', routes)

    def test_opaque_inventory_ids_keep_their_raw_types_and_never_make_unsafe_routes(self):
        module = {'ModuleId': 'module/opaque', 'Title': 'A', 'Modules': [], 'Topics': [
            {'TopicId': 2, 'Title': 'Numeric', 'ActivityType': 1},
            {'TopicId': '02', 'Title': 'Zero padded', 'ActivityType': 1},
            {'TopicId': 'File_A~2.3', 'Title': 'Single segment', 'ActivityType': 1,
             'Url': 'https://foreign.example.test/path/example.txt'},
            {'Identifier': '../topic%2funsafe', 'Title': 'Unsafe segment', 'ActivityType': 1,
             'Url': '/d2l/unapproved'},
        ]}
        routes = {
            '/content/toc': {'Modules': [module]},
            '/dropbox/folders/': [{'Id': 'folder/id', 'Attachments': [{'Id': 'safe', 'FileName': 'template.txt'}]}],
            '/news/': [{'Id': 8, 'Attachments': [{'FileId': '..', 'FileName': 'notice.txt'}]}],
        }
        result, client = read('materials', routes)
        numeric, padded, single, unsafe, assignment, notice = result.records
        self.assertEqual(numeric.id, COURSE.id + '-material-topic-2')
        self.assertEqual(numeric.metadata['platform_id'], 2)
        self.assertEqual(padded.metadata['platform_id'], '02')
        self.assertNotEqual(padded.id, numeric.id)
        self.assertEqual(single.download_path, PREFIX + '/content/topics/File_A~2.3/file')
        self.assertEqual(single.filename, 'example.txt')
        self.assertEqual(single.metadata['parent_platform_id'], 'module/opaque')
        for skipped in (unsafe, assignment, notice):
            self.assertIsNone(skipped.download_path)
            self.assertIn('safe single download path segment', skipped.skip_reason)
            self.assertRegex(skipped.id, r'^[a-z0-9.-]+$')
        self.assertEqual(unsafe.metadata['platform_id'], '../topic%2funsafe')
        self.assertEqual(assignment.metadata['assignment_platform_id'], 'folder/id')
        self.assertEqual(notice.metadata['platform_id'], '..')
        self.assertEqual(client.calls, [('json', PREFIX + path) for path in routes])
        reread, _ = read('materials', routes)
        self.assertEqual([item.id for item in result.records], [item.id for item in reread.records])
        content, _ = read('content', routes)
        self.assertEqual(content.records[0].metadata['platform_id'], 'module/opaque')
        self.assertNotIn('module/opaque', content.records[0].url)

    def test_invalid_opaque_ids_are_rejected_before_route_construction(self):
        for invalid in ('x' * 257, True, {}, 'x\x00y'):
            with self.subTest(invalid=invalid), self.assertRaises(ReadError):
                read('content', {'/content/toc': {'Modules': [
                    {'ModuleId': invalid, 'Title': 'Blocked', 'Topics': [], 'Modules': []},
                ]}})

    def test_only_unresolved_discussion_403_needs_ui(self):
        path = '/discussions/forums/'
        routes = {path: ReadError('forbidden', 403)}
        failures = [None, lambda *_: Reading(failure=ReadError('unverified page'))]
        for fallback in failures:
            with self.subTest(fallback=fallback), self.assertRaises(NeedsUI) as caught:
                read('discussions', routes, fallback)
            self.assertEqual(caught.exception.http_status, 403)
        verified, _ = read('discussions', routes, lambda *_: Reading(source='page', count=0))
        self.assertEqual((verified.source, verified.fallback_http, verified.count), ('page', 403, 0))
        for status in (401, 404, 429, 500):
            with self.subTest(status=status), self.assertRaises(ReadError) as caught:
                read('discussions', {path: ReadError('not a 403', status)})
            self.assertNotIsInstance(caught.exception, NeedsUI)
            self.assertEqual(caught.exception.http_status, status)

    def test_announcement_attachment_inventory_rejects_invalid_file_size(self):
        with self.assertRaisesRegex(ReadError, 'attachment size'):
            read('materials', {
                '/content/toc': {'Modules': []},
                '/dropbox/folders/': [],
                '/news/': [{'Id': 9, 'Title': 'A', 'Attachments': [
                    {'FileId': 10, 'FileName': 'one.txt', 'FileSize': -10},
                ]}],
                '/news/9/attachments/10': b'one',
            })

    def test_403_only_falls_back_and_reports_page_source(self):
        calls = []
        def page_reader(area, course, checked_at):
            calls.append((area, course, checked_at))
            return Reading(source='page', records=[Material('test', 'Example', ORIGIN, 'grade')], count=1)

        result, _ = read('grades', {'/grades/values/myGradeValues/': ReadError('forbidden', 403)}, page_reader)
        self.assertEqual((result.source, result.fallback_http, result.count), ('page', 403, 1))
        self.assertEqual(calls, [('grades', COURSE, AT)])
        for status in (401, 404, 429, 500):
            with self.subTest(status=status), self.assertRaises(ReadError):
                read('grades', {'/grades/values/myGradeValues/': ReadError('request failed', status)}, page_reader)
        self.assertEqual(len(calls), 1)

    def test_quiz_endpoint_404_can_use_the_verified_student_list(self):
        calls = []
        def page_reader(area, course, checked_at):
            calls.append((area, course, checked_at))
            return Reading(source='page', count=0)

        result, _ = read('quizzes', {'/quizzes/': ReadError('not found', 404)}, page_reader)
        self.assertEqual((result.source, result.fallback_http, result.count), ('page', 404, 0))
        self.assertEqual(calls, [('quizzes', COURSE, AT)])

        def unreadable(*_):
            raise ReadError('list not rendered')

        with self.assertRaises(ReadError) as error:
            read('quizzes', {'/quizzes/': ReadError('not found', 404)}, unreadable)
        self.assertEqual(error.exception.http_status, 404)
        self.assertIn('page fallback', str(error.exception))

    def test_incomplete_fallback_cannot_report_checked(self):
        def broken_page(*_):
            raise ReadError('navigation shell')

        with self.assertRaises(ReadError) as error:
            read('grades', {'/grades/values/myGradeValues/': ReadError('forbidden', 403)}, broken_page)
        self.assertEqual(error.exception.http_status, 403)

    def test_malformed_json_and_conflicting_ids_fail_closed(self):
        for payload in ({'error': 'Access denied'}, [None], [{'Id': '../news', 'Title': 'Unsafe'}],
                        [{'Id': 5, 'Title': 'A', 'Body': {'Text': ''}}, {'Id': 5, 'Title': 'B', 'Body': {'Text': ''}}]):
            with self.subTest(payload=payload), self.assertRaises(ReadError):
                read('announcements', {'/news/': payload})


if __name__ == '__main__':
    unittest.main()
