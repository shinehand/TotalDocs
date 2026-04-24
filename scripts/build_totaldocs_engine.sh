#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v rustup >/dev/null 2>&1; then
  ACTIVE_TOOLCHAIN="$(rustup show active-toolchain | awk '{print $1}')"
  if [ -n "$ACTIVE_TOOLCHAIN" ]; then
    TOOLCHAIN_RUSTC="$(rustup which --toolchain "$ACTIVE_TOOLCHAIN" rustc 2>/dev/null || true)"
    if [ -n "$TOOLCHAIN_RUSTC" ]; then
      export PATH="$(dirname "$TOOLCHAIN_RUSTC"):$PATH"
    fi
  fi
fi

cargo test --manifest-path "$ROOT_DIR/engine/Cargo.toml"
cargo build --manifest-path "$ROOT_DIR/engine/Cargo.toml" --release --target wasm32-unknown-unknown

mkdir -p "$ROOT_DIR/lib/generated"
cp "$ROOT_DIR/engine/target/wasm32-unknown-unknown/release/totaldocs_engine.wasm" \
  "$ROOT_DIR/lib/generated/totaldocs_engine.wasm"

echo "TotalDocs engine built: lib/generated/totaldocs_engine.wasm"
