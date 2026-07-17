#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repoRoot, "tests/fixtures/dnxhr-lb-op1a-pcm.mxf");
const iterations = positiveInteger(argument("--iterations") ?? process.env.FUZZ_ITERATIONS ?? "32");
const module = await loadModule();
const mxfBytes = new Uint8Array(await readFile(fixturePath));
const demuxed = await module.demuxDnxMxf(mxfBytes);
assert.ok(demuxed);
const packet = await demuxed.demuxer.readPacket(demuxed.packets[0]);

await fuzzDnx(packet);
await fuzzMxf(mxfBytes);
console.log(`Deterministic DNx/MXF fuzz smoke passed (${iterations} mutations each).`);

async function fuzzDnx(seed) {
  const decoder = await module.Decoder.create({
    dnxFourCc: "AVdh",
    useSharedMemory: false,
    concurrency: 0
  });
  assert.equal(decoder instanceof Error, false);
  let rejected = 0;

  for (let index = 0; index < iterations; index += 1) {
    const mutation = mutateDnx(seed, index);
    const frame = new module.Frame();
    let result;
    await assert.doesNotReject(async () => {
      result = await decoder.decode(mutation, frame);
    });
    assert.equal(frame.isLocked, false, `DNx mutation ${index} released its frame lock`);
    if (result instanceof Error) {
      rejected += 1;
      assert.equal(frame.isFilled, false);
    } else {
      assert.equal(result, frame);
      assert.equal(frame.isFilled, true);
      frame.clear();
    }
  }

  assert.equal(rejected > 0, true, "DNx mutations exercised rejection paths");
  await decoder.close();
}

async function fuzzMxf(seed) {
  let rejected = 0;
  for (let index = 0; index < iterations; index += 1) {
    const mutation = mutateMxf(seed, index);
    try {
      const demuxer = await module.MxfDemuxer.open(mutation, {
        limits: {
          maxMetadataValueBytes: 2 * 1024 * 1024,
          maxMetadataSets: 10_000,
          maxKlvPackets: 10_000,
          maxTracks: 64,
          maxPackets: 10_000,
          maxResyncBytes: 256 * 1024,
          maxWidth: 8_192,
          maxHeight: 8_192,
          maxFramePixels: 67_108_864
        }
      });
      assert.equal(Array.isArray(demuxer.tracks), true);
      assert.equal(Array.isArray(demuxer.packets), true);
    } catch (error) {
      rejected += 1;
      assert.equal(error instanceof Error, true, `MXF mutation ${index} threw an Error`);
    }
  }
  assert.equal(rejected > 0, true, "MXF mutations exercised rejection paths");
}

function mutateDnx(seed, index) {
  const truncations = [0, 1, 16, 639, 640, Math.floor(seed.length / 2), seed.length - 1];
  if (index < truncations.length) {
    return seed.slice(0, Math.max(0, truncations[index]));
  }
  const bytes = seed.slice();
  const boundaries = [0, 5, 6, 7, 0x16, 0x18, 0x1a, 0x21, 0x28, 0x2c, 0x16c, 0x170];
  const offset = boundaries[(index - truncations.length) % boundaries.length];
  bytes[offset] ^= 1 << (index % 8);
  if (index % 5 === 0 && bytes.length > 0x178) {
    bytes.fill(0xff, 0x170, 0x178);
  }
  return bytes;
}

function mutateMxf(seed, index) {
  const truncations = [0, 1, 16, 17, 24, 64, Math.floor(seed.length / 2), seed.length - 1];
  if (index < truncations.length) {
    return seed.slice(0, Math.max(0, truncations[index]));
  }
  const bytes = seed.slice();
  const state = xorshift32(index + 1);
  const mutationCount = 1 + (index % 4);
  for (let mutation = 0; mutation < mutationCount; mutation += 1) {
    const offset = state() % bytes.length;
    bytes[offset] ^= 1 << (state() % 8);
  }
  if (index % 7 === 0 && bytes.length > 17) {
    bytes[16] = 0xff;
  }
  return bytes;
}

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError("--iterations must be a positive integer.");
  }
  return parsed;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function loadModule() {
  const result = await build({
    stdin: {
      contents: `
        export { Decoder, Frame } from ${JSON.stringify(path.join(repoRoot, "src/dnxDecoder.ts"))};
        export { demuxDnxMxf } from ${JSON.stringify(path.join(repoRoot, "src/dnxMxf.ts"))};
        export { MxfDemuxer } from ${JSON.stringify(path.join(repoRoot, "src/mxf/index.ts"))};
      `,
      resolveDir: repoRoot,
      sourcefile: "fuzz-smoke-entry.ts"
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
