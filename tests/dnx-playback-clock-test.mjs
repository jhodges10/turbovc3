#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const module = await loadModule();
let now = 10;
const clock = new module.DnxPlaybackClock({ duration: 5, now: () => now });
assert.equal(clock.currentTime, 0);
assert.equal(clock.isRunning, false);
clock.start(1, 10.5);
assert.equal(clock.isRunning, true);
assert.equal(clock.currentTime, 1, "a future audio anchor does not run backward");
now = 11;
assert.equal(clock.currentTime, 1.5);
assert.equal(clock.pause(), 1.5);
now = 20;
assert.equal(clock.currentTime, 1.5);
assert.equal(clock.seek(4), 4);
clock.start();
now = 22;
assert.equal(clock.currentTime, 5, "clock clamps at media duration");
assert.equal(clock.isRunning, false, "reaching end-of-stream stops the clock");
assert.equal(clock.isEnded, true);
assert.equal(clock.seek(-1), 0);
assert.equal(clock.currentTime, 0);
clock.start(2, 20);
now = 20;
assert.equal(clock.videoDecision(1.9, 0.05), "drop");
assert.equal(clock.videoDecision(2.02, 0.05), "present");
assert.equal(clock.videoDecision(2.1, 0.05), "hold");
assert.throws(() => clock.seek(Number.NaN), RangeError);
assert.throws(() => clock.videoDecision(Number.NaN), RangeError);
assert.throws(() => clock.videoDecision(0, -1), RangeError);
assert.throws(() => new module.DnxPlaybackClock({ duration: -1 }), RangeError);
console.log("DNx reusable playback clock contract passed.");

async function loadModule() {
  const result = await build({
    entryPoints: [path.join(repoRoot, "src/dnxPlaybackClock.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
