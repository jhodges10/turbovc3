#!/usr/bin/env node
import assert from "node:assert/strict";
import { open, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repoRoot, "samples/wip_gallery_page_1920x1080_60fps.mxf");
const committedMxfFixture = path.join(repoRoot, "tests/fixtures/dnxhr-lb-op1a-pcm.mxf");
const module = await loadDecoderModule();

const decoder = await module.Decoder.create({
  dnxFourCc: "AVdh",
  useSharedMemory: false,
  concurrency: 0,
  allowedOutputFormats: ["yuv420p8"]
});
assert.equal(decoder instanceof Error, false);

const shortFrame = new module.Frame();
assert.equal(shortFrame.isFilled, false);
assert.equal(shortFrame.toFilled(), null);
const eof = await decoder.decode(new Uint8Array(100), shortFrame);
assert.equal(eof.name, "DnxUnexpectedEofError");
assert.equal(shortFrame.isLocked, false);

const lockedFrame = new module.Frame();
assert.equal(lockedFrame.acquireLock(), true);
const locked = await decoder.decode(new Uint8Array(100), lockedFrame);
assert.equal(locked.name, "DnxFrameLockedError");
assert.throws(() => lockedFrame.clear(), { name: "DnxFrameLockedError" });
lockedFrame.releaseLock();

if (existsSync(fixture)) {
  const prefix = await readPrefix(fixture, 8 * 1024 * 1024);
  const packet = module.findDnxFramePackets(prefix, { maxFrames: 1 })[0];
  assert.ok(packet);
  const frame = new module.Frame();
  const decoded = await decoder.decode(packet.bytes, frame);
  assert.equal(decoded instanceof Error, false);
  assert.equal(decoded.pixelFormat, "yuv420p8");
  assert.equal(decoded.originalPixelFormat, "yuv422p8");
  assert.equal(decoded.layout.chromaWidth, 960);
  assert.equal(decoded.layout.chromaHeight, 544);
  assert.equal(frame.isLocked, false);
  frame.clear();
}

await decoder.close();
const closed = await decoder.decode(new Uint8Array(100), new module.Frame());
assert.equal(closed.name, "DnxDecoderClosedError");

const randomAccessDecoder = await module.DnxRandomAccessDecoder.create(
  new Blob([await readFile(committedMxfFixture)]),
  { concurrency: 0 }
);
assert.equal(randomAccessDecoder instanceof Error, false);
assert.equal(randomAccessDecoder.frameCount, 1);
const randomAccessFrame = await randomAccessDecoder.decode(0);
assert.equal(randomAccessFrame instanceof Error, false);
assert.equal(randomAccessFrame.index, 0);
assert.equal(randomAccessFrame.width, 1280);
assert.equal(randomAccessFrame.height, 720);
const bytesReadAfterDecode = randomAccessDecoder.sourceBytesRead;
const cachedRandomAccessFrame = await randomAccessDecoder.decode(0);
assert.equal(cachedRandomAccessFrame instanceof Error, false);
assert.equal(randomAccessDecoder.sourceBytesRead, bytesReadAfterDecode);
assert.equal(randomAccessDecoder.cachedPacketCount, 1);
const abortedDecode = new AbortController();
abortedDecode.abort();
const abortedDecodeResult = await randomAccessDecoder.decode(0, { signal: abortedDecode.signal });
assert.equal(abortedDecodeResult.name, "AbortError");
await randomAccessDecoder.close();

const abortedOpen = new AbortController();
abortedOpen.abort();
await assert.rejects(
  module.DnxRandomAccessDecoder.create(new Blob([await readFile(committedMxfFixture)]), {
    signal: abortedOpen.signal
  }),
  { name: "AbortError" }
);

const seekBytes = new Uint8Array(await readFile(committedMxfFixture));
let delayPacketReads = false;
const slowSource = {
  size: seekBytes.byteLength,
  async read(offset, length) {
    if (delayPacketReads && length > 64 * 1024) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return seekBytes.subarray(offset, offset + length);
  }
};
const seekingDecoder = await module.DnxRandomAccessDecoder.create(slowSource, {
  concurrency: 0,
  packetCacheSize: 0
});
assert.equal(seekingDecoder instanceof Error, false);
delayPacketReads = true;
const supersededSeek = seekingDecoder.seek(0);
await new Promise((resolve) => setTimeout(resolve, 0));
const latestSeek = seekingDecoder.seek(0);
assert.equal((await supersededSeek).name, "AbortError");
assert.equal((await latestSeek) instanceof Error, false);

