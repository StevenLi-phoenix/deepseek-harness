#!/bin/bash
# Regression check for setup-profile.sh against an installed prefix, in throwaway DSH homes:
# a fresh home gets the owner layer and the event bundle; a pre-bundle composition copy is moved
# aside; a re-run keeps the owner's settings and extra dependencies; fresh and migrated homes
# compose the same profile.
# usage: check-setup-profile.sh <installed prefix>
set -euo pipefail
PREFIX=$(cd "${1:?installed prefix}" && pwd)
SETUP="$PREFIX/lsy/deploy/setup-profile.sh"
BIN="$PREFIX/node_modules/@deepseek-ai/dsh/lib/bin.js"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/lsy-setup-profile.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
fail() { echo "check-setup-profile: FAIL: $*" >&2; exit 1; }
# Compose without starting; comments name file paths, so only entries are compared.
compose() { (cd "$1" && DSH_HOME="$1" node "$BIN" event --dump-config | /usr/bin/grep -v '^#'); }

FRESH="$WORK/fresh"; mkdir -p "$FRESH"
"$SETUP" "$FRESH" "$PREFIX" >/dev/null
PATCH="$FRESH/profiles/event/cordis.patch.yml"
cmp -s "$PATCH" "$PREFIX/lsy/profiles/event/cordis.patch.yml" || fail "fresh owner layer differs from the shipped template"
/usr/bin/grep -q '"@deepseek-ai/dsh-lsy-event-bundle"' "$FRESH/profiles/event/package.json" || fail "event bundle missing from the manifest"
compose "$FRESH" > "$WORK/fresh.yml"
for id in lsy-event-bus lsy-github-sensor lsy-wechat preset-unattended; do
  /usr/bin/grep -q "^- id: $id\$" "$WORK/fresh.yml" || fail "composition lacks $id"
done
/usr/bin/grep -q "@deepseek-ai/dsh-lsy-memory" "$WORK/fresh.yml" || fail "unattended preset lacks lsy-memory"

OLD="$WORK/old"; mkdir -p "$OLD/profiles/event"
{ echo '# lsy event profile — composition layer (code-owned).'; echo '[]'; } > "$OLD/profiles/event/cordis.patch.yml"
"$SETUP" "$OLD" "$PREFIX" >/dev/null
ls "$OLD/profiles/event/cordis.patch.yml.pre-bundle."* >/dev/null 2>&1 || fail "pre-bundle copy was not moved aside"
cmp -s "$OLD/profiles/event/cordis.patch.yml" "$PREFIX/lsy/profiles/event/cordis.patch.yml" || fail "migrated owner layer differs from the shipped template"
compose "$OLD" > "$WORK/old.yml"
diff -q "$WORK/fresh.yml" "$WORK/old.yml" >/dev/null || fail "fresh and migrated homes compose differently"

printf '%s\n' '- id: ui-settings-general' '  config:' '    welcomeNoticeVersion: check' >> "$PATCH"
cp "$PATCH" "$WORK/owner.yml"
node -e 'const f=process.argv[1],m=JSON.parse(require("fs").readFileSync(f));m.dependencies["extra-plugin"]="1.0.0";require("fs").writeFileSync(f,JSON.stringify(m))' "$FRESH/profiles/event/package.json"
"$SETUP" "$FRESH" "$PREFIX" >/dev/null
cmp -s "$PATCH" "$WORK/owner.yml" || fail "re-run replaced the owner layer"
/usr/bin/grep -q '"extra-plugin"' "$FRESH/profiles/event/package.json" || fail "re-run dropped an owner dependency"

echo "check-setup-profile: ok ($PREFIX)"
