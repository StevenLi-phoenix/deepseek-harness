#!/usr/bin/env python3
"""Failure-mode tests for bs-page-rows.py: an unreadable page must never read as a fact."""

from __future__ import annotations

import unittest

from courses_collector import page_rows as page

ROW = """Assignment\tCompletion Status\tScore\tEvaluation Status
Sample lab A
Due on Nov 23, 2026 11:59 PM
\tNot Submitted\t
- / 10
\t
Sample lab B
Due on Nov 24, 2026 11:00 AM
\t1 Submission, 3 Files\t
- / 10
\t
"""


class PageRowTests(unittest.TestCase):
    def test_submitted_and_not_submitted_rows(self):
        result = page.parse(ROW, ["Sample lab A", "Sample lab B"])
        self.assertEqual(result["rows"]["Sample lab A"]["status"], "not_submitted")
        row = result["rows"]["Sample lab B"]
        self.assertEqual(row["status"], "submitted")
        self.assertEqual(row["files"], 3)
        self.assertTrue(result["ok"])

    def test_empty_shell_is_unreadable_and_not_a_status(self):
        shell = {"url": "https://school.example/...", "title": {"content": "Assignments"}}
        with self.assertRaises(SystemExit):
            page.page_text(shell)

    def test_missing_name_is_unreadable(self):
        result = page.parse(ROW, ["Lab 8"])
        self.assertEqual(result["rows"]["Lab 8"]["status"], "unreadable")
        self.assertFalse(result["ok"])

    def test_navigation_only_text_is_unreadable(self):
        nav = "Assignments - Example Course\nSynthetic Student\nContent\nAnnouncements\nGrades\n"
        result = page.parse(nav, ["Sample lab A"])
        self.assertFalse(result["ok"])

    def test_name_present_without_status_cell_is_unreadable(self):
        text = "Sample lab A\nDue on Nov 23, 2026 11:59 PM\n"
        result = page.parse(text, ["Sample lab A"])
        self.assertEqual(result["rows"]["Sample lab A"]["status"], "unreadable")
        self.assertIn("no status cell", result["rows"]["Sample lab A"]["reason"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
