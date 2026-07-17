#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/turbovc3-sanitizers.XXXXXX")"
trap 'rm -rf "$BUILD_DIR"' EXIT

CC_BIN="${CC:-cc}"
"$CC_BIN" \
  -std=c11 \
  -O1 \
  -g \
  -fno-omit-frame-pointer \
  -fsanitize=address,undefined \
  "$ROOT/src/native/dnx_idct_kernel.c" \
  "$ROOT/tests/native/dnx_idct_sanitizer_test.c" \
  -lm \
  -o "$BUILD_DIR/dnx_idct_sanitizer_test"

ASAN_OPTIONS="detect_leaks=0:halt_on_error=1" \
UBSAN_OPTIONS="halt_on_error=1:print_stacktrace=1" \
  "$BUILD_DIR/dnx_idct_sanitizer_test"

zig test "$ROOT/src/native/dnx_row_decoder.zig" -O Debug
echo "Native ASan/UBSan and Zig safety checks passed."