const inFlightDecode = seekingDecoder.decode(0, { prefetch: false });
let closeSettled = false;
const seekingClose = seekingDecoder.close().then(() => {
  closeSettled = true;
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(closeSettled, false);
assert.equal((await inFlightDecode) instanceof Error, false);
await seekingClose;
assert.equal(closeSettled, true);

const mxf = await module.demuxDnxMxf(new Uint8Array(await readFile(committedMxfFixture)));
assert.ok(mxf);
const packetBytes = await mxf.demuxer.readPacket(mxf.packets[0]);
const malformedDecoder = await module.Decoder.create({
  dnxFourCc: "AVdh",
  useSharedMemory: false,
  concurrency: 0
});
assert.equal(malformedDecoder instanceof Error, false);
for (const truncatedLength of [0, 1, 639, 640, Math.floor(packetBytes.byteLength / 2)]) {
  const frame = new module.Frame();
  const result = await malformedDecoder.decode(packetBytes.subarray(0, truncatedLength), frame);
  assert.equal(result.name, "DnxUnexpectedEofError", `truncation at ${truncatedLength}`);
  assert.equal(frame.isLocked, false);
  assert.equal(frame.isFilled, false);
}
const invalidPrefixPacket = packetBytes.slice();
invalidPrefixPacket[0] ^= 0xff;
const invalidPrefixFrame = new module.Frame();
const invalidPrefix = await malformedDecoder.decode(invalidPrefixPacket, invalidPrefixFrame);
assert.equal(invalidPrefix.name, "DnxInvalidDataError");
assert.equal(invalidPrefixFrame.isLocked, false);

const invalidRowsPacket = packetBytes.slice();
invalidRowsPacket.fill(0xff, 0x170, 0x178);
const invalidRowsFrame = new module.Frame();
const invalidRows = await malformedDecoder.decode(invalidRowsPacket, invalidRowsFrame);
assert.equal(invalidRows instanceof Error, true);
assert.equal(invalidRowsFrame.isLocked, false);
assert.equal(invalidRowsFrame.isFilled, false);
await malformedDecoder.close();

const schedulingModule = await loadDecoderModule({ simulatePacketScheduling: true });
const schedulingDecoder = await schedulingModule.Decoder.create({
  dnxFourCc: "AVdh",
  useSharedMemory: false,
  concurrency: 2
});
assert.equal(schedulingDecoder instanceof Error, false);
const settlementOrder = [];
const queued = [1, 2, 3].map((index) =>
  schedulingDecoder.decode(packetBytes, new schedulingModule.Frame()).then((result) => {
    settlementOrder.push(index);
    return result;
  })
);
assert.equal(schedulingDecoder.decodeQueueSize, 3);
assert.equal(schedulingDecoder.desiredSize, 1);
const dequeued = schedulingDecoder.dequeued;
const closePromise = schedulingDecoder.close();
assert.equal(schedulingDecoder.isClosed, true);
assert.equal(schedulingDecoder.desiredSize, 0);
assert.equal(schedulingModule.fakeWorkerStats().packetTerminated, 0);
const rejectedAfterClose = await schedulingDecoder.decode(packetBytes, new schedulingModule.Frame());
assert.equal(rejectedAfterClose.name, "DnxDecoderClosedError");
await dequeued;
const scheduledResults = await Promise.all(queued);
assert.equal(scheduledResults.every((result) => !(result instanceof Error)), true);
assert.deepEqual(settlementOrder, [1, 2, 3]);
assert.equal(scheduledResults[0].isFilled, true);
assert.equal(scheduledResults[0].toFilled(), scheduledResults[0]);
assert.deepEqual(scheduledResults[0].pixelAspectRatio, { num: 1, den: 1 });
assert.equal(scheduledResults[0].colorRangeFull, false);
assert.equal(scheduledResults[0].scanType, "progressive");
scheduledResults[0].clear();
assert.equal(scheduledResults[0].isFilled, false);
await closePromise;
assert.equal(schedulingDecoder.decodeQueueSize, 0);
assert.equal(schedulingModule.fakeWorkerStats().packetTerminated, 2);

const transferDecoder = await schedulingModule.Decoder.create({
  dnxFourCc: "AVdh",
  useSharedMemory: false,
  concurrency: 1
});
assert.equal(transferDecoder instanceof Error, false);
const transferablePacket = packetBytes.slice();
const reusableFrame = new schedulingModule.Frame();
const transferredDecode = transferDecoder.decode(transferablePacket, reusableFrame, { transfer: true });
assert.equal(transferablePacket.byteLength, 0);
assert.equal(reusableFrame.isLocked, true);
const lockedReuse = await transferDecoder.decode(packetBytes, reusableFrame);
assert.equal(lockedReuse.name, "DnxFrameLockedError");
assert.equal((await transferredDecode) instanceof Error, false);
assert.equal(reusableFrame.isLocked, false);
assert.equal(reusableFrame.isFilled, true);
reusableFrame.clear();
assert.equal(reusableFrame.isFilled, false);
await transferDecoder.close();
assert.equal(schedulingModule.fakeWorkerStats().packetTerminated, 3);

const fallbackModule = await loadDecoderModule({ simulateSharedWorkerFailure: true });
const fallbackDecoder = await fallbackModule.Decoder.create({
  dnxFourCc: "AVdh",
  useSharedMemory: true,
  concurrency: 2
});
assert.equal(fallbackDecoder instanceof Error, false);
assert.equal(fallbackDecoder.useSharedMemory, false);
assert.equal(fallbackDecoder.idctMode, "worker-pool/fake-packet-worker");
assert.deepEqual(fallbackModule.fakeWorkerStats(), {
  sharedCreated: 2,
  sharedTerminated: 2,
  packetCreated: 2,
  packetTerminated: 0
});
await fallbackDecoder.close();
assert.equal(fallbackModule.fakeWorkerStats().packetTerminated, 2);

const sharedSchedulingModule = await loadDecoderModule({ simulateSharedScheduling: true });
const sharedSchedulingDecoder = await sharedSchedulingModule.Decoder.create({
  dnxFourCc: "AVdh",
  useSharedMemory: true,
  concurrency: 2
});
assert.equal(sharedSchedulingDecoder instanceof Error, false);
const sharedReusableFrame = new sharedSchedulingModule.Frame();
assert.equal(
  (await sharedSchedulingDecoder.decode(packetBytes, sharedReusableFrame)) instanceof Error,
  false
);
assert.equal(
  (await sharedSchedulingDecoder.decode(packetBytes, sharedReusableFrame)) instanceof Error,
  false
);
assert.deepEqual(sharedSchedulingModule.fakeWorkerStats(), {
  sharedCreated: 2,
  sharedTerminated: 0,
  packetBuffers: 1,
  frameBuffers: 1
});
assert.equal(
  (await sharedSchedulingDecoder.decode(packetBytes, new sharedSchedulingModule.Frame())) instanceof Error,
  false
);
assert.equal(sharedSchedulingModule.fakeWorkerStats().packetBuffers, 1);
assert.equal(sharedSchedulingModule.fakeWorkerStats().frameBuffers, 2);
sharedReusableFrame.clear();
assert.equal(
  (await sharedSchedulingDecoder.decode(packetBytes, sharedReusableFrame)) instanceof Error,
  false
);
assert.equal(sharedSchedulingModule.fakeWorkerStats().packetBuffers, 1);
assert.equal(sharedSchedulingModule.fakeWorkerStats().frameBuffers, 3);
await sharedSchedulingDecoder.close();
assert.equal(sharedSchedulingModule.fakeWorkerStats().sharedTerminated, 2);
console.log("DNx decoder error and frame contract passed.");

async function loadDecoderModule({
  simulateSharedWorkerFailure = false,
  simulatePacketScheduling = false,
  simulateSharedScheduling = false
} = {}) {
  const decoderModule = JSON.stringify(path.join(repoRoot, "src/dnxDecoder.ts"));
  const frameModule = JSON.stringify(path.join(repoRoot, "src/dnxFrame.ts"));
  const randomAccessModule = JSON.stringify(path.join(repoRoot, "src/dnxRandomAccessDecoder.ts"));
  const workerHarness = simulateSharedScheduling ? `
    const workerStats = {
      sharedCreated: 0,
      sharedTerminated: 0
    };
    const packetBuffers = new Set();
    const frameBuffers = new Set();

    class FakeWorker {
      listeners = new Map();

      constructor() {
        workerStats.sharedCreated += 1;
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
      }

      postMessage(request) {
        if (request.type === "init") {
          this.dispatch("message", { data: { type: "ready", mode: "fake-shared-row" } });
          return;
        }
        if (request.type === "decode-row") {
          packetBuffers.add(request.packet);
          frameBuffers.add(request.frame);
          this.dispatch("message", {
            data: { type: "decoded-row", requestId: request.requestId }
          });
        }
      }

      terminate() {
        workerStats.sharedTerminated += 1;
      }

      dispatch(type, event) {
        for (const listener of [...(this.listeners.get(type) ?? [])]) {
          listener(event);
        }
      }
    }

    globalThis.Worker = FakeWorker;
    Object.defineProperty(globalThis, "crossOriginIsolated", {
      configurable: true,
      value: true
    });
    export const fakeWorkerStats = () => ({
      ...workerStats,
      packetBuffers: packetBuffers.size,
      frameBuffers: frameBuffers.size
    });
  ` : simulateSharedWorkerFailure ? `
    const workerStats = {
      sharedCreated: 0,
      sharedTerminated: 0,
      packetCreated: 0,
      packetTerminated: 0
    };

    class FakeWorker {
      listeners = new Map();
      kind = null;

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
      }

      postMessage(request, transfer = []) {
        if (transfer.length > 0) {
          request = structuredClone(request, { transfer });
        }
        if (request.type === "init") {
          this.kind = "dnxFourCc" in request ? "packet" : "shared";
          workerStats[this.kind + "Created"] += 1;
          this.dispatch("message", {
            data: this.kind === "shared"
              ? { type: "error", message: "simulated shared worker initialization failure" }
              : { type: "ready", mode: "fake-packet-worker" }
          });
        }
      }

      terminate() {
        if (this.kind) {
          workerStats[this.kind + "Terminated"] += 1;
        }
      }

      dispatch(type, event) {
        for (const listener of [...(this.listeners.get(type) ?? [])]) {
          listener(event);
        }
      }
    }

    globalThis.Worker = FakeWorker;
    Object.defineProperty(globalThis, "crossOriginIsolated", {
      configurable: true,
      value: true
    });
    export const fakeWorkerStats = () => ({ ...workerStats });
  ` : simulatePacketScheduling ? `
    const workerStats = {
      packetCreated: 0,
      packetTerminated: 0
    };

    class FakeWorker {
      listeners = new Map();

      constructor() {
        workerStats.packetCreated += 1;
      }

      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      removeEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
      }

      postMessage(request, transfer = []) {
        if (transfer.length > 0) {
          request = structuredClone(request, { transfer });
        }
        if (request.type === "init") {
          this.dispatch("message", { data: { type: "ready", mode: "scheduled-fake-worker" } });
          return;
        }
        if (request.type !== "decode") {
          return;
        }
        const delays = [30, 0, 5];
        setTimeout(() => {
          const bytes = new Uint8Array([request.requestId]);
          this.dispatch("message", {
            data: {
              type: "decoded",
              requestId: request.requestId,
              mode: "scheduled-fake-worker",
              frame: {
                codedWidth: 1,
                codedHeight: 1,
                visibleWidth: 1,
                visibleHeight: 1,
                pixelFormat: "yuv422p8",
                originalPixelFormat: "yuv422p8",
                colorSpace: "bt709",
                header: {},
                layout: { planes: [{ bytes }] }
              }
            }
          });
        }, delays[request.requestId - 1] ?? 0);
      }

      terminate() {
        workerStats.packetTerminated += 1;
      }

      dispatch(type, event) {
        for (const listener of [...(this.listeners.get(type) ?? [])]) {
          listener(event);
        }
      }
    }

    globalThis.Worker = FakeWorker;
    export const fakeWorkerStats = () => ({ ...workerStats });
  ` : "";
  const result = await build({
    stdin: {
      contents: `
        ${workerHarness}
        export { Decoder, Frame } from ${decoderModule};
        export { findDnxFramePackets } from ${frameModule};
        export { DnxRandomAccessDecoder } from ${randomAccessModule};
        export { demuxDnxMxf } from ${JSON.stringify(path.join(repoRoot, "src/dnxMxf.ts"))};
      `,
      resolveDir: repoRoot,
      sourcefile: "dnx-decoder-contract-entry.ts"
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    define: simulateSharedWorkerFailure || simulatePacketScheduling || simulateSharedScheduling
      ? { "import.meta.url": JSON.stringify("file:///fake/dnx-decoder-contract-entry.js") }
      : undefined,
    write: false
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

async function readPrefix(filePath, byteLength) {
  const handle = await open(filePath, "r");
  try {
    const buffer = new Uint8Array(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
