import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 127.0.0.1 (not localhost) for the dev server: @atproto/oauth-client-browser
  // uses 127.0.0.1 as its loopback redirect URI, so OAuth callbacks come back
  // to a different origin than localhost which fragments IndexedDB / cookies.
  server: { host: '127.0.0.1' },
  // sia-storage loads its WASM via `new URL(..., import.meta.url)`; excluding
  // it from the deps pre-bundler keeps that URL pointing at the real file.
  optimizeDeps: { exclude: ['@siafoundation/sia-storage'] },
})
