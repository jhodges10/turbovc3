#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = path.join(repoRoot, "scripts/build-dnx-wasm.sh");
const wasmPath = path.join(repoRoot, "src/wasm/generated/dnx_idct_kernel.wasm");

const IDCT_BASIS = Array.from({ length: 8 }, (_, x) =>
  Array.from({ length: 8 }, (_, u) => (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16))
);

await main();

async function main() {
  const build = spawnSync("bash", [buildScript], { cwd: repoRoot, stdio: "inherit" });
  if (build.status !== 0) {
    throw new Error("Failed to build DNx WASM IDCT kernel.");
  }

  const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {
    env: {
      emscripten_notify_memory_growth() {}
    }
  });
  const exports = instance.exports;
  const malloc = exports.malloc ?? exports._malloc;
  const free = exports.free ?? exports._free;
  const transform = exports.dnx_idct_i32_blocks ?? exports._dnx_idct_i32_blocks;
  const version = exports.dnx_idct_kernel_version ?? exports._dnx_idct_kernel_version;
  if (!(malloc instanceof Function) || !(free instanceof Function) || !(transform instanceof Function)) {
    throw new Error("DNx WASM IDCT kernel did not export malloc/free/transform.");
  }
  if (version instanceof Function && version() !== 1) {
    throw new Error(`Unexpected DNx WASM IDCT kernel version ${version()}.`);
  }

  for (const bitDepth of [8, 10]) {
    assertKernelMatchesTypescript(exports.memory, malloc, free, transform, makeBlocks(16), bitDepth);
  }

  console.log("DNx WASM IDCT kernel parity passed.");
}

function assertKernelMatchesTypescript(memory, malloc, free, transform, coeffs, bitDepth) {
  const blockCount = coeffs.length / 64;
  const coeffByteLength = coeffs.byteLength;
  const sampleByteLength = blockCount * 64 * 2;
  const coeffPtr = malloc(coeffByteLength);
  const samplePtr = malloc(sampleByteLength);

  try {
    new Int32Array(memory.buffer, coeffPtr, coeffs.length).set(coeffs);
    transform(coeffPtr, samplePtr, blockCount, bitDepth);

    const actual = new Uint16Array(memory.buffer, samplePtr, blockCount * 64);
    const expected = idctBlocksTypescript(coeffs, blockCount, bitDepth);
    for (let index = 0; index < expected.length; index += 1) {
      if (actual[index] !== expected[index]) {
        throw new Error(`IDCT mismatch at sample ${index} for ${bitDepth}-bit: ${actual[index]} !== ${expected[index]}`);
      }
    }
  } finally {
    free(samplePtr);
    free(coeffPtr);
  }
}

function makeBlocks(blockCount) {
  const coeffs = new Int32Array(blockCount * 64);
  for (let block = 0; block < blockCount; block += 1) {
    const offset = block * 64;
    coeffs[offset] = 256 + block * 17;
    for (let index = 1; index < 64; index += 1) {
      const value = ((block + 3) * (index * 37 + 11)) % 61;
      coeffs[offset + index] = index % 3 === 0 ? -value : value;
    }
  }
  return coeffs;
}

function idctBlocksTypescript(coeffs, blockCount, bitDepth) {
  const output = new Uint16Array(blockCount * 64);
  const scratch = new Float64Array(64);
  const max = (1 << bitDepth) - 1;

  for (let block = 0; block < blockCount; block += 1) {
    const blockOffset = block * 64;
    for (let v = 0; v < 8; v += 1) {
      const rowOffset = blockOffset + v * 8;
      for (let x = 0; x < 8; x += 1) {
        let sum = 0;
        for (let u = 0; u < 8; u += 1) {
          sum += coeffs[rowOffset + u] * IDCT_BASIS[x][u];
        }
        scratch[v * 8 + x] = sum;
      }
    }

    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        let sum = 0;
        for (let v = 0; v < 8; v += 1) {
          sum += scratch[v * 8 + x] * IDCT_BASIS[y][v];
        }
        output[blockOffset + y * 8 + x] = Math.min(max, Math.max(0, Math.round(sum / 4)));
      }
    }
  }

  return output;
}
