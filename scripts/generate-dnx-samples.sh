#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-/Users/jeff/Library/CloudStorage/Dropbox/what_are_we_doing_to_fix_it.mp4}"
OUTPUT_DIR="${2:-samples}"
FRAMES="${3:-3}"

npm run fixtures:generate --workspace dnx-codecs -- \
  --source "${SOURCE}" \
  --fixture-dir "${OUTPUT_DIR}" \
  --frames "${FRAMES}"
