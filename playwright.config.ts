import { defineConfig, devices } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Load secrets from e2e/.env.test (gitignored) if present. Bun loads
// .env files automatically when launched via `bun run`, but Playwright
// workers under Node need explicit loading. ~10 lines beats a dotenv
// dependency.
const envPath = join(import.meta.dirname, 'e2e', '.env.test')
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

export default defineConfig({
  testDir: './e2e/scenarios',
  fullyParallel: false,
  // One worker — these are real-network tests that share the alice/bob
  // accounts. Parallel files (the default worker count) would run e.g.
  // cross-account and upload-resume as alice simultaneously, stomping each
  // other's channels and contending for the same Sia host connections (the
  // QUIC-storm timeouts we chased). Serialized, each test's cleanup also
  // completes before the next test starts.
  workers: 1,
  reporter: 'list',
  // 10 min per test — real Sia + real bsky OAuth, plus the finally-block
  // cleanup that drains every leftover e2e channel (each a slow real-network
  // retract), which compounds within the single test until the backlog clears.
  timeout: 10 * 60 * 1000,
  webServer: {
    // Vite's preview alone, never a script that also starts the relays. `webServer` owns
    // the tree it spawns and waits on its stdout at teardown, so a relay in here holds
    // the pipe open and the run sits after the last test. `test:e2e` wraps the whole
    // Playwright invocation in scripts/with-relays.sh instead, which owns their
    // lifetime — the same split playwright.sync.config.ts makes, for the same reason.
    //
    // The built app takes its relays from the store's default, which is `local`, so
    // these specs run against the relays on this machine. That is what unblocked the
    // three that were fixme'd: the public relays clamp a packet's TTL to a 300s floor,
    // which is the browser read-after-write lag in its entirety, and ours runs a 1-5s
    // window (scripts/relay-pkarr.toml). Sia and Mainline are still real.
    command: 'bun run preview --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    // OAuth callback URIs are bound to 127.0.0.1 (RFC 8252 — localhost
    // is forbidden); the test app must reach the same origin.
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
