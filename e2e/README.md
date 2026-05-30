# E2E tests

Real-network tests against a built `dist/` served by `bun run preview`.
Uses real Sia hosts and real bsky.social — the reconciliation point for
our fake-SDK contract. If the fake drifts from real behavior, this tier
fails and we fix the fake.

The integration tier (`*.int.test.tsx`) is fast and deterministic
against fakes; this tier is slow and honest. Small by design: one
happy-path scenario, room for ~5 more before they become a maintenance
burden.

## One-time setup

You need **two Bluesky accounts** and **two sia.storage accounts**.
Make new ones — the e2e suite uses real accounts and persistent
storage on Sia hosts.

1. **Create accounts.**
   - Bluesky: register two handles at <https://bsky.app/signup>. Common
     pattern: dedicated Gmail addresses → `pin-test-alice.bsky.social`
     and `pin-test-bob.bsky.social`.
   - sia.storage: sign up at <https://sia.storage> with the same two
     identities. Free tier (~50 GiB) is more than enough.

2. **Capture each account's Sia AppKey hex.** Once per account:
   - `bun run dev`, open Chrome at <http://127.0.0.1:5173/>.
   - Click **Just reading**, complete the Sia onboarding flow
     (Connect → approve at sia.storage → save the recovery phrase).
   - Open DevTools → Application → Local Storage → find the key
     `sia-auth-f6b7539e181e45ee`. Copy `state.storedKeyHex` from the
     JSON value (a 64-character hex string).
   - Save it as `ALICE_SIA_KEY_HEX=...` (or `BOB_SIA_KEY_HEX=...`)
     in `e2e/.env.test`.
   - Clear localStorage in DevTools and repeat for the other account.

3. **Fill in `e2e/.env.test`.** Copy `e2e/.env.test.example` and fill:
   ```
   ALICE_BLUESKY_HANDLE=pin-test-alice.bsky.social
   ALICE_BLUESKY_PASSWORD=<password>
   ALICE_SIA_KEY_HEX=<64-char hex from step 2>

   BOB_BLUESKY_HANDLE=pin-test-bob.bsky.social
   BOB_BLUESKY_PASSWORD=<password>
   BOB_SIA_KEY_HEX=<64-char hex from step 2>
   ```

## Running

```sh
bun run build        # required: preview serves dist/
bun run test:e2e
```

Playwright spins up `bun run preview --port 4173`, runs `auth.setup.ts`
to authenticate both accounts and produce `e2e/.auth/{alice,bob}.json`
fixtures (gitignored), then runs `scenarios/*.spec.ts` with the
fixtures loaded as `storageState`.

Fixtures persist across runs. If a Bluesky OAuth token expires or
sia.storage revokes an AppKey, the setup project will fail with a
clear error — re-run the manual capture step above and try again.

## Architecture

- `authHelper.ts` — `signInAccount(context, account)`. Seeds the
  Sia AppKey via `addInitScript`, drives the real bsky.social OAuth
  flow with the credentials in `.env.test`. Called per-test for each
  account that needs auth.
- `scenarios/*.spec.ts` — Happy-path tests. Create fresh browser
  contexts, call `signInAccount` for each, run the scenario.

We previously tried Playwright's setup-project + `storageState`
fixture pattern to amortize auth across tests. It failed: the
`@atproto/oauth-client-browser` session getter wraps an IndexedDB
store with an in-memory CachedGetter, and restoring just the
IndexedDB doesn't restore the cache. The first stale-token refresh
after restore reads from IndexedDB, gets nothing matching the
in-memory key, and the lib throws "The session was deleted by
another process". Auth-per-test trades ~5s/test for reliability.

## Brittleness, deliberately

The auth.setup.ts scrapes bsky.social's OAuth UI (handle field,
password field, scope-approval button). When bsky.social redesigns,
this will fail. We treat that failure as signal — it tells us a
provider we depend on has changed and we should look at what
changed and whether it affects production usage. Fix locally, commit
the fix.

If failures become too frequent, the alternative is a one-time
manual bake (interactive: open the browser, complete auth, press
Enter, save state). The infrastructure here would work the same
way — only `auth.setup.ts` would change.
