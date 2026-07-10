# DNxHD/DNxHR Browser Decode Notes

## v1 Scope

- Containers: MOV/QuickTime via Mediabunny `1.50.8`; MXF OP1a/OPAtom via `turbov3/mxf`.
- Sample entries: `AVdn` for DNxHD and `AVdh` for DNxHR.
- Frame scope: progressive frames through 4096x2160, 8/10/12-bit 4:2:2, and 10/12-bit 4:4:4 YUV/RGB.
- Deferred: alpha, MBAFF/interlaced, and upstream `@mediabunny/dnx` packaging.

## Frame Header Fields

- Header prefix is either classic `00 00 02 80 01/02` or DNxHR-style offset prefix ending in byte `03`.
- Height is stored at byte `0x18`; width is stored at byte `0x1a`.
- Bit depth indicator is `packet[0x21] >> 5`: `1` means 8-bit, `2` means 10-bit, `3` means 12-bit.
- CID is stored big-endian at byte `0x28`.
- Color metadata and 4:4:4/adaptive color transform flags are stored at byte `0x2c`.
- Macroblock height is stored big-endian at byte `0x16c`.
- Classic packet data starts at `0x280`; larger DNxHR frames can use `0x170 + (macroblockHeight << 2)`.

## CID Handling

The TypeScript parser keeps the initial CID table small and oriented around browser v1 playback:

- Fixed-size DNxHD CIDs for 1920x1080 and 1280x720.
- Variable-size DNxHR CIDs `1270` to `1274` for 444/HQX/HQ/SQ/LB.
- CID `1270` uses 12 blocks per macroblock and the CID-1235 VLC/weight family for 10/12-bit 4:4:4.

FFmpeg remains the oracle for frame-size math, CID coverage, and unsupported-profile behavior.

CID `1271` (DNxHR HQX 10-bit 4:2:2) uses the 1241 luma/chroma quantization weights with
the existing 1235 DC, AC, run, and 10-bit coefficient scaling tables. The browser decoder
keeps this as a table mapping rather than a separate bitstream implementation. HQX uses
the higher-precision `levelBias=32` and `levelShift=6` coefficient scaling path despite
producing 4:2:2 output.

## Decoder Architecture

The intended decoder mirrors TurboRes:

- `Decoder.create({ dnxFourCc, useSharedMemory, concurrency, allowedOutputFormats })`
- reusable `Frame` containers
- errors-as-values
- `decodeQueueSize`, `desiredSize`, and `dequeued` for backpressure

The Mediabunny extension surface mirrors `@mediabunny/prores`: consumers call the idempotent
`registerDnxDecoder()` once, after which `VideoSampleSink` selects the custom decoder automatically for `AVdn` and
`AVdh` tracks. Mediabunny 1.50.8 still reports those sample entries as unknown, so the extension temporarily augments
`InputVideoTrack` codec/config/intraframe methods. That guarded shim disables itself once `VIDEO_CODECS` includes
`dnx`. Registration filters the corresponding `AVdn`/`AVdh` unsupported-codec console messages without hiding their
warning events or unrelated MediaBunny warnings; no installed Mediabunny files are patched.

The preferred implementation copies each packet into Zig/WASM once, decodes coefficient VLCs, applies inverse quantization, runs a SIMD inverse DCT, and assembles contiguous 4:2:2 or 4:4:4 planar frames. The frame path reconstructs and stores each block immediately, uses vectorized 8-pixel row writes, and fills DC-only blocks directly. Cross-origin-isolated pages distribute macroblock rows across shared-memory Zig workers; other environments use a bounded packet-worker pool. The C/WASM IDCT and TypeScript implementations remain layered correctness fallbacks.

The playground uploads planar 4:2:0, 4:2:2, 4:4:4, and GBR output to WebGPU integer textures and applies Rec. 709
or Rec. 2020 conversion in WGSL. Its Canvas 2D path mirrors those formats as a compatibility fallback.

Long-clip playback retains only the current decoded frame and the decoder's bounded worker backlog. `DnxRandomAccessDecoder` builds the compressed packet index once and keeps one packet worker warm for subsequent single-frame seeks. The playground coalesces rapid scrub input to one in-flight decode plus the latest requested target, so stale frames cannot fill the worker queue. It does not cache the full uncompressed clip. The shared `DecodeSessionOptions.startFrame` and `maxFrames` range contract remains the generic fallback for non-DNx codecs.

## Fixture Commands

Use `scripts/generate-dnx-samples.sh` for the profile fixtures and `scripts/generate-dnx-playback-samples.sh` for sustained 30-frame MXF playback fixtures. The strict FFmpeg oracle suite covers DNxHD CIDs 1251, 1237, and 1235 plus DNxHR CIDs 1274 through 1270, including 10-bit 4:4:4 and 12-bit 4:2:2. The 12-bit fixture is FFmpeg's official `dnxhd/dnxhr_cid1271_12bit.mov` FATE sample and is stored locally as ignored `samples/oracle_fate_dnxhr_cid1271_12bit.mov`. Do not commit generated or downloaded media unless a tiny fixture is deliberately added for tests.

```sh
curl -fsSL https://fate-suite.ffmpeg.org/dnxhd/dnxhr_cid1271_12bit.mov \
  -o samples/oracle_fate_dnxhr_cid1271_12bit.mov
```

The primary sustained fixtures are ignored local files generated from `samples/wip_gallery_page.mov`:

- `wip_gallery_page_1920x1080_60fps.mxf`: DNxHR LB, 8-bit 4:2:2, 60 FPS, used for playback throughput.
- `wip_gallery_page_3840x2160_60fps.mxf`: the matching UHD file, used for 4K frame decode and capacity coverage.

MXF track edit rates are resolved from local tag `0x4B01` through the primer/local metadata sets. Frame-wrapped OP1a
uses each Generic Container essence KLV as a packet; clip-wrapped OPAtom is subdivided with the index table's
`EditUnitByteCount`. The DNx adapter validates each resulting picture packet before exposing it to decode or seek.
