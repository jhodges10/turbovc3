#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ALCHEMIST_ROOT="${ALCHEMIST_ROOT:-/Users/jeff/Code/experiments/alchemist}"
SOURCE="${1:-/Volumes/X10 Pro/RED/Beach Shoot/DSC_0017.R3D}"
SDR_LUT="${2:-$ALCHEMIST_ROOT/packages/r3d/color/IPP2 Cubes SDR Core V1_13/REC709/RWG_Log3G10 to REC709_BT1886 with MEDIUM_CONTRAST and R_2_Medium size_33 v1.13.cube}"
OUTPUT_DIR="${3:-$ROOT/samples/dnxhr}"
HDR_LUT="${4:-$ALCHEMIST_ROOT/packages/r3d/color/IPP2 Cubes SDR Core V1_13/REC2020/RWG_Log3G10 to REC2020_BT1886 with MEDIUM_CONTRAST and R_2_Medium size_33 v1.13.cube}"
SDK_ROOT="$ALCHEMIST_ROOT/apps/api/R3DSDKv9_2_0"
SDK_REDIST="$SDK_ROOT/Redistributable/mac"
HELPER="${TMPDIR:-/tmp}/turbovc3-r3d-rwg-stream"
FFMPEG="${FFMPEG:-ffmpeg}"
CXX="${CXX:-c++}"
FPS="24000/1001"
FRAMES=120

for path in "$SOURCE" "$SDR_LUT" "$HDR_LUT" "$SDK_ROOT/Include/R3DSDK.h" "$SDK_ROOT/Lib/mac64/libR3DSDK-libcpp.a"; do
  if [[ ! -e "$path" ]]; then
    echo "Missing required input: $path" >&2
    exit 1
  fi
done

mkdir -p "$OUTPUT_DIR"

"$CXX" -std=c++17 -stdlib=libc++ -O2 -fno-rtti \
  -I"$SDK_ROOT/Include" \
  "$ROOT/scripts/r3d-rwg-stream.cpp" \
  -o "$HELPER" \
  -Wl,-force_load,"$SDK_ROOT/Lib/mac64/libR3DSDK-libcpp.a" \
  -framework CoreFoundation -framework IOKit

encode_set() {
  local gamut="$1"
  local lut="$2"
  local output_width="$3"
  local output_height="$4"
  local resolution="$5"
  local quality="$6"
  local input_width="$7"
  local input_height="$8"
  local -a outputs=(
    "$OUTPUT_DIR/beach_${gamut}_dnxhr_lb_${resolution}p2398_5s.mxf"
    "$OUTPUT_DIR/beach_${gamut}_dnxhr_sq_${resolution}p2398_5s.mxf"
    "$OUTPUT_DIR/beach_${gamut}_dnxhr_hq_${resolution}p2398_5s.mxf"
    "$OUTPUT_DIR/beach_${gamut}_dnxhr_hqx_${resolution}p2398_5s.mxf"
    "$OUTPUT_DIR/beach_${gamut}_dnxhr_444_${resolution}p2398_5s.mxf"
  )
  if [[ "${FORCE:-0}" != "1" ]] && [[ -s "${outputs[0]}" && -s "${outputs[1]}" && -s "${outputs[2]}" && -s "${outputs[3]}" && -s "${outputs[4]}" ]]; then
    echo "Skipping existing ${gamut} ${resolution}p set (use FORCE=1 to rebuild)."
    return
  fi

  local primaries="bt709"
  local matrix="bt709"
  if [[ "$gamut" == "rec2020" ]]; then
    primaries="bt2020"
    matrix="bt2020nc"
  fi
  local filter="lut3d=file='${lut//:/\\:}':interp=tetrahedral,scale=${output_width}:${output_height}:flags=lanczos,setsar=1,format=gbrp16le,split=5[lb_source][sq_source][hq_source][hqx_source][444_source];[lb_source]format=yuv422p[lb];[sq_source]format=yuv422p[sq];[hq_source]format=yuv422p[hq];[hqx_source]format=yuv422p10le[hqx];[444_source]format=gbrp10le[444]"

  echo "Encoding ${gamut} ${resolution}p DNxHR set..."
  DYLD_LIBRARY_PATH="$SDK_REDIST" "$HELPER" "$SDK_REDIST" "$SOURCE" 0 "$FRAMES" "$quality" | \
    "$FFMPEG" -hide_banner -loglevel warning -y \
      -f rawvideo -pixel_format gbrp16le -video_size "${input_width}x${input_height}" \
      -framerate "$FPS" -i pipe:0 \
      -filter_complex "$filter" \
      -map '[lb]' -an -c:v dnxhd -profile:v dnxhr_lb -pix_fmt yuv422p \
        -color_primaries "$primaries" -color_trc bt709 -colorspace "$matrix" "${outputs[0]}" \
      -map '[sq]' -an -c:v dnxhd -profile:v dnxhr_sq -pix_fmt yuv422p \
        -color_primaries "$primaries" -color_trc bt709 -colorspace "$matrix" "${outputs[1]}" \
      -map '[hq]' -an -c:v dnxhd -profile:v dnxhr_hq -pix_fmt yuv422p \
        -color_primaries "$primaries" -color_trc bt709 -colorspace "$matrix" "${outputs[2]}" \
      -map '[hqx]' -an -c:v dnxhd -profile:v dnxhr_hqx -pix_fmt yuv422p10le \
        -color_primaries "$primaries" -color_trc bt709 -colorspace "$matrix" "${outputs[3]}" \
      -map '[444]' -an -c:v dnxhd -profile:v dnxhr_444 -pix_fmt gbrp10le \
        -color_primaries "$primaries" -color_trc bt709 -colorspace rgb "${outputs[4]}"
}

encode_set rec709 "$SDR_LUT" 1920 1080 1080 half 3024 1701
encode_set rec709 "$SDR_LUT" 3840 2160 2160 full 6048 3402
encode_set rec2020 "$HDR_LUT" 1920 1080 1080 half 3024 1701
encode_set rec2020 "$HDR_LUT" 3840 2160 2160 full 6048 3402

for file in "$OUTPUT_DIR"/*.mxf; do
  "$FFMPEG" -v error -i "$file" -map 0:v:0 -frames:v 1 -f null -
done

echo "Wrote SDR/HDR 1080p/4K DNxHR sample sets to $OUTPUT_DIR"
