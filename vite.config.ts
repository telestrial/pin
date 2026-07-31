import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// LAN mode (`bun run dev:lan`) binds all interfaces and serves HTTPS so a phone
// or second device can reach the dev server at https://<host-ip>:5173. HTTPS is
// required, not cosmetic: a LAN IP over plain http is NOT a secure context, and
// the app's Web Crypto (crypto.subtle — every HKDF/AES-GCM key derivation) is
// unavailable outside a secure context. 127.0.0.1/localhost are secure even
// over http, so the normal `bun run dev` stays plain http on 127.0.0.1.
// Local declaration so we don't pull in all of @types/node for one env read.
declare const process: { env: Record<string, string | undefined> }
const lan = process.env.PIN_LAN === '1'

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(lan ? [basicSsl()] : [])],
  server: lan ? { host: true } : { host: '127.0.0.1' },
})
