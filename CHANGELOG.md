# Changelog

All notable changes to turbovc3 will be documented here.

## [Unreleased]

### Added

- Source-backed MXF and random-access decode for `Blob`, `File`, and custom sources, with abortable indexing and
  packet reads, progress/read telemetry, bounded compressed-packet caching, adjacent prefetch, and coalesced seeks.
- Filled-frame inspection metadata and 12-bit 4:2:0 conversion/WebGPU support.
- Configurable MXF safety limits for untrusted metadata, KLV, track, packet, dimension, and resynchronization work.
- A `@jhodges10/turbovc3/node` entry point backed by `node:worker_threads`, plus an injectable worker factory for
  runtimes that do not expose the browser `Worker` global.
- Committed API Extractor reports and deterministic DNx/MXF mutation testing in CI.

### Changed

- Packet-worker decode promises now settle in submission order while retaining concurrent execution.
- Shared-row decoding reuses its packet allocation and retains output allocations across reuse of the same `Frame`.
- Decoder teardown rejects new work and drains accepted decode/source operations before terminating workers.
- Truncated packets with valid DNx headers now report `DnxUnexpectedEofError` instead of a capability error.
- Published worker modules use direct-ESM-compatible `.js` specifiers.
- Worker failures preserve decoder error categories and include packet-request or shared-row context.

## [0.1.0] - 2026-07-10

### Added

- Progressive DNxHD and DNxHR decoding with TypeScript, C/WASM IDCT, and Zig/WASM backends.
- Mediabunny decoder registration for `AVdn` and `AVdh` sample entries.
- OP1a and OPAtom MXF demuxing, random packet access, and PCM track metadata.
- Audio playback, random-access decoding, and WebGPU rendering helpers.
- Committed codec-oracle fixtures, package smoke tests, CI, and GitHub Packages release automation.

[Unreleased]: https://github.com/jhodges10/turbovc3/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/jhodges10/turbovc3/releases/tag/v0.1.0
