#!/bin/bash
# Regression check for setup-profile.sh against an installed prefix, in throwaway DSH homes:
# a fresh home gets the owner layer and the event bundle; a pre-bundle composition copy is moved
# aside; a re-run keeps the owner's settings and extra dependencies; fresh and migrated homes
# compose the same profile.
# usage: check-setup-profile.sh <installed prefix>
set -euo pipefail
PREFIX=$(cd "${1:?installed prefix}" && pwd)
SETUP="$PREFIX/fork/deploy/setup-profile.sh"
BIN="$PREFIX/node_modules/@deepseek-ai/dsh/lib/bin.js"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/setup-profile.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
fail() { echo "check-setup-profile: FAIL: $*" >&2; exit 1; }
# Compose without starting; comments name file paths, so only entries are compared.
compose() { (cd "$1" && DSH_HOME="$1" node "$BIN" event --dump-config | /usr/bin/grep -v '^#'); }

FRESH="$WORK/fresh"; mkdir -p "$FRESH"
"$SETUP" "$FRESH" "$PREFIX" >/dev/null
PATCH="$FRESH/profiles/event/cordis.patch.yml"
cmp -s "$PATCH" "$PREFIX/fork/profiles/event/cordis.patch.yml" || fail "fresh owner layer differs from the shipped template"
/usr/bin/grep -q '"@deepseek-ai/dsh-event-bundle"' "$FRESH/profiles/event/package.json" || fail "event bundle missing from the manifest"
compose "$FRESH" > "$WORK/fresh.yml"
for id in event-bus github-sensor wechat preset-unattended; do
  /usr/bin/grep -q "^- id: $id\$" "$WORK/fresh.yml" || fail "composition lacks $id"
done
/usr/bin/grep -q "@deepseek-ai/dsh-owner-memory" "$WORK/fresh.yml" || fail "unattended preset lacks owner-memory"
/usr/bin/grep -q "@deepseek-ai/dsh-turn-taint" "$WORK/fresh.yml" || fail "unattended preset lacks turn-taint"
/usr/bin/grep -q "@deepseek-ai/dsh-tool-monitor" "$WORK/fresh.yml" || fail "unattended preset lacks tool-monitor"
/usr/bin/grep -q "@deepseek-ai/dsh-cc-bridge" "$WORK/fresh.yml" || fail "unattended preset lacks cc-bridge"
/usr/bin/grep -q "^- id: event-ingest$" "$WORK/fresh.yml" || fail "composition lacks event-ingest"
/usr/bin/grep -q "@deepseek-ai/dsh-sysmon" "$WORK/fresh.yml" || fail "composition lacks sysmon"
/usr/bin/grep -q "@deepseek-ai/dsh-owner-memory-admin" "$WORK/fresh.yml" || fail "composition lacks owner-memory-admin"
/usr/bin/grep -q "@deepseek-ai/dsh-owner-memory/settings" "$WORK/fresh.yml" || fail "composition lacks the owner-memory settings route"
/usr/bin/grep -q "@deepseek-ai/dsh-event-console" "$WORK/fresh.yml" || fail "composition lacks event-console"
/usr/bin/grep -q "^- id: cc-admin$" "$WORK/fresh.yml" || fail "composition lacks cc-admin"
/usr/bin/grep -q "@deepseek-ai/dsh-plugin-config" "$WORK/fresh.yml" || fail "composition lacks plugin-config"
/usr/bin/grep -q "^- id: owner-relay\$" "$WORK/fresh.yml" || fail "composition lacks owner-relay"
/usr/bin/grep -q "^- id: bili\$" "$WORK/fresh.yml" || fail "composition lacks bili"
/usr/bin/grep -q "^- id: preset-bili\$" "$WORK/fresh.yml" || fail "composition lacks preset-bili"
/usr/bin/grep -q "@deepseek-ai/dsh-tool-bili" "$WORK/fresh.yml" || fail "bili preset lacks tool-bili"
/usr/bin/grep -q "@deepseek-ai/dsh-tool-up" "$WORK/fresh.yml" || fail "up preset lacks tool-up"
/usr/bin/grep -q "^- id: qq\$" "$WORK/fresh.yml" || fail "composition lacks qq"
/usr/bin/grep -q "^- id: qq-login\$" "$WORK/fresh.yml" || fail "composition lacks qq-login"
/usr/bin/grep -q "^- id: speaking-style\$" "$WORK/fresh.yml" || fail "composition lacks speaking-style"
/usr/bin/grep -q "id: speaking-style-prompt" "$WORK/fresh.yml" || fail "unattended preset lacks speaking-style-prompt"
/usr/bin/grep -q "^- id: speaking-style-settings\$" "$WORK/fresh.yml" || fail "composition lacks speaking-style-settings"
/usr/bin/grep -q "^- id: preset-qq-digest\$" "$WORK/fresh.yml" || fail "composition lacks preset-qq-digest"
/usr/bin/grep -q "^- id: preset-qqbot\$" "$WORK/fresh.yml" || fail "composition lacks preset-qqbot"
/usr/bin/grep -q "@deepseek-ai/dsh-tool-qq" "$WORK/fresh.yml" || fail "unattended preset lacks tool-qq"
/usr/bin/grep -q "^- id: integrity-watch$" "$WORK/fresh.yml" || fail "composition lacks integrity-watch"
/usr/bin/grep -q "^- id: presence$" "$WORK/fresh.yml" || fail "composition lacks presence"
/usr/bin/grep -q "^- id: wechat-settings$" "$WORK/fresh.yml" || fail "composition lacks wechat-settings"
/usr/bin/grep -q "^- id: content-guard$" "$WORK/fresh.yml" || fail "composition lacks content-guard"
/usr/bin/grep -q "^- id: content-guard-settings$" "$WORK/fresh.yml" || fail "composition lacks the content-guard settings route"
/usr/bin/grep -q "^- id: time-gap$" "$WORK/fresh.yml" || fail "composition lacks time-gap"
/usr/bin/grep -q "^- id: courses$" "$WORK/fresh.yml" || fail "composition lacks courses"
/usr/bin/grep -q "^- id: courses-settings$" "$WORK/fresh.yml" || fail "composition lacks courses-settings"
/usr/bin/grep -q "^- id: gmail$" "$WORK/fresh.yml" || fail "composition lacks gmail"
/usr/bin/grep -q "^- id: gmail-settings$" "$WORK/fresh.yml" || fail "composition lacks gmail-settings"
/usr/bin/grep -q "^- id: subagent-activity$" "$WORK/fresh.yml" || fail "composition lacks subagent-activity"

