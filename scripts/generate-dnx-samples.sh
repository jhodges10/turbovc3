#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="${1:-$ROOT/samples/source.mov}"
OUTPUT_DIR="${2:-samples}"
FRAMES="${3:-3}"

cd "$ROOT"
npm run fixtures:generate -- \
  --source "${SOURCE}" \
  --fixture-dir "${OUTPUT_DIR}" \
  --frames "${FRAMES}"
