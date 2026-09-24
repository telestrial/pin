# Where the relays are and how to tell whether they are up. Sourced, never run.
#
# One definition because three scripts ask the same question, and the answer carries a
# detail worth not rediscovering: each relay is probed on the path it actually serves.
# iroh's root is not a route, so probing there reports a healthy relay as down.
PKARR_PORT=6881
IROH_PORT=3340
PKARR_URL="http://127.0.0.1:$PKARR_PORT/"
IROH_URL="http://127.0.0.1:$IROH_PORT/ping"

# A listening socket says a process holds the port; only a response says a relay is
# answering on it.
answering() { curl -fsS -o /dev/null --max-time 1 "$1" 2>/dev/null; }
held() { (echo > "/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

relays_up() { answering "$PKARR_URL" && answering "$IROH_URL"; }

# Why the relays are not up, for the two scripts that give up waiting on them. Held but
# not answering is the state worth naming: a relay that is wedged, or an unrelated
# process, since 6881 is BitTorrent's default port as well. It otherwise reaches you as
# the relay's own bind error (`os error 10048`) with nothing saying what to do about it.
_diagnose_relay() {
  local name="$1" port="$2" url="$3"
  if answering "$url"; then return 0; fi
  if held "$port"; then
    echo "  $name-relay: port $port is held by something that is not answering." >&2
    echo "    If it is a stale one:  taskkill //F //IM $name-relay.exe" >&2
  else
    echo "  $name-relay: nothing is on port $port; see the [$name] output above." >&2
  fi
}

relay_diagnosis() {
  _diagnose_relay pkarr "$PKARR_PORT" "$PKARR_URL"
  _diagnose_relay iroh "$IROH_PORT" "$IROH_URL"
}
