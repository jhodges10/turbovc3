#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const module = await loadModule();
const decoder = await module.createDnxWasmRowDecoder(
  await readFile(path.join(repoRoot, "wasm/generated/dnx_row_decoder.wasm"))
);
try {
  assert.deepEqual(decoder.capacities, {
    rowBytes: 1024 * 1024,
    packetBytes: 8 * 1024 * 1024,
    frameBytes: 56 * 1024 * 1024,
    macroblocksPerRow: 256,
    rows: 256
  });
  assert.equal(4096 * 2176 * 3 * 2 <= decoder.capacities.frameBytes, true);
  assert.equal(4096 * 4096 * 3 * 2 > decoder.capacities.frameBytes, true);
  assert.throws(
    () => decoder.decodeRow(new Uint8Array(), decoder.capacities.macroblocksPerRow + 1, 8, false, null),
    /macroblock width 257 exceeds.*capacity of 256/
  );
  assert.throws(
    () => decoder.decodeFrame(
      new Uint8Array(),
      Array.from({ length: decoder.capacities.rows + 1 }, () => ({ start: 0, end: 0 })),
      1,
      decoder.capacities.rows + 1,
      8,
      false,
      null
    ),
    /row count 257 exceeds.*capacity of 256/
  );
  assert.throws(
    () => decoder.decodeFrame(
      new Uint8Array(decoder.capacities.packetBytes + 1),
      [{ start: 0, end: 0 }],
      1,
      1,
      8,
      false,
      null
    ),
    /exceeding the Zig buffer capacity/
  );
} finally {
  decoder.destroy();
}

console.log("DNx Zig native capacity boundaries passed.");

async function loadModule() {
  const result = await build({
    entryPoints: [path.join(repoRoot, "src/dnxZigRowDecoder.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
