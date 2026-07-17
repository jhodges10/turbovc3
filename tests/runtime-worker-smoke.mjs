#!/usr/bin/env -S deno run --allow-read
import assert from "node:assert/strict";

const runtime = globalThis.Deno ? "deno" : globalThis.Bun ? "bun" : "unknown";
if (runtime === "unknown") {
  throw new Error("This smoke test requires Deno or Bun.");
}

const [{ Decoder, Frame }, { demuxDnxMxf }] = await Promise.all([
  import("../dist/dnxDecoder.js"),
  import("../dist/dnxMxf.js")
]);
const fixtureUrl = new URL("./fixtures/dnxhr-lb-op1a-pcm.mxf", import.meta.url);
const fixtureBytes = runtime === "deno"
  ? await globalThis.Deno.readFile(fixtureUrl)
  : new Uint8Array(await globalThis.Bun.file(fixtureUrl).arrayBuffer());
const demuxed = await demuxDnxMxf(fixtureBytes);
assert.ok(demuxed);
const packet = await demuxed.demuxer.readPacket(demuxed.packets[0]);

const scalar = await Decoder.create({
  dnxFourCc: "AVdh",
  useSharedMemory: false,
  concurrency: 0
});
assert.equal(scalar instanceof Error, false);
const scalarFrame = await scalar.decode(packet, new Frame());
assert.equal(scalarFrame instanceof Error, false);
assert.equal(scalarFrame.isFilled, true);
assert.match(scalar.idctMode, /typescript-idct|wasm-idct|zig-wasm-frame/);
await scalar.close();

const workerFactory = (_kind, moduleUrl) => new Worker(moduleUrl, { type: "module" });
const workers = await Decoder.create({
  dnxFourCc: "AVdh",
  useSharedMemory: false,
  concurrency: 1,
  workerFactory
});
assert.equal(workers instanceof Error, false);
const workerFrame = await workers.decode(packet, new Frame());
assert.equal(workerFrame instanceof Error, false);
assert.equal(workerFrame.isFilled, true);
assert.match(workers.idctMode, /^worker-pool\//);
await workers.close();

console.log(`${runtime} direct ESM and packet-worker smoke passed (${workers.idctMode}).`);
