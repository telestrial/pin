import { defineConfig, devices } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Load secrets from .env.test (gitignored) if present. Bun loads .env files
// automatically when launched via `bun run`, but Playwright workers under
// Node need explicit loading. ~10 lines beats a dotenv dependency.
const envPath = join(import.meta.dirname, '.env.test')
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
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  webServer: {
    command: 'bun run preview --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    // OAuth callback URIs are bound to 127.0.0.1 (RFC 8252 forbids
    // localhost); the test app must reach the same origin.
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testMatch: /scenarios\/.*\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
  ],
})
