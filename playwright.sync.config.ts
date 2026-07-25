import { defineConfig, devices } from '@playwright/test'

// Slice 1a — the iroh-docs sync loopback. Runs against the Vite DEV server (so the
// window.__pinSync harness in main.tsx is present — it's stripped from the
// production `preview` build the main e2e config uses) on a distinct port that
// Playwright fully owns and tears down, so it never collides with a running
// `bun run dev`. No Sia creds and no auth: openDocs is pure HKDF + an iroh relay
// bind. The only external dependency is real network to the n0 relay.
export default defineConfig({
  testDir: './e2e/sync',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 3 * 60 * 1000,
  webServer: {
    command: 'bun run dev -- --port 5178 --strictPort',
    url: 'http://127.0.0.1:5178',
    reuseExistingServer: false,
  },
  use: {
    baseURL: 'http://127.0.0.1:5178',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
