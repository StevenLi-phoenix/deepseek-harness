#!/usr/bin/env python3
"""Failure-mode tests for bs-collect.py.

The point is not "the script runs"; it is that every way a read can go wrong ends as a
visible failure instead of an "ok" that reads like "nothing changed".

Run: ./run-bs-tests.sh from the collector package.
"""
from __future__ import annotations

import io
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from courses_collector import assignments as bs

COURSES = {f"course-{i}": i for i in range(1, 8)}


def folder(fid: int, name: str, due: str | None = "2026-11-24T16:00:00.000Z") -> dict:
    return {"Id": fid, "Name": name, "DueDate": due, "IsHidden": False, "GroupTypeId": 0}


def submitted(date: str, files: int = 1) -> dict:
    return {"Entity": {"DisplayName": "Synthetic Student"}, "Status": 1, "Submissions": [
        {"Id": 1, "SubmissionDate": date, "Files": [{"Id": n} for n in range(files)]}
    ]}


def not_submitted() -> dict:
    return {"Entity": {"DisplayName": "Synthetic Student"}, "Status": 0, "Submissions": []}


class FakeApi:
    """A fetch that answers from a map of path -> value or exception."""

    def __init__(self, answers: dict[str, object]):
        self.answers = answers
        self.calls: list[str] = []

    def __call__(self, path: str, cookie: str):
        self.calls.append(path)
        value = self.answers.get(path)
        if value is None:
            raise bs.ReadError("http 404")
        if isinstance(value, Exception):
            raise value
        return value


def one_course(answers: dict[str, object]):
    api = FakeApi(answers)
    payload = bs.collect("d2lSessionVal=x", {"example": 900001}, api)
    return payload, api


class FolderListTests(unittest.TestCase):
    def test_empty_folder_list_is_a_failure_not_a_course_without_work(self):
        payload, _ = one_course({"/900001/dropbox/folders/": []})
        course = payload["courses"]["example"]
        self.assertEqual(course["status"], "failed")
        self.assertIn("empty list", course["reason"])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["failed_courses"], ["example"])

    def test_rendered_shell_shape_is_a_failure(self):
        # What the browser read returned: a dict with url/title, no rows.
        payload, _ = one_course({"/900001/dropbox/folders/": {"url": "x", "title": {"content": "Assignments"}}})
        course = payload["courses"]["example"]
        self.assertEqual(course["status"], "failed")
        self.assertIn("expected a list", course["reason"])

    def test_folder_missing_id_is_a_failure(self):
        payload, _ = one_course({"/900001/dropbox/folders/": [{"Name": "No id"}]})
        self.assertEqual(payload["courses"]["example"]["status"], "failed")
        self.assertIn("missing integer Id", payload["courses"]["example"]["reason"])

    def test_folder_missing_name_is_a_failure(self):
        payload, _ = one_course({"/900001/dropbox/folders/": [{"Id": 5}]})
        self.assertEqual(payload["courses"]["example"]["status"], "failed")
        self.assertIn("missing Name", payload["courses"]["example"]["reason"])


