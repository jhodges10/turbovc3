#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_file="${1:-$repo_root/samples/wip_gallery_page.mov}"
ffmpeg_bin="${FFMPEG:-ffmpeg}"
output_dir="$repo_root/samples"

mkdir -p "$output_dir"

"$ffmpeg_bin" -y -v error \
  -i "$source_file" \
  -f lavfi -i sine=frequency=1000:sample_rate=48000 \
  -t 1 -map 0:v:0 -map 1:a:0 \
  -vf fps=30,scale=1280:720,format=yuv422p \
  -c:v dnxhd -profile:v dnxhr_lb \
  -c:a pcm_s16le -ar 48000 -ac 2 \
  "$output_dir/mxf_demux_op1a_dnx_pcm.mxf"

"$ffmpeg_bin" -y -v error \
  -i "$source_file" \
  -t 1 -map 0:v:0 \
  -vf fps=30,scale=1280:720,format=yuv422p \
  -c:v dnxhd -profile:v dnxhr_lb \
  -f mxf_opatom \
  "$output_dir/mxf_demux_opatom_dnx.mxf"

printf 'Generated MXF demux fixtures in %s\n' "$output_dir"
