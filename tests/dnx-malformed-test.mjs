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
console.log(`Malformed DNx boundary corpus passed (${recipes.cases.length} cases).`);

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
