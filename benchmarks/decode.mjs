#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Decoder, DnxRandomAccessDecoder, Frame, findDnxFramePackets } from "../dist/index.js";
import { createNodeDecoder } from "../dist/node.js";
import { parseDnxFrameHeader } from "../dist/dnxFrame.js";
import { createDnxWasmIdctKernel } from "../dist/dnxIdctKernel.js";
import { decodeDnxScalarFrame } from "../dist/dnxScalarDecoder.js";
import { createDnxWasmRowDecoder } from "../dist/dnxZigRowDecoder.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iterations = integerArgument("--iterations", 12);
const packetBytes = new Uint8Array(
  await readFile(path.join(repoRoot, "tests/fixtures/oracle_dnxhr_lb_1080p30_8bit_cid1274.mov"))
);
const packet = findDnxFramePackets(packetBytes, { maxFrames: 1 })[0]?.bytes;
if (!packet) {
  throw new Error("Benchmark fixture contains no complete DNx frame.");
}

const startedAt = new Date().toISOString();
const memoryBefore = process.memoryUsage().rss;
const synchronous = await benchmarkSynchronous(packet, iterations);
const native = await benchmarkNative(packet, iterations);
const workers = [];
for (const concurrency of [1, 2, 4]) {
  workers.push(await benchmarkWorkers(packet, iterations, concurrency));
}
const teardown = await benchmarkTeardown(packet);
const seek = await benchmarkSeek();
const result = {
  schemaVersion: 1,
  startedAt,
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: globalThis.navigator?.hardwareConcurrency ?? null
  },
  fixture: {
    name: "oracle_dnxhr_lb_1080p30_8bit_cid1274.mov",
    packetBytes: packet.byteLength,
    width: 1920,
    height: 1080
  },
  iterations,
  synchronous,
  native,
  workers,
  teardown,
  seek,
  memory: {
    rssBeforeBytes: memoryBefore,
    rssAfterBytes: process.memoryUsage().rss
  }
};

console.log(JSON.stringify(result, null, process.argv.includes("--compact") ? 0 : 2));

async function benchmarkSynchronous(encoded, count) {
  const decoder = await Decoder.create({ dnxFourCc: "AVdh", useSharedMemory: false, concurrency: 0 });
  if (decoder instanceof Error) throw decoder;
  const frame = new Frame();
  try {
    const warmup = await decoder.decode(encoded, frame);
    if (warmup instanceof Error) throw warmup;
    const allocation = warmup.layout.planes.map((plane) => plane.bytes.buffer);
    const samples = [];
    for (let index = 0; index < count; index += 1) {
      const start = performance.now();
      const decoded = await decoder.decode(encoded, frame);
      samples.push(performance.now() - start);
      if (decoded instanceof Error) throw decoded;
      if (!decoded.layout.planes.every((plane, planeIndex) => plane.bytes.buffer === allocation[planeIndex])) {
        throw new Error("Synchronous decode did not reuse the output frame allocation.");
      }
    }
    return summarize("synchronous", decoder.idctMode, samples, count);
  } finally {
    await decoder.close();
  }
}

async function benchmarkNative(encoded, count) {
  const header = parseDnxFrameHeader(encoded);
  if (!header) throw new Error("Benchmark packet has no DNx header.");
  const idctPath = path.join(repoRoot, "wasm/generated/dnx_idct_kernel.wasm");
  const zigPath = path.join(repoRoot, "wasm/generated/dnx_row_decoder.wasm");
  if (process.env.REQUIRE_NATIVE_BENCH === "1" && (!existsSync(idctPath) || !existsSync(zigPath))) {
    throw new Error("REQUIRE_NATIVE_BENCH=1 requires both generated WASM backends.");
  }
  const results = [];
  if (existsSync(idctPath)) {
    const kernel = await createDnxWasmIdctKernel(await readFile(idctPath));
    try {
      results.push(benchmarkScalarMode("wasm-idct", count, () => {
        decodeDnxScalarFrame(encoded, header, kernel);
      }));
    } finally {
      kernel.destroy();
    }
  }
  if (existsSync(zigPath)) {
    const rowDecoder = await createDnxWasmRowDecoder(await readFile(zigPath));
    try {
      results.push(benchmarkScalarMode("zig-wasm-frame", count, () => {
        decodeDnxScalarFrame(encoded, header, undefined, rowDecoder);
      }));
    } finally {
      rowDecoder.destroy();
    }
  }
  return results;
}

