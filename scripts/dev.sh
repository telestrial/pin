#!/usr/bin/env bash
# The web dev server, with the relays it talks through.
#
#   bun run dev
#
# Pin reaches the network through relays on this machine and nothing else, so a dev
# server without them is an app that resolves nothing — and resolving nothing looks
# exactly like a network where nobody has published anything. Starting them here is what
# keeps that from being a thing to remember.
#
# Already-answering relays are left alone, so this composes with `bun run dev:relays` in
# its own terminal. Ctrl+C takes down whatever this started, and leaves what it didn't.
set -euo pipefail
cd "$(dirname "$0")/.."

trap 'kill 0' INT TERM

bash scripts/dev-relays.sh &

# No wait between them: Vite takes seconds to boot and nothing reaches a relay before
# sign-in, so the relays have long since come up by the time anything asks.
./node_modules/.bin/vite "$@" &

wait