class SubmissionTests(unittest.TestCase):
    def test_submitted_carries_date_and_file_count(self):
        payload, _ = one_course({
            "/900001/dropbox/folders/": [folder(1, "Sample assignment")],
            "/900001/dropbox/folders/1/submissions/": [submitted("2026-11-21T03:59:53.960Z", files=3)],
        })
        row = payload["courses"]["example"]["folders"][0]
        self.assertEqual(row["status"], "submitted")
        self.assertEqual(row["submitted_at"], "2026-11-20T22:59:53.960000-05:00")
        self.assertEqual(row["files"], 3)
        self.assertTrue(payload["ok"])

    def test_no_submissions_is_not_submitted(self):
        payload, _ = one_course({
            "/900001/dropbox/folders/": [folder(1, "Lab 7")],
            "/900001/dropbox/folders/1/submissions/": [not_submitted()],
        })
        self.assertEqual(payload["courses"]["example"]["folders"][0]["status"], "not_submitted")
        self.assertTrue(payload["ok"])

    def test_several_submissions_take_the_latest(self):
        payload, _ = one_course({
            "/900001/dropbox/folders/": [folder(1, "Lab 7")],
            "/900001/dropbox/folders/1/submissions/": [
                submitted("2026-11-01T10:00:00.000Z", files=1),
                submitted("2026-11-21T17:05:37.130Z", files=2),
            ],
        })
        row = payload["courses"]["example"]["folders"][0]
        self.assertEqual(row["submitted_at"], "2026-11-21T12:05:37.130000-05:00")
        self.assertEqual(row["files"], 2)

    def test_unreadable_submissions_leave_the_folder_unknown_and_the_course_failed(self):
        payload, _ = one_course({
            "/900001/dropbox/folders/": [folder(1, "Lab 7"), folder(2, "Lab 8")],
            "/900001/dropbox/folders/1/submissions/": [submitted("2026-11-21T17:05:37.130Z")],
            # folder 2 has no answer -> ReadError(http 404)
        })
        course = payload["courses"]["example"]
        self.assertEqual(course["status"], "failed")
        self.assertIn("1 of 2 folders unreadable", course["reason"])
        statuses = [row["status"] for row in course["folders"]]
        self.assertEqual(statuses, ["submitted", "unknown"])
        self.assertFalse(payload["ok"])

    def test_submissions_payload_of_wrong_shape_is_a_failure(self):
        payload, _ = one_course({
            "/900001/dropbox/folders/": [folder(1, "Lab 7")],
            "/900001/dropbox/folders/1/submissions/": {"Items": []},
        })
        self.assertEqual(payload["courses"]["example"]["status"], "failed")
        self.assertEqual(payload["courses"]["example"]["folders"][0]["status"], "unknown")


class TransportTests(unittest.TestCase):
    def test_expired_session_is_reported_per_course(self):
        payload, _ = one_course({"/900001/dropbox/folders/": bs.ReadError("http 401")})
        self.assertEqual(payload["courses"]["example"]["status"], "failed")
        self.assertIn("http 401", payload["courses"]["example"]["reason"])

    def test_network_failure_is_reported(self):
        payload, _ = one_course({"/900001/dropbox/folders/": bs.ReadError("network timeout")})
        self.assertEqual(payload["courses"]["example"]["status"], "failed")
        self.assertIn("network timeout", payload["courses"]["example"]["reason"])

    def test_missing_cookie_exits_two_and_never_reports_ok(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err), patch.dict("os.environ", {"BS_COOKIE": ""}):
            code = bs.main([])
        self.assertEqual(code, 2)
        self.assertIn("BS_COOKIE", err.getvalue())

    def test_all_courses_fail_when_nothing_answers(self):
        payload = bs.collect("d2lSessionVal=x", COURSES, FakeApi({}))
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["failed_count"], payload["expected_courses"])
        self.assertEqual(len(payload["failed_courses"]), len(COURSES))

    def test_seven_courses_are_expected(self):
        payload = bs.collect("d2lSessionVal=x", COURSES, FakeApi({}))
        self.assertEqual(payload["expected_courses"], 7)
        self.assertEqual(sorted(payload["courses"]), sorted(COURSES))


class ExitCodeTests(unittest.TestCase):
    def test_json_error_body_is_not_ok(self):
        payload = bs.collect("d2lSessionVal=x", {"example": 900001}, FakeApi({
            "/900001/dropbox/folders/": bs.ReadError("not json (209 bytes)")
        }))
        self.assertFalse(payload["ok"])
        self.assertIn("not json (209 bytes)", payload["courses"]["example"]["reason"])




