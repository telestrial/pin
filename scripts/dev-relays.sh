#!/usr/bin/env bash
# Run Pin's two relays on this machine.
#
#   bun run dev:relays        # both, in the foreground; Ctrl+C stops them
#
# `dev`, `dev:desktop` and the pair/trio scripts start these too, and leave alone any
# that are already answering — so running this in its own terminal keeps one set up
# across app restarts, and forgetting to costs nothing.
#
# Two kinds of relay, one word. The PKARR relay is how a browser reaches the Mainline
# DHT at all, since a sandbox can't send UDP; the IROH relay carries connections until
# holepunching finds a direct path, and carries a browser peer's for their whole life.
# Both are configured in the .toml beside this script, which is where the reasoning
# behind each setting lives.
#
# Nothing falls back to a public relay when these are down. That is deliberate: a set
# gathered across one relay we run and one we don't makes an empty answer unattributable
# again, which is the whole thing running our own is meant to fix. Stopping these and
# picking n0 on the welcome screen is how to reach the public path on purpose.
set -euo pipefail
cd "$(dirname "$0")/.."

missing=""
for bin in pkarr-relay iroh-relay; do
  command -v "$bin" >/dev/null 2>&1 || missing="$missing $bin"
done
if [ -n "$missing" ]; then
  echo "missing:$missing" >&2
  echo >&2
  echo "  cargo install pkarr-relay" >&2
  echo "  cargo install iroh-relay --features server" >&2
  echo >&2
  echo "Pin the iroh-relay version to the iroh generation in Cargo.toml — a relay is" >&2
  echo "one of the few things self-hosting lets us hold still while the crates move." >&2
  exit 1
fi

. scripts/relay-common.sh

# The relay refuses to start when its cache directory is absent.
mkdir -p target/pkarr-relay-cache

# `sed -u`, or each relay's request log sits in a block buffer and the access log —
# the whole reason for running these rather than reaching a public relay — arrives in
# bursts minutes after the traffic it describes, if at all.
trap 'kill 0' INT TERM

started=0
if answering "$PKARR_URL"; then
  echo "pkarr relay already answering on $PKARR_PORT"
else
  echo "starting pkarr relay on $PKARR_PORT..."
  pkarr-relay --config scripts/relay-pkarr.toml 2>&1 | sed -u 's/^/[pkarr] /' &
  started=1
fi

if answering "$IROH_URL"; then
  echo "iroh relay already answering on $IROH_PORT"
else
  echo "starting iroh relay on $IROH_PORT..."
  # iroh-relay filters from RUST_LOG alone, and an unset one leaves it at error — so
  # without this it runs silently and the access log, which is the reason for running
  # our own, does not exist. pkarr-relay needs no equivalent: its own default is
  # `pkarr_relay=info,tower_http=debug`, which is the request log already.
  RUST_LOG="${RUST_LOG:-iroh_relay=info}"     iroh-relay --dev --config-path scripts/relay-iroh.toml 2>&1 | sed -u 's/^/[iroh] /' &
  started=1
fi

if [ "$started" -eq 0 ]; then
  echo "both relays were already up; nothing to run."
  exit 0
fi

wait
