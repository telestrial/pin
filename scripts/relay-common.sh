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

relays_up() { answering "$PKARR_URL" && answering "$IROH_URL"; }