class GroupFolderTests(unittest.TestCase):
    def test_group_folder_is_never_guessed_from_the_api(self):
        api = FakeApi({"/900001/dropbox/folders/": [
            {"Id": 1, "Name": "Individual Lab", "DueDate": None, "IsHidden": False, "GroupTypeId": 0},
            {"Id": 2, "Name": "Team Proposal", "DueDate": None, "IsHidden": False, "GroupTypeId": 21},
        ], "/900001/dropbox/folders/1/submissions/": [not_submitted()]})
        payload = bs.collect("d2lSessionVal=x", {"example": 900001}, api)
        rows = payload["courses"]["example"]["folders"]
        by_id = {row["folder_id"]: row for row in rows}
        self.assertEqual(by_id[1]["status"], "not_submitted")
        self.assertEqual(by_id[2]["status"], "unknown")
        self.assertTrue(by_id[2]["needs_ui"])
        self.assertIn("403", by_id[2]["reason"])
        # A group folder alone must not fail the course, but it must be counted.
        self.assertEqual(payload["courses"]["example"]["status"], "ok")
        self.assertEqual(payload["courses"]["example"]["counts"]["needs_ui"], 1)
        self.assertEqual(api.calls, ["/900001/dropbox/folders/", "/900001/dropbox/folders/1/submissions/"])




class ClosedFolderTests(unittest.TestCase):
    def test_closed_folder_needs_the_page_rather_than_failing_the_course(self):
        api = FakeApi({
            "/900001/dropbox/folders/": [
                {"Id": 1, "Name": "Open lab", "DueDate": None, "IsHidden": False, "GroupTypeId": 0},
                {"Id": 2, "Name": "Closed notebook", "DueDate": None, "IsHidden": False, "GroupTypeId": 0},
            ],
            "/900001/dropbox/folders/1/submissions/": [submitted("2026-11-21T17:05:37.130Z")],
            "/900001/dropbox/folders/2/submissions/": bs.ReadError("http 403"),
        })
        payload = bs.collect("d2lSessionVal=x", {"example": 900001}, api)
        course = payload["courses"]["example"]
        by_id = {row["folder_id"]: row for row in course["folders"]}
        self.assertEqual(by_id[1]["status"], "submitted")
        self.assertEqual(by_id[2]["status"], "unknown")
        self.assertTrue(by_id[2]["needs_ui"])
        self.assertIn("403", by_id[2]["reason"])
        self.assertEqual(course["status"], "ok")
        self.assertEqual(course["counts"]["needs_ui"], 1)
        self.assertTrue(payload["ok"])

    def test_server_error_still_fails_the_course(self):
        api = FakeApi({
            "/900001/dropbox/folders/": [
                {"Id": 1, "Name": "Lab", "DueDate": None, "IsHidden": False, "GroupTypeId": 0},
            ],
            "/900001/dropbox/folders/1/submissions/": bs.ReadError("http 500"),
        })
        payload = bs.collect("d2lSessionVal=x", {"example": 900001}, api)
        self.assertEqual(payload["courses"]["example"]["status"], "failed")
        self.assertFalse(payload["ok"])




class MaterialTests(unittest.TestCase):
    def test_requirements_and_attachments_are_collected(self):
        api = FakeApi({
            "/900001/dropbox/folders/": [{
                "Id": 7, "Name": "Practice notebook", "DueDate": None, "IsHidden": False, "GroupTypeId": 0,
                "CustomInstructions": {"Text": "Must be .docx\nTitle must be: Name - Practice notebook"},
                "Attachments": [{"Id": 42, "FileName": "template.docx", "Size": 2048}],
            }],
            "/900001/dropbox/folders/7/submissions/": [not_submitted()],
        })
        payload = bs.collect("d2lSessionVal=x", {"example": 900001}, api)
        row = payload["courses"]["example"]["folders"][0]
        self.assertIn("Must be .docx", row["requirements"])
        self.assertEqual(row["attachments"][0]["name"], "template.docx")
        self.assertIn("/900001/dropbox/folders/7/attachments/42", row["attachments"][0]["url"])

    def test_a_folder_without_material_is_empty_not_missing(self):
        api = FakeApi({
            "/900001/dropbox/folders/": [{"Id": 8, "Name": "Lab", "DueDate": None, "IsHidden": False, "GroupTypeId": 0}],
            "/900001/dropbox/folders/8/submissions/": [not_submitted()],
        })
        payload = bs.collect("d2lSessionVal=x", {"example": 900001}, api)
        row = payload["courses"]["example"]["folders"][0]
        self.assertEqual(row["requirements"], "")
        self.assertEqual(row["attachments"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
