#!/usr/bin/env bash
# Run a command with Pin's relays up, and stop the ones this started when it exits.
#
#   bash scripts/with-relays.sh ./node_modules/.bin/vite
#   RELAY_LOG=target/x.log bash scripts/with-relays.sh playwright test ...
#
# Pin reaches the network through relays on this machine and nothing else, so anything
# that runs the app wants them. A relay already answering is left alone and left
# running, so this composes with `bun run dev:relays` in its own terminal.
#
# The command runs in the FOREGROUND, which is the point: when it exits, so does this,
# with its status. Backgrounding it and waiting on both jobs is what made a dead Vite
# look like a hang rather than a crash.
set -uo pipefail
cd "$(dirname "$0")/.."
. scripts/relay-common.sh

answering "$PKARR_URL" && had_pkarr=1 || had_pkarr=0
answering "$IROH_URL" && had_iroh=1 || had_iroh=0

if [ -n "${RELAY_LOG:-}" ]; then
  mkdir -p "$(dirname "$RELAY_LOG")"
  bash scripts/dev-relays.sh > "$RELAY_LOG" 2>&1 &
else
  bash scripts/dev-relays.sh &
fi

for _ in $(seq 1 30); do
  relays_up && break
done
if ! relays_up; then
  echo "relays did not come up${RELAY_LOG:+; see $RELAY_LOG}" >&2
  exit 1
fi

stop() {
  # By image name rather than by signalling the launcher: the relays are its
  # grandchildren, and its own `kill 0` reaches THIS script's process group — which is
  # what once turned a passing test run into exit 253.
  if command -v taskkill >/dev/null 2>&1; then
    [ "$had_pkarr" = 0 ] && taskkill //F //IM pkarr-relay.exe >/dev/null 2>&1
    [ "$had_iroh" = 0 ] && taskkill //F //IM iroh-relay.exe >/dev/null 2>&1
  else
    [ "$had_pkarr" = 0 ] && pkill -f pkarr-relay
    [ "$had_iroh" = 0 ] && pkill -f iroh-relay
  fi
  return 0
}
trap 'stop; exit 130' INT TERM

"$@"
status=$?
stop
exit "$status"
