"""Command entry point and owner-only JSON report output."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
from dataclasses import replace

from .collector import AREAS, collect, human_summary
from .config import load_config
from .model import ReadError
from .pages import RenderedPageReader
from .playwright_pages import PlaywrightCapture
from .store import Courses
from .transport import Brightspace


def write_report(path: str, text: str) -> None:
    destination = Path(path)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination.parent,
                                     prefix=".collector-", delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        except BaseException:
            temporary.unlink()
            raise
    try:
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", help="private collector.json override")
    parser.add_argument("--areas", nargs="+", help="space- or comma-separated subset, default: all eight")
    parser.add_argument("--course", action="append", help="restrict to these configured course slugs")
    parser.add_argument("--dry-run", action="store_true", help="read and compare, never write to courses service")
    parser.add_argument("--report", help="write JSON here and print only the human summary to stdout")
    args = parser.parse_args(argv)
    areas = tuple(area for arg in args.areas for area in arg.split(",")) if args.areas else AREAS
    if len(set(areas)) != len(areas) or set(areas) - set(AREAS):
        parser.error("--areas requires distinct names: " + ", ".join(AREAS))
    try:
        cookie = os.environ.get("BS_COOKIE", "").strip()
        pat = os.environ.get("COURSES_PAT", "").strip()
        if not cookie or not pat:
            raise ReadError("runtime BS_COOKIE and COURSES_PAT are both required")
        config = load_config(args.config)
        if args.course:
            requested = set(args.course)
            selected = tuple(c for c in config.courses if c.slug in requested)
            if len(selected) != len(requested):
                raise ReadError("unknown configured course")
            config = replace(config, courses=selected)
        client = Brightspace(config.brightspace_origin, config.le_version, cookie)
        courses = Courses(config.courses_base_url, pat, dry_run=args.dry_run)
        with PlaywrightCapture(config.brightspace_origin, cookie_header=cookie) as capture:
            page_reader = RenderedPageReader(config.brightspace_origin, capture)
            report = collect(config, areas, client, courses, page_reader)
        text = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.report:
            write_report(args.report, text)
            print(human_summary(report))
        else:
            sys.stdout.write(text)
            print(human_summary(report), file=sys.stderr)
        return 0 if report["ok"] else 1
    except ReadError as error:
        print(f"courses-collector: {error}", file=sys.stderr)
        return 2
    except OSError:
        print("courses-collector: could not write the private report", file=sys.stderr)
        return 2
