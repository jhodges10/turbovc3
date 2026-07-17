#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recipePath = path.join(repoRoot, "tests/fixtures/malformed-dnx-cases.json");
const recipes = JSON.parse(await readFile(recipePath, "utf8"));
const module = await loadModule();
assert.deepEqual(
  module.createDnxFrameLayout({
    width: 16,
    height: 16,
    is444: true,
    bitDepth: 12,
    pixelFormat: "gbrp12"
  }).planes.map((plane) => plane.label),
  ["G", "B", "R"]
);
const mxf = await module.demuxDnxMxf(
  new Uint8Array(await readFile(path.join(repoRoot, "tests/fixtures", recipes.seed)))
);
assert.ok(mxf, "malformed DNx seed MXF demuxed");
const seed = await mxf.demuxer.readPacket(mxf.packets[0]);
const decoder = await module.Decoder.create({
  dnxFourCc: "AVdh",
  useSharedMemory: false,
  concurrency: 0
});
assert.equal(decoder instanceof Error, false);

for (const recipe of recipes.cases) {
  const packet = mutate(seed, recipe.mutation);
  const frame = new module.Frame();
  const result = await decoder.decode(packet, frame);
  assert.equal(result.name, recipe.error, recipe.name);
  assert.match(result.message, new RegExp(escapeRegExp(recipe.message), "i"), recipe.name);
  assert.equal(frame.isLocked, false, `${recipe.name} releases the frame lock`);
  assert.equal(frame.isFilled, false, `${recipe.name} does not expose a partial frame`);
}

await decoder.close();

const interlacedMxf = await module.demuxDnxMxf(
  new Uint8Array(
    await readFile(path.join(repoRoot, "tests/fixtures/oracle_dnxhd_1080i2997_10bit_cid1241.mxf"))
  )
);
assert.ok(interlacedMxf, "interlaced DNx seed MXF demuxed");
const interlacedSeed = await interlacedMxf.demuxer.readPacket(interlacedMxf.packets[0]);
const interlacedDecoder = await module.Decoder.create({
  dnxFourCc: "AVdn",
  useSharedMemory: false,
  concurrency: 0
});
assert.equal(interlacedDecoder instanceof Error, false);
const codingUnitSize = 458752;

const validInterlaced = await interlacedDecoder.decode(interlacedSeed, new module.Frame());
assert.equal(validInterlaced instanceof Error, false);
assert.equal(validInterlaced.scanType, "interlaced-top-field-first");
assert.equal(validInterlaced.visibleHeight, 1080);

const corruptSecondHeader = interlacedSeed.slice();
corruptSecondHeader[codingUnitSize] ^= 0xff;
const corruptSecondResult = await interlacedDecoder.decode(corruptSecondHeader, new module.Frame());
assert.equal(corruptSecondResult.name, "DnxInvalidDataError");
assert.match(corruptSecondResult.message, /coding unit 1.*invalid/i);

const repeatedParity = interlacedSeed.slice();
repeatedParity[codingUnitSize + 5] = repeatedParity[5];
const repeatedParityResult = await interlacedDecoder.decode(repeatedParity, new module.Frame());
assert.equal(repeatedParityResult.name, "DnxInvalidDataError");
assert.match(repeatedParityResult.message, /same field parity/i);

const bottomFirst = new Uint8Array(interlacedSeed.byteLength);
bottomFirst.set(interlacedSeed.subarray(codingUnitSize), 0);
bottomFirst.set(interlacedSeed.subarray(0, codingUnitSize), codingUnitSize);
const bottomFirstResult = await interlacedDecoder.decode(bottomFirst, new module.Frame());
assert.equal(bottomFirstResult instanceof Error, false);
assert.equal(bottomFirstResult.scanType, "interlaced-bottom-field-first");

await interlacedDecoder.close();
console.log(`Malformed DNx boundary corpus passed (${recipes.cases.length + 2} cases plus field-order coverage).`);

function mutate(seed, mutation) {
  if (mutation.type === "truncate") {
    return seed.slice(0, mutation.length);
  }
  if (mutation.type === "truncate-half") {
    return seed.slice(0, Math.floor(seed.byteLength / 2));
  }

  const packet = seed.slice();
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (mutation.type === "xor") {
    packet[mutation.offset] ^= mutation.value;
  } else if (mutation.type === "set-u32be") {
    view.setUint32(mutation.offset, mutation.value);
  } else if (mutation.type === "set-u32be-pairs") {
    for (const [offset, value] of mutation.values) {
      view.setUint32(offset, value);
    }
  } else if (mutation.type === "fill-first-row") {
    const dataOffset = 0x280;
    const start = dataOffset + view.getUint32(0x170);
    const end = dataOffset + view.getUint32(0x174);
    packet.fill(mutation.value, start, end);
  } else if (mutation.type === "fill-tail") {
    packet.fill(mutation.value, packet.byteLength - mutation.length);
  } else {
    throw new Error(`Unknown malformed DNx mutation ${mutation.type}.`);
  }
  return packet;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function loadModule() {
  const result = await build({
    stdin: {
      contents: `
        export { Decoder, Frame } from ${JSON.stringify(path.join(repoRoot, "src/dnxDecoder.ts"))};
        export { demuxDnxMxf } from ${JSON.stringify(path.join(repoRoot, "src/dnxMxf.ts"))};
        export { createDnxFrameLayout } from ${JSON.stringify(path.join(repoRoot, "src/dnxReconstruction.ts"))};
      `,
      resolveDir: repoRoot,
      sourcefile: "dnx-malformed-entry.ts"
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
