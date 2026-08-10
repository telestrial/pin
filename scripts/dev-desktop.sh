#!/usr/bin/env bash
# Launch desktop Pin instances side by side, each with completely separate state.
#
#   bash scripts/dev-desktop.sh              # primary + b
#   bash scripts/dev-desktop.sh primary b c  # three of them
#   bash scripts/dev-desktop.sh b            # just b, on its own
#
# `primary` is the account already on this machine (no PIN_INSTANCE, today's
# dirs); every other name gets its own identifier and therefore its own
# everything — WebView2 profile (so its own Sia AppKey, so its own identity),
# Curator dir (node key, docs.redb, blobs) and logs. See apply_instance_suffix
# in src-tauri/src/lib.rs.
#
# Two dialable peers is the point: `/hey` knocks and cross-instance sync need a
# receiver with a listening socket, which a browser tab structurally isn't.
#
# Builds ONCE and launches the binary directly rather than running `tauri dev`
# per instance — two of those would race the cargo lock and their file watchers
# would restart each other. The frontend is embedded at compile time, so the exe
# runs standalone; re-run this script to pick up a change.
set -euo pipefail
cd "$(dirname "$0")/.."

instances=("$@")
if [ ${#instances[@]} -eq 0 ]; then
  instances=(primary b)
fi

# Closing a Pin window hides it to the tray, so an instance from an earlier run
# is still alive and still holding its Curator's doc store. Reusing that name
# would fail to open the store, which reads like a bug and isn't one.
if command -v tasklist >/dev/null 2>&1 && tasklist //FI "IMAGENAME eq app.exe" 2>/dev/null | grep -qi app.exe; then
  echo "warning: a Pin desktop process is already running." >&2
  echo "         Quit it from its tray icon (or the pin menu's Quit Pin) if you" >&2
  echo "         want these instances to have their stores to themselves." >&2
  echo >&2
fi

echo "building frontend..."
bun run build
echo "building desktop shell..."
cargo build --manifest-path src-tauri/Cargo.toml

exe="target/debug/app.exe"
[ -f "$exe" ] || exe="target/debug/app"
if [ ! -f "$exe" ]; then
  echo "no desktop binary at target/debug/app[.exe]" >&2
  exit 1
fi

# Ctrl+C tears every instance down together; without it you'd be left with
# orphaned windows to hunt through the tray.
trap 'kill 0' INT TERM

for name in "${instances[@]}"; do
  echo "launching $name..."
  if [ "$name" = "primary" ]; then
    env -u PIN_INSTANCE "$exe" 2>&1 | sed "s/^/[$name] /" &
  else
    PIN_INSTANCE="$name" "$exe" 2>&1 | sed "s/^/[$name] /" &
  fi
done

wait