for skill in "$PREFIX"/fork/skills/*/; do
  [ -d "$skill" ] || continue
  name=$(basename "$skill")
  [ -L "$FRESH/skills/$name" ] && [ -f "$FRESH/skills/$name/SKILL.md" ] || fail "$name skill not linked into the home"
done

OLD="$WORK/old"; mkdir -p "$OLD/profiles/event"
{ echo '# fork event profile — composition layer (code-owned).'; echo '[]'; } > "$OLD/profiles/event/cordis.patch.yml"
"$SETUP" "$OLD" "$PREFIX" >/dev/null
ls "$OLD/profiles/event/cordis.patch.yml.pre-bundle."* >/dev/null 2>&1 || fail "pre-bundle copy was not moved aside"
cmp -s "$OLD/profiles/event/cordis.patch.yml" "$PREFIX/fork/profiles/event/cordis.patch.yml" || fail "migrated owner layer differs from the shipped template"
compose "$OLD" > "$WORK/old.yml"
diff -q "$WORK/fresh.yml" "$WORK/old.yml" >/dev/null || fail "fresh and migrated homes compose differently"

printf '%s\n' '- id: ui-settings-general' '  config:' '    welcomeNoticeVersion: check' >> "$PATCH"
cp "$PATCH" "$WORK/owner.yml"
node -e 'const f=process.argv[1],m=JSON.parse(require("fs").readFileSync(f));m.dependencies["extra-plugin"]="1.0.0";require("fs").writeFileSync(f,JSON.stringify(m))' "$FRESH/profiles/event/package.json"
"$SETUP" "$FRESH" "$PREFIX" >/dev/null
cmp -s "$PATCH" "$WORK/owner.yml" || fail "re-run replaced the owner layer"
/usr/bin/grep -q '"extra-plugin"' "$FRESH/profiles/event/package.json" || fail "re-run dropped an owner dependency"

echo "check-setup-profile: ok ($PREFIX)"
