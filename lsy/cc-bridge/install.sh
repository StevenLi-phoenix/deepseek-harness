#!/bin/bash
# Install (or remove) the dsh-cc-bridge relay as the owner's LaunchAgent. Run as the owner, not root.
#   install.sh              copy relay.py, write the plist, (re)load the agent
#   install.sh --uninstall  unload the agent and remove the plist and the copy
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL=app.lishuyu.dsh-cc-bridge
LIBEXEC="$HOME/.local/libexec/dsh-cc-bridge"
STATE="$HOME/.local/state/dsh-cc-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

[[ "$(id -u)" != 0 ]] || { echo "install.sh: run as the owner, not root" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$LIBEXEC/relay.py"
  rmdir "$LIBEXEC" 2>/dev/null || true
  echo "install.sh: removed $LABEL (state and logs stay in $STATE)"
  exit 0
fi

/usr/bin/python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "install.sh: /usr/bin/python3 must be 3.9 or newer" >&2; exit 1; }
mkdir -p "$LIBEXEC" "$STATE" "$HOME/Library/LaunchAgents"
chmod 700 "$STATE"
install -m 755 "$HERE/relay.py" "$LIBEXEC/relay.py"
sed "s#__HOME__#$HOME#g" "$HERE/$LABEL.plist" > "$PLIST.new"
plutil -lint "$PLIST.new" >/dev/null
mv -f "$PLIST.new" "$PLIST"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST" || true   # may report 5: Input/output error although the agent starts
launchctl kickstart -k "$DOMAIN/$LABEL"
echo "install.sh: loaded $LABEL; check: launchctl print $DOMAIN/$LABEL | grep -E 'state|pid'; tail $STATE/relay.log"
