#!/usr/bin/env bash
# Build crates/pin-core to wasm for the browser (release + wasm-opt).
#
# The generated crates/pin-core/pkg is COMMITTED to the repo so the deploy (Vercel,
# which has no Rust toolchain) can build the frontend. Re-run this and commit the
# pkg whenever pin-core changes. See CLAUDE.md (2026-07-14, the atproto->iroh-docs
# jump) for why.
set -euo pipefail
cd "$(dirname "$0")/.."

# ring (rustls' crypto backend) compiles C for the wasm target and needs clang.
# On Linux/macOS clang is on PATH; on Windows, add the winget LLVM install.
if ! command -v clang >/dev/null 2>&1; then
  if [ -d "/c/Program Files/LLVM/bin" ]; then
    export PATH="/c/Program Files/LLVM/bin:$PATH"
  fi
fi
export CC_wasm32_unknown_unknown="${CC_wasm32_unknown_unknown:-clang}"
export AR_wasm32_unknown_unknown="${AR_wasm32_unknown_unknown:-llvm-ar}"
# getrandom 0.2 needs the js backend selected via cfg for the wasm build.
export RUSTFLAGS="${RUSTFLAGS:-} --cfg getrandom_backend=\"wasm_js\""

wasm-pack build crates/pin-core --release --target web

# wasm-pack drops a pkg/.gitignore containing `*` (it assumes pkg is generated,
# not committed). We DO commit pkg, so remove it — otherwise the pkg contents are
# untrackable.
rm -f crates/pin-core/pkg/.gitignore
