#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = spawnSync(
  process.execPath,
  ["benchmarks/decode.mjs", "--iterations", "2", "--compact"],
  { cwd: repoRoot, encoding: "utf8", timeout: 120_000 }
);
assert.equal(run.status, 0, run.stderr || run.stdout || `benchmark exited ${run.status}`);
const report = JSON.parse(run.stdout);
assert.equal(report.schemaVersion, 1);
assert.equal(report.iterations, 2);
assert.equal(report.fixture.width, 1920);
assert.equal(report.fixture.height, 1080);
assert.equal(report.synchronous.frames, 2);
assert.equal(report.synchronous.framesPerSecond > 0, true);
assert.equal(Array.isArray(report.native), true);
if (process.env.REQUIRE_NATIVE_BENCH === "1") {
  assert.deepEqual(report.native.map((value) => value.name), ["wasm-idct", "zig-wasm-frame"]);
}
assert.equal(report.native.every((value) => value.frames === 2 && value.framesPerSecond > 0), true);
assert.deepEqual(report.workers.map((value) => value.name), ["workers-1", "workers-2", "workers-4"]);
assert.equal(report.workers.every((value) => value.frames === 2 && value.framesPerSecond > 0), true);
assert.deepEqual(report.teardown, {
  accepted: 4,
  drained: 4,
  closeMs: report.teardown.closeMs
});
assert.equal(report.seek.bytesReadOnColdSeek > 0, true);
assert.equal(report.seek.bytesReadOnWarmSeeks, 0);
assert.equal(report.seek.cachedPacketCount, 1);
assert.equal(report.memory.rssAfterBytes > 0, true);

console.log("Decode benchmark lifecycle and report contract passed.");
