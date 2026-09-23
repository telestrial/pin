#!/usr/bin/env bash
# The sync tier, against the relays on this machine.
#
#   bun run test:sync           # through our relays, which this starts
#   bun run test:sync:public    # the same specs against the public relays
#
# The relays start out here rather than in Playwright's `webServer`, and that is why
# this exists. `webServer` owns the process tree it spawns and waits on its stdout at
# teardown, so a relay in that tree holds the pipe open and goes on streaming —
# Playwright finishes every test and then waits on a stream that never ends. Out here
# their lifetime is ours and Playwright manages Vite alone, which is what it did before
# relays were in the picture.
#
# Relay output goes to a file, where it stays clear of the test results and remains the
# thing to read when a resolve comes back empty.
set -uo pipefail
cd "$(dirname "$0")/.."

RELAY_LOG=target/sync-relays.log \
  bash scripts/with-relays.sh playwright test --config playwright.sync.config.ts "$@"
status=$?
echo "relay log: target/sync-relays.log"
exit "$status"
