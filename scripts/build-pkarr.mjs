// Regenerate the vendored, browser-loadable pkarr shim from @synonymdev/pkarr.
//
// Why vendor: @synonymdev/pkarr ships a wasm-pack binding whose ESM entry loads the
// wasm via Node `fs`/`__dirname` and has CJS-style `exports.X =` lines — both break
// in a browser ESM bundle. This transform makes a browser-loadable copy (swap the
// fs-loader tail for an async `fetch`+instantiate `initPkarr(wasmUrl)`), committed
// under src/vendor/pkarr/ so the Vercel build needs no pkarr build step — the same
// deploy-safe posture as the committed pin-core wasm. Rerun after bumping the dep:
//   bun run pkarr
//
// Mirrors the spike's proven shim (pin-spikes/pkarr-web-probe). Pinned to the API of
// @synonymdev/pkarr 0.1.4; the anchor guards below fail loudly if a bump moves them.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = path.join(root, 'node_modules', '@synonymdev', 'pkarr')
const outDir = path.join(root, 'src', 'vendor', 'pkarr')

fs.mkdirSync(outDir, { recursive: true })

let s = fs.readFileSync(path.join(pkgDir, 'index.js'), 'utf8')

// 1) absorb the CJS-style `exports.X =` lines (ReferenceError in browser ESM)
s = `var exports = {};\n${s}`

// 2) replace the Node-only fs loader tail with an async browser init, matched on
//    stable anchors rather than the whole block verbatim.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal text to match in the source, not a placeholder
const startAnchor = 'const wasmPath = `${__dirname}/pkarr_js_bg.wasm`;'
const endAnchor = "globalThis['pubky'] = imports"
const start = s.indexOf(startAnchor)
const end = s.indexOf(endAnchor)
if (start === -1 || end === -1) {
  console.error(
    'build-pkarr: loader anchors not found — @synonymdev/pkarr internals changed; ' +
      'inspect node_modules/@synonymdev/pkarr/index.js and update the anchors.',
  )
  process.exit(1)
}
const repl = `let wasm;
export async function initPkarr(wasmUrl) {
  const buf = await (await fetch(wasmUrl)).arrayBuffer();
  const { instance } = await WebAssembly.instantiate(buf, __wbg_get_imports());
  wasm = instance.exports;
  wasm.__wbindgen_start();
  return wasm;
}
`
s = s.slice(0, start) + repl + s.slice(end + endAnchor.length)

fs.writeFileSync(path.join(outDir, 'pkarr-web.js'), s)
fs.copyFileSync(
  path.join(pkgDir, 'pkarr_js_bg.wasm'),
  path.join(outDir, 'pkarr_js_bg.wasm'),
)
console.log(
  `build-pkarr: wrote src/vendor/pkarr/pkarr-web.js (${s.length} B) + pkarr_js_bg.wasm`,
)
