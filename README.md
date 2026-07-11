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
```

For a one-call DNx adapter, use `demuxDnxMxf()` from the root module.

## Supported scope

| Area | Current support |
| --- | --- |
| Sample entries | `AVdn` (DNxHD), `AVdh` (DNxHR) |
| Frames | Progressive through 4096×2160 |
| Native output | 8/10/12-bit 4:2:2; 10/12-bit 4:4:4 YUV/RGB |
| Conversion | 4:2:2 to 4:2:0/4:4:4; planar DNx RGB to 4:4:4 YUV |
| MOV/QuickTime | Through Mediabunny |
| MXF | OP1a and OPAtom DNx essence; PCM track metadata and packet extraction |
| Deferred | Interlaced/MBAFF, alpha, and a dedicated 12-bit 4:4:4 fixture |

CI performs real FFmpeg-oracle comparisons for DNxHD 8-bit, DNxHR HQX 10-bit, and DNxHR 444 10-bit, plus OP1a
and OPAtom demuxing. The extended local suite covers additional profiles and the external FFmpeg 12-bit FATE sample.

## Runtime backends

Release packages include two WASM binaries. Decoder creation chooses the fastest available path and falls back safely:

1. Cross-origin-isolated pages use shared-memory Zig/WASM row workers.
2. Other worker-capable pages use a bounded packet-worker pool.
3. Environments without usable workers use synchronous Zig/WASM and C/WASM IDCT.
4. If release assets cannot load, decoding continues through the TypeScript implementation.

Shared-memory decoding requires `Worker`, `SharedArrayBuffer`, and `crossOriginIsolated === true`, which normally means
serving suitable COOP/COEP headers. The package does not require cross-origin isolation for ordinary decoding.

Mediabunny `1.50.8` does not yet classify DNx as a native `VideoCodec`. Registration therefore installs a guarded
compatibility shim that disables itself when a future Mediabunny release provides that support.

## Public API

The supported root surface contains:

- `registerDnxDecoder()` and container inspection helpers
- `Decoder`, `Frame`, their options, results, and typed decoder errors
- DNx frame-header inspection helpers and types
- `DnxAudioPlayback`, `DnxRandomAccessDecoder`, and `DnxWebGpuRenderer`
- `demuxDnxMxf()`, `isMxfFile()`, and MXF adapter types

Low-level bit reading, coefficient reconstruction, IDCT, worker coordination, and native backend modules are internal.
The full general-purpose MXF surface is exported from `@jhodges10/turbovc3/mxf`.

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
