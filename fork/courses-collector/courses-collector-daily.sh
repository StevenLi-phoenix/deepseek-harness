#!/bin/sh
# The caller's secret-aware launcher supplies the existing cookie and PAT as env.
set -eu
if [ -z "${BS_COOKIE:-}" ] || [ -z "${COURSES_PAT:-}" ]; then
  printf '%s\n' 'courses-collector: runtime BS_COOKIE and COURSES_PAT are both required' >&2
  exit 2
fi
state="${DSH_HOME:-$HOME/.dsh}/data/courses"
cd "$(dirname "$0")"
exec "${PYTHON:-python3}" -m courses_collector --report "$state/collector-report.json" "$@"
