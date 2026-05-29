import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'e2e'],
    css: false,
    // Integration tests use the .int.test.ts suffix; the `test:int` script
    // selects only those, so when none exist yet the run is empty rather than
    // a failure.
    passWithNoTests: true,
  },
})
