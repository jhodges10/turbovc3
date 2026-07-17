# Browser example

Run from the repository root:

```sh
npm ci
npm run build:wasm # optional; the TypeScript fallback works without generated assets
npm run example:browser
```

Open <http://127.0.0.1:4174> and choose an OP1a or OPAtom DNx MXF file. The example deliberately keeps all codec,
demux, cache, clock, and rendering behavior in the library. Its application code only coordinates file selection,
random access, Canvas2D presentation, optional MXF PCM playback, and diagnostics.

The local server sends COOP/COEP headers so shared-memory backends can be exercised when selected by an application.
This example uses synchronous decode to keep its setup small and its backend fallback visible.
