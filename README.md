# turbovc3

Browser DNxHD/DNxHR decoding with a Mediabunny-compatible extension entry point.

## Mediabunny setup

The public setup matches `@mediabunny/prores`: register the decoder once before creating a decoding sink.

```ts
import { registerDnxDecoder } from "turbovc3";
import { BlobSource, Input, QuickTimeInputFormat, VideoSampleSink } from "mediabunny";

registerDnxDecoder();

const input = new Input({
  formats: [new QuickTimeInputFormat()],
  source: new BlobSource(file)
});
const track = await input.getPrimaryVideoTrack();
if (!track) {
  throw new Error("No video track found.");
}

const sink = new VideoSampleSink(track);
const sample = await sink.getSample(0);
```

`registerDnxDecoder()` is idempotent. It registers a Mediabunny `CustomVideoDecoder` for `AVdn` and `AVdh`, emits
`I422`, `I422P10`, `I422P12`, `I444P10`, or `I444P12` `VideoSample` objects, and preserves packet timestamps,
durations, display dimensions, and color metadata.

The lower-level `Decoder` can emit native 4:2:2 and 4:4:4 YUV/RGB at 8, 10, or 12 bits. It can also convert native
4:2:2 to 4:2:0 or 4:4:4 and convert planar DNx RGB to 4:4:4 YUV when selected through `allowedOutputFormats`.
`Frame.originalPixelFormat` describes the encoded layout while `Frame.pixelFormat` describes the returned planes.

Mediabunny `1.50.8` does not yet classify DNx sample entries as a `VideoCodec`. Until it does, registration installs a
guarded `InputVideoTrack` compatibility shim for codec recognition, decoder configuration, and intraframe packet
semantics. Registration also suppresses only Mediabunny's expected `AVdn`/`AVdh` unsupported-codec console messages
while continuing to emit its warning events and all unrelated warnings. These shims are skipped automatically when a
future Mediabunny release includes `dnx` in `VIDEO_CODECS`.

Current decode scope covers progressive DNxHD and DNxHR through 4096x2160 with 8/10/12-bit 4:2:2 and 10/12-bit
4:4:4 YUV/RGB output. The strict oracle suite includes FFmpeg's official 12-bit CID 1271 FATE sample; a dedicated
12-bit 4:4:4 source fixture is still needed for that exact profile combination.
Cross-origin-isolated pages use a shared-memory row-worker backend. If that pool cannot initialize, its partial workers
are terminated before decoder creation retries the packet-worker backend and then the synchronous backend; other
environments start with those same fallbacks. Mediabunny handles MOV/QuickTime demuxing. `turbovc3/mxf` supplies standards-based OP1a
and OPAtom track, descriptor, index-table, and essence packet extraction for MXF decode and random access.

`DnxAudioPlayback` is an optional container-level companion for MOV/QuickTime files with a decodable audio track. It
uses Mediabunny's `AudioBufferSink`, schedules buffers through Web Audio, exposes an audio-backed media clock, and
supports pause and sample-accurate seek without coupling audio decoding to the DNx video decoder.
