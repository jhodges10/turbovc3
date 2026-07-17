# Decode benchmarks

Run the committed decode benchmark after a build:

```sh
npm run bench:decode
```

Use `-- --iterations N --compact` to change the sample count or emit single-line JSON. The report includes:

- synchronous decode FPS and p50/p95 latency;
- Node packet-worker throughput at concurrency 1, 2, and 4;
- Emscripten IDCT and Zig frame-decode results when `wasm/generated` exists;
- close-under-load drain latency;
- source-backed MXF open, cold-seek, and cached warm-seek latency and bytes read;
- process RSS before and after the run.

The harness uses committed, checksummed 1080p DNxHR LB and OPAtom fixtures. It verifies allocation reuse, draining of
accepted work, and zero packet rereads on cached warm seeks before emitting a report. Set `REQUIRE_NATIVE_BENCH=1`
to make missing WASM assets an error.

CI runs a two-iteration structural smoke test. It deliberately does not impose wall-clock thresholds on shared
GitHub runners. Performance comparisons are meaningful only on the same machine, power mode, runtime version, and
iteration count. Capture those fields with the JSON result when investigating a regression; named baseline hardware
and release-blocking budgets remain future qualification work.
