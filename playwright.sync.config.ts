import { defineConfig, devices } from '@playwright/test'

// Slice 1a — the iroh-docs sync loopback. Runs against the Vite DEV server (so the
// window.__pinSync harness in main.tsx is present — it's stripped from the
// production `preview` build the main e2e config uses) on a distinct port that
// Playwright fully owns and tears down, so it never collides with a running
// `bun run dev`. No Sia creds and no auth: openDocs is pure HKDF + an iroh relay
// bind.
//
// Two ways to run it, and both are wanted. `test:sync` goes through the relays on this
// machine, which scripts/test-sync.sh starts around this — that is what the app does,
// so it is what the tier should exercise. `test:sync:public` runs the same specs
// against the public relays, and it is the only automated thing left that touches
// infrastructure we don't run: without it, a public path that had stopped working would
// go unnoticed until somebody chose it on the welcome screen.
const PUBLIC = process.env.VITE_RELAY_PRESET === 'public'

export default defineConfig({
  testDir: './e2e/sync',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 3 * 60 * 1000,
  webServer: {
    // Vite alone, never `bun run dev`. That script also starts the relays, and a relay
    // inside the tree Playwright owns holds its stdout open past the last test, so
    // teardown waits on a stream that never ends. scripts/test-sync.sh owns them
    // instead. `bunx` rather than a path into node_modules/.bin, since Playwright runs
    // this through cmd.exe on Windows.
    command: 'bunx vite --port 5178 --strictPort',
    url: 'http://127.0.0.1:5178',
    reuseExistingServer: false,
    // Set only on the public run, and spread so the local run passes no `env` at all:
    // Playwright documents this field as replacing `process.env` rather than extending
    // it, so an empty object is a different thing from an absent one.
    ...(PUBLIC ? { env: { VITE_RELAY_PRESET: 'public' } } : {}),
  },
  use: {
    baseURL: 'http://127.0.0.1:5178',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
