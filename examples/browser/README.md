# Browser example

Run from the repository root:

```sh
npm ci
npm run build:wasm # optional; the TypeScript fallback works without generated assets
npm run example:browser
```

Open <http://127.0.0.1:4174> to compare the five generated DNxHR profiles across the SDR/HDR and 1080p/4K sets,
or choose an OP1a or OPAtom DNx MXF file.
The two-column comparison view keeps the filters and flavor list on the left and a single selected player on the
right. Flavor rows report the served file size and calculated average bitrate. Only one sample decoder, packet cache,
and renderer allocation is active at a time, and the MXF itself is read with HTTP byte ranges.

Generate the R3D-based gallery media with:

```sh
bash scripts/generate-r3d-dnxhr-samples.sh
```

The generator decodes five seconds through Alchemist's RED SDK assets as 16-bit RWG/Log3G10. It uses half-resolution
decode for the 1080p outputs and full-resolution decode for real 4K outputs, then applies the RED Rec.709/BT.1886 or
Rec.2020/BT.1886 IPP2 LUT and writes LB, SQ, HQ, HQX, and 444 OP1a MXFs under the ignored `samples/dnxhr` directory.

The local server sends COOP/COEP headers and serves the decoder's module workers so the shared-memory row backend can
use a bounded hardware-based worker count. Playback prefers WebGPU rendering and falls back to Canvas2D when WebGPU is
unavailable. The diagnostics panel reports the active decode backend and renderer.
