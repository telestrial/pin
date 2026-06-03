import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Vite treats any path containing a dot as a static-asset request and
// returns 404 if no file matches — which breaks /@handle routes where the
// handle contains a TLD ("/@john.bsky.social"). Production's vercel.json
// catch-all already rewrites these to /index.html; this plugin gives the
// dev + preview servers the same behavior. The connect middleware shape
// is loosely typed structurally since we don't pull in @types/node.
type ConnectReq = { url?: string; headers: Record<string, unknown> }
type ConnectNext = (err?: unknown) => void
const spaFallbackForHandleURLs = (): Plugin => {
  const middleware = (req: ConnectReq, _res: unknown, next: ConnectNext) => {
    const accept = req.headers.accept
    if (
      typeof req.url === 'string' &&
      req.url.startsWith('/@') &&
      typeof accept === 'string' &&
      accept.includes('text/html')
    ) {
      req.url = '/'
    }
    next()
  }
  return {
    name: 'spa-fallback-for-handle-urls',
    configureServer(server) {
      // biome-ignore lint/suspicious/noExplicitAny: connect middleware shape
      server.middlewares.use(middleware as any)
    },
    configurePreviewServer(server) {
      // biome-ignore lint/suspicious/noExplicitAny: connect middleware shape
      server.middlewares.use(middleware as any)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), spaFallbackForHandleURLs()],
  // 127.0.0.1 (not localhost) for the dev server: @atproto/oauth-client-browser
  // uses 127.0.0.1 as its loopback redirect URI, so OAuth callbacks come back
  // to a different origin than localhost which fragments IndexedDB / cookies.
  server: { host: '127.0.0.1' },
  // sia-storage loads its WASM via `new URL(..., import.meta.url)`; excluding
  // it from the deps pre-bundler keeps that URL pointing at the real file.
  optimizeDeps: { exclude: ['@siafoundation/sia-storage'] },
})
