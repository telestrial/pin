# E2E tests

Real-network tests against a built `dist/` served by `bun run preview`.
Uses real Sia hosts and the real Mainline DHT, reached through the pkarr
relay on this machine — the reconciliation point for our fake-SDK
contract. If the fake drifts from real behavior, this tier fails and we
fix the fake.

The integration tier (`*.int.test.tsx`) is fast and deterministic
against fakes; this tier is slow and honest. Small by design: a few
happy-path scenarios (publish / subscribe / pin cross-account, an
interrupted publish resuming from its checkpoint, granular file
pinning), room for a couple more before they become a maintenance
burden.

**All four run.** Three of them spent about two months `test.fixme`'d
behind the browser-relay pkarr read-after-write lag: the public relays
clamp a packet's TTL into a 300s floor before deciding whether to serve
their cache, so a just-published record stays invisible for minutes and
no client can shorten it. Running our own relay does
(`scripts/relay-pkarr.toml`, a 1-5s window), which is what let
`upload-resume` come back on 2026-09-24 and `cross-account` /
`granular-pin` on 2026-09-25.

Re-enabling those three turned up nine rots between them, and not one
was the reason any had been switched off — a disabled spec decays rather
than keeping. Keep them running.

## One-time setup

You need **two sia.storage accounts** — that's it. Identity in Pin is a
`did:dht` derived from the Sia recovery phrase; there's no Bluesky or
atproto login anymore, so an account is just its Sia AppKey. Make new
accounts — the suite uses real accounts and persistent storage on Sia
hosts.

1. **Create two sia.storage accounts** at <https://sia.storage>. The
   free tier (~50 GiB) is more than enough.

2. **Capture each account's Sia AppKey hex.** Once per account:
   - `bun run dev`, open Chrome at <http://127.0.0.1:5173/>.
   - Complete onboarding (Connect → approve at sia.storage → save the
     recovery phrase → pick a name).
   - Open DevTools → Application → Local Storage → find the key
     `sia-auth-f6b7539e181e45ee`. Copy `state.storedKeyHex` from the
     JSON value (a 64-character hex string).
   - Save it as `ALICE_SIA_KEY_HEX=...` (or `BOB_SIA_KEY_HEX=...`)
     in `e2e/.env.test`.
   - Clear localStorage in DevTools and repeat for the other account.

3. **Fill in `e2e/.env.test`.** Copy `e2e/.env.test.example` and fill:
   ```
   ALICE_SIA_KEY_HEX=<64-char hex from step 2>
   BOB_SIA_KEY_HEX=<64-char hex from step 2>
   ```

## Running

```sh
bun run test:e2e     # builds dist/ first, then runs Playwright
```

`test:e2e` builds `dist/`, then runs Playwright inside
`scripts/with-relays.sh` so the relays are up for the run and the ones it
started are stopped after. They start out there rather than in
Playwright's `webServer` because that tree's stdout is waited on at
teardown, and a relay holds it open forever. Playwright spins up `bun run
preview --port 4173` to serve the built `dist/`, and the specs run
serially (one worker — they share the alice/bob accounts).

A relay already answering is left alone and left running, so this
composes with a `bun run dev:relays` or a desktop you already have up.
Note what that means for the log: `target/e2e-relays.log` holds the
output of the relays *this run started*, so when it started none it says
only that they were already up, and the output to read when a resolve
comes back empty is whatever terminal owns them.

**Run `bunx playwright install chromium` after a `@playwright/test`
bump.** A new Playwright expects a browser build it pins by number, and
if that build is absent every spec fails at `browserType.launch` with a
message about the executable not existing — before any test code runs.
Nothing else catches it: the version bump is a `package.json` change
like any other, and `tsc`, biome, the unit and integration tiers and the
build all stay green.

## Architecture

- `authHelper.ts` — `signInAccount(context, account)`. Seeds the Sia
  AppKey (and a chosen `@`-name) into localStorage via `addInitScript`
  and lets the app's normal boot restore the `did:dht` identity from it.
  There's no UI flow to drive: identity is self-sovereign, derived from
  the recovery phrase, so "signing in" is just restoring the AppKey.
  Bake-once-then-replay — the AppKey is captured once (step 2) and
  replayed every run. Called per-test for each account.
- `scenarios/*.spec.ts` — happy-path tests. Each creates fresh browser
  contexts, calls `signInAccount` for each account, runs the scenario,
  and drains the channels / subscriptions it created in a `finally`.
- `scenarios/drain-e2e-channels.spec.ts` — a guarded (`E2E_DRAIN=1`)
  maintenance task that bulk-drains a backlog of leftover `e2e test`
  channels. Run it if per-run cleanup falls behind.

## A note on real-network flakiness

QUIC is flaky on Sia — some hosts don't support it and the SDK churns
through failing ones, so you'll see `QUIC_NETWORK_IDLE_TIMEOUT` noise in
the logs. That's a normal characteristic of the network, not
necessarily a bad run: the per-test timeouts are generous, and a
simultaneous full-suite green sometimes needs the network in a
cooperative moment (each scenario passes on its own; the whole suite may
take a re-run).

The pkarr / DHT layer is eventually-consistent too: a just-published
channel locator takes a few seconds to propagate, which is why feed
reads are polled with long timeouts rather than asserted immediately.
