# turbovc3

[![CI](https://github.com/jhodges10/turbovc3/actions/workflows/ci.yml/badge.svg)](https://github.com/jhodges10/turbovc3/actions/workflows/ci.yml)
[![MPL-2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE)

Experimental DNxHD/DNxHR (VC-3) decoding and MXF demuxing for modern browsers, with a
[Mediabunny](https://mediabunny.dev/) extension entry point.

> [!WARNING]
> This is a `0.x` project. The supported codec scope is intentional, but the API and browser integration may change
> before `1.0`. Validate it against your own media before using it in production.

## Install from GitHub Packages

GitHub Packages requires the `@jhodges10` scope to use its npm registry. Add this line to your user or project
`.npmrc`:

```ini
@jhodges10:registry=https://npm.pkg.github.com
```

Authenticate with a GitHub personal access token that has `read:packages`, then install the package:

```sh
npm login --scope=@jhodges10 --auth-type=legacy --registry=https://npm.pkg.github.com
npm install @jhodges10/turbovc3 mediabunny
```

The first package version will be published when its matching GitHub Release is published. npmjs publication is not
configured yet.

## Decode MOV/QuickTime through Mediabunny

Register the extension once before creating a video sink:

```ts
import { registerDnxDecoder } from "@jhodges10/turbovc3";
import { BlobSource, Input, QuickTimeInputFormat, VideoSampleSink } from "mediabunny";

registerDnxDecoder();

const input = new Input({
  formats: [new QuickTimeInputFormat()],
  source: new BlobSource(file)
});
const track = await input.getPrimaryVideoTrack();
if (!track) throw new Error("No video track found.");

const sink = new VideoSampleSink(track);
const sample = await sink.getSample(0);
```

`registerDnxDecoder()` is idempotent. It handles `AVdn` and `AVdh`, preserves timing, dimensions, and color metadata,
and emits `I422`, `I422P10`, `I422P12`, `I444P10`, or `I444P12` samples.

## Read MXF

Mediabunny handles MOV/QuickTime demuxing. The separate MXF entry point handles OP1a and OPAtom track metadata,
index tables, essence packets, and random packet reads:

```ts
import { MxfDemuxer } from "@jhodges10/turbovc3/mxf";

const demuxer = await MxfDemuxer.open(file);
const videoTrack = demuxer.tracks.find((track) => track.kind === "video");
if (!videoTrack) throw new Error("No MXF video track found.");

const firstPacket = demuxer.packetsForTrack(videoTrack)[0];
const encodedFrame = await demuxer.readPacket(firstPacket);

const materialTimecode = demuxer.timecodeTracks.find((track) => track.packageKind === "material");
if (materialTimecode) {
  console.log(demuxer.timecodeAt(materialTimecode, firstPacket.index).formatted);
}
```

Timecode tracks retain their material/source package identity, edit rate, origin, duration, rounded base, and
drop-frame flag. `timecodeAt()` accepts an edit-unit index and returns both the unwrapped frame number and a
24-hour-wrapped `HH:MM:SS:FF` or drop-frame `HH:MM:SS;FF` display value.

Index resolution accepts multiple contiguous index-table segments for the same BodySID. Constant-byte-count and
variable-byte-count clip wrapping are split into edit-unit packets when the index fully describes the layout;
conflicting, overlapping, sparse, or non-monotonic layouts are rejected instead of being guessed.

MXF BWF-style little-endian PCM can drive the same playback clock used for MOV/MP4 audio:

```ts
import { DnxAudioPlayback } from "@jhodges10/turbovc3";

const audio = await DnxAudioPlayback.createFromMxf(demuxer);
await audio?.start();
// Use audio.clock.currentTime as the authoritative video presentation time.
```

`MxfDemuxer.open()` accepts an `AbortSignal`, progress callback, and configurable safety limits for metadata values,
KLVs, tracks, packets, resynchronization work, and descriptor dimensions. Defaults are conservative for local media;
remote or untrusted ingestion should lower them to the application’s actual envelope.

The committed OP1a contracts cover 16-bit stereo at 30 fps and 24-bit mono at 24 fps, including a non-zero source
and material timecode. FFmpeg 8 only muxes 48 kHz MXF audio, so other MXF sample rates remain explicitly unverified.
`DnxAudioPlayback.createFromMxf()` returns `null` for files without audio and throws `DnxNotSupportedError` when
audio tracks exist but none use the supported little-endian 16/24/32-bit PCM layout.

For a one-call DNx adapter, use `demuxDnxMxf()` from the root module.

For source-backed seeking without loading the complete MXF, use the random-access decoder. It keeps a bounded
compressed-packet cache, can prefetch adjacent frames, reports indexing I/O, and coalesces rapid `seek()` calls so
superseded queued targets are aborted before decode:

```ts
import { DnxRandomAccessDecoder } from "@jhodges10/turbovc3";

const decoder = await DnxRandomAccessDecoder.create(file, {
  packetCacheSize: 6,
  prefetchFrames: 2,
  signal: openAbortController.signal,
  onIndexProgress: ({ offset, totalBytes, bytesRead }) => {
    console.log({ offset, totalBytes, bytesRead });
  }
});
if (decoder instanceof Error) throw decoder;

const frame = await decoder.seek(120, { signal: seekAbortController.signal });
if (frame instanceof Error) throw frame;
console.log(frame.timestampUs, decoder.sourceBytesRead);

await decoder.close();
```

`decode(index)` preserves every request. `seek(index)` is intended for scrubbing: it serializes decode work and
returns an `AbortError` for targets superseded by a newer seek. Calling `close()` rejects new work and drains decode
jobs already accepted by the underlying decoder.

## Supported scope

| Area | Current support |
| --- | --- |
| Sample entries | `AVdn` (DNxHD), `AVdh` (DNxHR) |
| Frames | Progressive through 4096×2160; interlaced DNxHD CIDs 1241–1244; field-coded CID 1260 |
| Native output | 8/10/12-bit 4:2:2; 10/12-bit 4:4:4 YUV/RGB |
| Conversion | 8/10/12-bit 4:2:2 to 4:2:0/4:4:4; planar DNx RGB to 4:4:4 YUV |
| MOV/QuickTime | Through Mediabunny |
| MXF | OP1a and OPAtom DNx essence; multi-segment indexes; frame/clip wrapping; PCM; timecode tracks |
| Deferred | Adaptive-macroblock MBAFF packets, alpha, and a dedicated 12-bit 4:4:4 fixture |

Rec. 2020 constant-luminance signaling is preserved in frame metadata but is not rendered or converted to YUV yet:
the DNx header does not carry the transfer-function detail needed to apply that transform faithfully. Renderer
capability checks return `false` for those frames instead of approximating them as Rec. 2020 non-constant-luminance.

| Profile family | CID coverage |
| --- | --- |
| Progressive DNxHD | CIDs 1235, 1237, 1238, 1250–1253, 1258, and 1259 are required FFmpeg oracles |
| Interlaced DNxHD | CIDs 1241–1244 and FFmpeg's non-MBAFF CID 1260 subset are required oracles |
| DNxHR | CIDs 1270–1274 are required at FFmpeg-emittable 8/10-bit formats |
| Implemented, external oracle required | CID 1256 4:4:4 and genuine 12-bit CID 1270/1271 packets |

CI performs real FFmpeg-oracle comparisons for every progressive DNxHD and DNxHR profile that FFmpeg 8 can encode,
interlaced CIDs 1241–1244, field-coded CID 1260, paired DNxHR 444 YUV/GBR inputs, and OP1a/OPAtom demuxing. The
external 12-bit FATE sample remains an opt-in local oracle because FFmpeg 8 cannot produce a genuine 12-bit DNx
packet. The committed synthetic corpus uses bit-exact muxer output and SHA-256 manifests.

Relative to FFmpeg 8's reference CID table, turbovc3 does not silently omit a listed baseline CID. It explicitly
rejects unknown CIDs and the still-deferred coding modes signaled inside otherwise known profiles: genuine adaptive
MBAFF, alpha, and low-latency alpha.

## Runtime backends

Release packages include two WASM binaries. Decoder creation chooses the fastest available path and falls back safely:

1. Cross-origin-isolated pages use shared-memory Zig/WASM row workers.
2. Other worker-capable pages use a bounded packet-worker pool.
3. Environments without usable workers use synchronous Zig/WASM and C/WASM IDCT.
4. If release assets cannot load, decoding continues through the TypeScript implementation.

Shared-memory decoding requires `Worker`, `SharedArrayBuffer`, and `crossOriginIsolated === true`, which normally means
serving suitable COOP/COEP headers. The package does not require cross-origin isolation for ordinary decoding.

Node.js can opt into the packet-worker pool through the dedicated entry point; it does not modify `globalThis.Worker`:

```ts
import { createNodeDecoder, Frame } from "@jhodges10/turbovc3/node";

const decoder = await createNodeDecoder({
  dnxFourCc: "AVdh",
  useSharedMemory: false,
  concurrency: 4
});
if (decoder instanceof Error) throw decoder;
const result = await decoder.decode(packet, new Frame());
await decoder.close();
```

Other runtimes and CSP-specific hosts can provide `DecoderOptions.workerFactory`; the core package does not assume a
Node global or mutate runtime globals.

See the [deployment and lifetime guide](docs/deployment.md) for Vite, Webpack, Next.js, CSP, COOP/COEP, asset-layout,
and object-ownership details.

Mediabunny is a peer dependency with the supported range `^1.50.8`. Version `1.50.8` does not yet classify DNx as a
native `VideoCodec`, so registration installs a guarded compatibility shim that disables itself when a future
Mediabunny release provides that support. `registerDnxDecoder()` checks every shimmed API up front and reports a clear
compatibility error before changing Mediabunny state. CI compiles and decodes a real DNx sample with both `1.50.8` and
the newest published Mediabunny release.

## Public API

The supported root surface contains:

- `registerDnxDecoder()` and container inspection helpers
- `Decoder`, `Frame`, their options, results, and typed decoder errors
- DNx frame-header inspection helpers and types
- `DnxAudioPlayback`, `DnxRandomAccessDecoder`, `DnxCanvasRenderer`, and `DnxWebGpuRenderer`
- `demuxDnxMxf()`, `isMxfFile()`, and MXF adapter types

Low-level bit reading, coefficient reconstruction, IDCT, worker coordination, and native backend modules are internal.
The full general-purpose MXF surface is exported from `@jhodges10/turbovc3/mxf`.

Filled frames expose `toVideoFrame({ timestamp, duration, ... })` for the standard 8-bit planar WebCodecs formats.
The bridge preserves visible/coded dimensions, pixel aspect ratio, color metadata, and plane layout. High-bit-depth
and planar GBR frames remain available through `copyTo()` because the WebCodecs `VideoPixelFormat` surface has no
portable representation for those layouts; attempting the bridge reports `DnxNotSupportedError`.

Worker-backed `Decoder.decode()` calls execute concurrently but their promises settle in submission order. A filled
`Frame` exposes coded/visible dimensions, original and converted pixel formats, square-pixel bare-frame metadata,
numeric color fields with WebCodecs-style string getters, range, scan type, `isFilled`, and `toFilled()`.
Use `copyLayout()`, `allocationSize()`, and `copyTo()` to copy coded plane rows into tightly packed or explicitly
offset/strided destination storage; layouts are range-checked and may not overlap.
`DnxCanvasRenderer` is the portable Canvas2D fallback; `DnxWebGpuRenderer.create()` returns `null` when WebGPU is
unavailable so applications can select the fallback explicitly.
Both renderers expose `isDestroyed`; the WebGPU renderer also exposes `isDeviceLost` and an `onDeviceLost` callback.

## Develop

Requirements for the ordinary workflow are Node.js 22+ and npm:

```sh
npm ci
npm run check
npm run build
npm test
npm run test:package
```

Native development additionally requires Zig `0.16.0` and Emscripten `6.0.2`:

```sh
npm run build:wasm
npm run test:native
REQUIRE_WASM_ASSETS=1 npm run test:package
```

FFmpeg 8.x is only required to regenerate committed fixtures or run the full local oracle corpus. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and [research/README.md](research/README.md) for codec notes.

## License and security

turbovc3 is available under the [Mozilla Public License 2.0](LICENSE). Please report vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/jhodges10/turbovc3/security/advisories/new), not a public
issue. See [SECURITY.md](SECURITY.md) for details.
