#!/usr/bin/env bash
# The sync tier, against the relays on this machine.
#
#   bun run test:sync           # through our relays, which this starts
#   bun run test:sync:public    # the same specs against the public relays
#
# The relays start HERE rather than in Playwright's `webServer`, and that is why this
# script exists. `webServer` owns the process tree it spawns and waits on its stdout at
# teardown, so a relay in that tree holds the pipe open and streams to it — Playwright
# finishes every test and then waits on a stream that never ends. Out here their
# lifetime is ours, and Playwright manages Vite alone, which is what it did before
# relays were in the picture.
set -uo pipefail
cd "$(dirname "$0")/.."

PKARR_URL=http://127.0.0.1:6881/
IROH_URL=http://127.0.0.1:3340/ping
RELAY_LOG=target/sync-relays.log

answering() { curl -fsS -o /dev/null --max-time 1 "$1" 2>/dev/null; }

# Whether each was already up decides whether to stop it afterwards. A relay somebody
# started for their own session outlives a test run.
answering "$PKARR_URL" && had_pkarr=1 || had_pkarr=0
answering "$IROH_URL" && had_iroh=1 || had_iroh=0

mkdir -p target
# To a file rather than our stdout: the relays log every request, which is exactly what
# they are for and would also bury the test results under themselves.
bash scripts/dev-relays.sh > "$RELAY_LOG" 2>&1 &

for _ in $(seq 1 30); do
  if answering "$PKARR_URL" && answering "$IROH_URL"; then break; fi
done
if ! answering "$PKARR_URL" || ! answering "$IROH_URL"; then
  echo "relays did not come up; see $RELAY_LOG" >&2
  exit 1
fi

stop() {
  # By image name rather than by killing the launcher: the relays are its grandchildren,
  # and its own `kill 0` reaches this script's process group — which is what turned a
  # passing run into exit 253.
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

playwright test --config playwright.sync.config.ts "$@"
status=$?
stop
echo "relay log: $RELAY_LOG"
exit "$status"
