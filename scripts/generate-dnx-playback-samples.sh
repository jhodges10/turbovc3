#!/usr/bin/env bash
set -euo pipefail

SOURCE="${1:-samples/prores/turbores-sample.mov}"
OUTPUT_DIR="${2:-samples}"
FRAMES="${3:-30}"
FFMPEG="${FFMPEG:-ffmpeg}"

mkdir -p "$OUTPUT_DIR"

"$FFMPEG" -v error -y -i "$SOURCE" \
  -vf fps=30,scale=1920:1080,format=yuv422p \
  -frames:v "$FRAMES" -c:v dnxhd -profile:v dnxhd -b:v 145M -an \
  "$OUTPUT_DIR/playback_dnxhd_1080p30_8bit_${FRAMES}f.mxf"

"$FFMPEG" -v error -y -i "$SOURCE" \
  -vf fps=30,scale=1920:1080,format=yuv422p10le \
  -frames:v "$FRAMES" -c:v dnxhd -profile:v dnxhd -b:v 175M -an \
  "$OUTPUT_DIR/playback_dnxhd_1080p30_10bit_${FRAMES}f.mxf"

echo "Wrote sustained DNx playback fixtures to $OUTPUT_DIR"
