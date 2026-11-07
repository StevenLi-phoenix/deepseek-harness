#!/bin/bash
# Entry of the AMS service dsh-upgrade: take the request, bring the build checkout to it, and run that checkout's
# self-upgrade.sh. To request an upgrade: write `main` or a commit into the request file, then `ams ctl start dsh-upgrade`.
set -euo pipefail
REQUEST=${DSH_UPGRADE_REQUEST:-/Users/dsh-runtime/.ams/services/dsh-upgrade/request}
WORK=${DSH_UPGRADE_WORK:-/Volumes/MiniSSD/dsh-self}
REPO=${DSH_UPGRADE_REPO:-https://github.com/StevenLi-phoenix/deepseek-harness}
[ -f "$REQUEST" ] || { echo "dsh-upgrade: no request"; exit 0; }
TARGET=$(cat "$REQUEST")
rm "$REQUEST"
case "$TARGET" in
  main) REV=origin/main ;;
  *[!0-9a-f]* | "") echo "dsh-upgrade: bad request: $TARGET" >&2; exit 1 ;;
  *) REV=$TARGET ;;
esac
# AMS gives a service its own HOME and a short PATH; the build needs the service user's gh login and the Homebrew tools.
export HOME=/Users/dsh-runtime PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=/tmp
export npm_config_store_dir=$WORK/pnpm-store
mkdir -p "$WORK/logs"
LOG="$WORK/logs/upgrade-$(date +%Y%m%d%H%M%S).log"
echo "dsh-upgrade: $TARGET, log $LOG"
# Under AMS every stderr line can become an escalation; the build's noise stays in the log, and the exit code reports.
# A request that cannot start says so on the real stderr: self-upgrade.sh, which reports everything later, has not run yet.
exec 3>&2 >>"$LOG" 2>&1
refuse() { echo "dsh-upgrade: $1" | tee /dev/fd/3; exit 1; }
[ -d "$WORK/wt/.git" ] || git clone -q --filter=blob:none --branch main "$REPO" "$WORK/wt"
cd "$WORK/wt"
git fetch -q origin main || refuse "cannot fetch origin main; nothing was deployed"
git merge-base --is-ancestor "$REV" origin/main 2>/dev/null || refuse "$TARGET is not on main; nothing was deployed. Push it first."
git checkout -q --force --detach "$REV"
git clean -fdq
exec fork/deploy/self-upgrade.sh 3>&-
