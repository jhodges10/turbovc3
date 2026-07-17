# Public API and 1.0 direction

turbovc3 is experimental `0.x` software. Minor releases may make breaking changes when decode correctness, resource
ownership, or browser portability requires them; those changes must update the checked-in API Extractor reports and
the changelog. Patch releases should remain source-compatible unless they close a security or data-corruption bug.

The intended `1.0` root surface is deliberately small:

- Mediabunny registration and DNx/MXF inspection helpers;
- `Decoder`, reusable `Frame`, typed errors, output-copy and `VideoFrame` bridges;
- audio playback, playback-clock, random-access, Canvas2D, WebGPU, and explicit deinterlacing helpers;
- the decode/frame/color/plane types needed to use those objects; and
- the narrow `demuxDnxMxf()` adapter for supported OP1a/OPAtom DNx workflows.

`@jhodges10/turbovc3/mxf` is the separately versioned low-level demuxing surface. It exposes KLV, partition,
descriptor, track, packet, timecode, source, and index models for callers that need container inspection beyond the
root DNx adapter. `@jhodges10/turbovc3/node` adds Node worker construction without adding a second codec API.

Bit readers, VLC and reconstruction tables, scalar/native IDCT and row decoders, worker protocols, capacity ABI
details, and generated WASM implementation modules are not supported import paths. They may exist in `dist` because
the public runtime depends on them, but the package export map intentionally prevents consumers from importing them.

Before `1.0`, every public object must have explicit ownership/teardown semantics, all three entry points must retain
API reports, worker and asset fallback behavior must remain tested, and support claims must be backed by committed
or clearly identified external oracle fixtures. Adding a new root export requires a user-facing use case and an API
report review; implementation convenience alone is not sufficient.