function benchmarkScalarMode(mode, count, decode) {
  decode();
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const start = performance.now();
    decode();
    samples.push(performance.now() - start);
  }
  return summarize(mode, mode, samples, count);
}

async function benchmarkWorkers(encoded, count, concurrency) {
  const decoder = await createNodeDecoder({
    dnxFourCc: "AVdh",
    useSharedMemory: false,
    concurrency
  });
  if (decoder instanceof Error) throw decoder;
  try {
    const warmup = await decoder.decode(encoded, new Frame());
    if (warmup instanceof Error) throw warmup;
    const samples = [];
    for (let offset = 0; offset < count; offset += concurrency) {
      const batchSize = Math.min(concurrency, count - offset);
      const start = performance.now();
      const decoded = await Promise.all(
        Array.from({ length: batchSize }, () => decoder.decode(encoded, new Frame()))
      );
      const elapsed = performance.now() - start;
      for (const frame of decoded) {
        if (frame instanceof Error) throw frame;
      }
      for (let index = 0; index < batchSize; index += 1) samples.push(elapsed / batchSize);
    }
    return summarize(`workers-${concurrency}`, decoder.idctMode, samples, count);
  } finally {
    await decoder.close();
  }
}

async function benchmarkTeardown(encoded) {
  const decoder = await createNodeDecoder({ dnxFourCc: "AVdh", useSharedMemory: false, concurrency: 2 });
  if (decoder instanceof Error) throw decoder;
  const accepted = Array.from({ length: 4 }, () => decoder.decode(encoded, new Frame()));
  const start = performance.now();
  await decoder.close();
  const results = await Promise.all(accepted);
  if (results.some((value) => value instanceof Error)) {
    throw new Error("Decoder teardown failed to drain accepted work.");
  }
  return { accepted: accepted.length, drained: results.length, closeMs: round(performance.now() - start) };
}

async function benchmarkSeek() {
  const bytes = new Uint8Array(await readFile(path.join(repoRoot, "tests/fixtures/dnxhr-lb-opatom.mxf")));
  let bytesRead = 0;
  const source = {
    size: bytes.byteLength,
    async read(offset, length) {
      bytesRead += length;
      return bytes.subarray(offset, offset + length);
    }
  };
  const openStart = performance.now();
  const decoder = await DnxRandomAccessDecoder.create(source, {
    concurrency: 0,
    packetCacheSize: 2,
    prefetchFrames: 0
  });
  if (decoder instanceof Error) throw decoder;
  const openMs = performance.now() - openStart;
  const bytesAfterOpen = bytesRead;
  try {
    const coldStart = performance.now();
    const cold = await decoder.seek(0, { prefetch: false });
    const coldMs = performance.now() - coldStart;
    if (cold instanceof Error) throw cold;
    const bytesAfterCold = bytesRead;
    const warmSamples = [];
    for (let index = 0; index < 3; index += 1) {
      const start = performance.now();
      const warm = await decoder.seek(0, { prefetch: false });
      warmSamples.push(performance.now() - start);
      if (warm instanceof Error) throw warm;
    }
    if (bytesRead !== bytesAfterCold) {
      throw new Error("Warm seek reread a packet that should be held in the bounded cache.");
    }
    return {
      openMs: round(openMs),
      coldMs: round(coldMs),
      warmP50Ms: round(percentile(warmSamples, 0.5)),
      warmP95Ms: round(percentile(warmSamples, 0.95)),
      bytesReadOnOpen: bytesAfterOpen,
      bytesReadOnColdSeek: bytesAfterCold - bytesAfterOpen,
      bytesReadOnWarmSeeks: bytesRead - bytesAfterCold,
      cachedPacketCount: decoder.cachedPacketCount
    };
  } finally {
    await decoder.close();
  }
}

function summarize(name, mode, samples, count) {
  const totalMs = samples.reduce((sum, value) => sum + value, 0);
  return {
    name,
    mode,
    frames: count,
    totalMs: round(totalMs),
    framesPerSecond: round(count * 1000 / totalMs),
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95))
  };
}

function percentile(values, fraction) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function integerArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new RangeError(`${name} must be an integer from 1 through 10000.`);
  }
  return value;
}
