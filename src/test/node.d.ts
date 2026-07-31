// Minimal ambient declarations for the Node builtins the test setup needs.
//
// The tests run in Node (vitest), but the app tsconfig is browser-shaped and
// deliberately doesn't pull in @types/node — same call vite.config.ts makes with its
// local `declare const process`. Declaring the two functions we actually use keeps the
// app's type surface free of Node globals, so a component importing `node:fs` still
// fails to typecheck.

declare module 'node:fs' {
  // Narrowed to Uint8Array<ArrayBuffer> rather than the default ArrayBufferLike so it
  // satisfies BufferSource — SharedArrayBuffer isn't a valid wasm module source.
  export function readFileSync(path: string): Uint8Array<ArrayBuffer>
}

declare module 'node:path' {
  export function resolve(...segments: string[]): string
}
