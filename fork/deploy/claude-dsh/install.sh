#!/bin/bash
# Provision Claude Code for the DSH service user (run as the operator; needs the passwordless
# `sudo -n -u dsh-runtime` of RUNBOOK "Operator access"). Idempotent; never touches the operator's own
# ~/.claude or global install. The OAuth token is NOT handled here: see RUNBOOK §14.
#   install.sh [version]     version defaults to the operator's installed Claude Code
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
U() { sudo -n -u dsh-runtime "$@"; }
HOME_DIR=/Users/dsh-runtime
VERSION="${1:-$(readlink "$HOME/.local/bin/claude" | xargs basename)}"
SRC="$HOME/.local/share/claude/versions/$VERSION"
[[ -x "$SRC" ]] || { echo "claude-dsh/install.sh: no Claude Code $VERSION at $SRC" >&2; exit 1; }

U /bin/mkdir -p "$HOME_DIR/.local/share/claude/versions" "$HOME_DIR/.local/bin" "$HOME_DIR/.config/claude-code" "$HOME_DIR/.claude" "$HOME_DIR/work/cc" "$HOME_DIR/bin"
U /bin/chmod 700 "$HOME_DIR/.config/claude-code"
# A byte-for-byte copy of the operator's binary: same version, nothing downloaded.
U /usr/bin/tee "$HOME_DIR/.local/share/claude/versions/$VERSION" < "$SRC" >/dev/null
U /bin/chmod 755 "$HOME_DIR/.local/share/claude/versions/$VERSION"
cmp "$SRC" "$HOME_DIR/.local/share/claude/versions/$VERSION"
U /bin/ln -sfn "$HOME_DIR/.local/share/claude/versions/$VERSION" "$HOME_DIR/.local/bin/claude"
U /usr/bin/tee "$HOME_DIR/bin/claude-dsh" < "$HERE/claude-dsh" >/dev/null
U /bin/chmod 755 "$HOME_DIR/bin/claude-dsh"
# The owner's settings layer: seeded once, never replaced.
if ! U /bin/test -e "$HOME_DIR/.claude/settings.json"; then
  U /usr/bin/tee "$HOME_DIR/.claude/settings.json" < "$HERE/settings.json" >/dev/null
  U /bin/chmod 600 "$HOME_DIR/.claude/settings.json"
fi
U /usr/bin/env HOME="$HOME_DIR" "$HOME_DIR/.local/bin/claude" --version
if U /bin/test -s "$HOME_DIR/.config/claude-code/oauth_token"; then echo "claude-dsh: token file present"; else echo "claude-dsh: no token yet; see RUNBOOK §14"; fi
