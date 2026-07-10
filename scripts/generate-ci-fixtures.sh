#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="${1:-$ROOT/tests/fixtures}"
FFMPEG="${FFMPEG:-ffmpeg}"

if ! "$FFMPEG" -version | head -n 1 | grep -q "ffmpeg version 8\."; then
  echo "FFmpeg 8.x is required to regenerate the committed oracle corpus." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

"$FFMPEG" -v error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=1" \
  -frames:v 1 -pix_fmt yuv422p -c:v dnxhd -profile:v dnxhd -b:v 90M -an \
  -metadata creation_time=1970-01-01T00:00:00Z \
  "$OUTPUT_DIR/oracle_dnxhd_720p30_8bit_cid1251.mxf"

"$FFMPEG" -v error -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=1" \
  -frames:v 1 -pix_fmt yuv422p10le -c:v dnxhd -profile:v dnxhr_hqx -an \
  -metadata creation_time=1970-01-01T00:00:00Z \
  "$OUTPUT_DIR/oracle_dnxhr_hqx_1080p30_10bit_cid1271.mov"

"$FFMPEG" -v error -y \
  -f lavfi -i "testsrc2=size=1920x1080:rate=30:duration=1" \
  -frames:v 1 -pix_fmt yuv444p10le -c:v dnxhd -profile:v dnxhr_444 -an \
  -metadata creation_time=1970-01-01T00:00:00Z \
  "$OUTPUT_DIR/oracle_dnxhr_444_1080p30_10bit.mov"

"$FFMPEG" -v error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=1" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=1" \
  -frames:v 1 -map 0:v:0 -map 1:a:0 -pix_fmt yuv422p \
  -c:v dnxhd -profile:v dnxhr_lb -c:a pcm_s16le -ar 48000 -ac 2 \
  -metadata creation_time=1970-01-01T00:00:00Z \
  "$OUTPUT_DIR/dnxhr-lb-op1a-pcm.mxf"

"$FFMPEG" -v error -y \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=1" \
  -frames:v 1 -pix_fmt yuv422p -c:v dnxhd -profile:v dnxhr_lb \
  -metadata creation_time=1970-01-01T00:00:00Z -f mxf_opatom \
  "$OUTPUT_DIR/dnxhr-lb-opatom.mxf"

for fixture in \
  "oracle_dnxhd_720p30_8bit_cid1251.mxf yuv422p" \
  "oracle_dnxhr_hqx_1080p30_10bit_cid1271.mov yuv422p10le" \
  "oracle_dnxhr_444_1080p30_10bit.mov yuv444p10le"
do
  file="${fixture%% *}"
  format="${fixture##* }"
  raw="$OUTPUT_DIR/${file%.*}.yuv"
  "$FFMPEG" -v error -y -i "$OUTPUT_DIR/$file" \
    -frames:v 1 -f rawvideo -pix_fmt "$format" "$raw"
  gzip -n -9 -f "$raw"
done

node "$ROOT/scripts/update-fixture-manifest.mjs" "$OUTPUT_DIR"
echo "Regenerated committed fixtures in $OUTPUT_DIR"
