"""Synthetic wire fixtures; this suite never opens a socket or reads runtime state."""
from __future__ import annotations

import unittest
from dataclasses import dataclass, field

from courses_collector.areas import AreaReader, read_area
from courses_collector.model import Course, Material, ReadError, Reading


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
                'ModuleId': 1, 'Title': 'Module', 'Modules': [], 'Topics': [
                    {'TopicId': 2, 'Title': 'Slides', 'ActivityType': 1, 'Url': '/content/slides%20A.pdf'},
                    {'TopicId': 3, 'Title': 'Link', 'ActivityType': 2, 'Url': 'https://library.example.test/path?id=7'},
                    {'TopicId': 4, 'Title': 'Quiz', 'ActivityType': 4, 'Url': '/d2l/lms/quizzing/start'},
                    {'TopicId': 5, 'Title': 'Signed', 'ActivityType': 2, 'Url': 'https://library.example.test/path?X-Amz-Signature=secret'},
                ],
            }]},
            '/content/modules/1': {'Id': 1, 'Title': 'Module', 'Description': {'Text': BODY}},
            **{f'/content/topics/{i}': {'Id': i, 'Description': None} for i in (2, 3, 4, 5)},
            '/content/topics/2/file': b'%PDF-1.4 fixture',
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
        self.assertEqual(content.records[1].metadata['parent_platform_id'], '1')
        reader.read('announcements', COURSE, AT)
        materials = reader.read('materials', COURSE, AT)
        self.assertEqual([r.id for r in materials.records], [
            'sample-term-fixture-material-topic-2', 'sample-term-fixture-material-topic-3',
            'sample-term-fixture-assignment-8-attachment-9', 'sample-term-fixture-announcement-6-attachment-7',
        ])
        self.assertEqual(materials.records[0].filename, 'slides A.pdf')
        self.assertEqual(materials.records[0].download_path, PREFIX + '/content/topics/2/file')
        self.assertEqual(materials.records[0].url, ORIGIN + PREFIX + '/content/topics/2/file')
        self.assertEqual(materials.records[1].url, ORIGIN + PREFIX + '/content/topics/3')
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
                    {'ModuleId': 11, 'Title': 'Nested', 'Modules': [], 'Topics': [
                        {'TopicId': 13, 'Title': 'Read', 'ActivityType': 1},
                    ]},
                    {'ModuleId': 12, 'Title': 'Hidden', 'IsHidden': True},
                ]},
            ]},
            '/content/modules/10': {'Id': 10, 'Description': None},
            '/content/modules/11': {'Id': 11, 'Description': {'Html': '<p>Nested only</p>'}},
            '/content/topics/13': {'Id': 13, 'Description': {'Text': BODY}},
        })
        self.assertEqual(result.count, 3)
        self.assertEqual(result.records[1].metadata['parent_platform_id'], '10')
        self.assertEqual(result.records[2].metadata['parent_platform_id'], '11')
        self.assertEqual(result.records[1].text, '<p>Nested only</p>')
        self.assertEqual(result.records[1].metadata['body_format'], 'html')
        self.assertNotIn(('json', PREFIX + '/content/modules/12'), client.calls)

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
