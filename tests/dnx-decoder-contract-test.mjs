#!/usr/bin/env node
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repoRoot, "samples/wip_gallery_page_1920x1080_60fps.mxf");
const module = await loadDecoderModule();

const decoder = await module.Decoder.create({
  dnxFourCc: "AVdh",
  useSharedMemory: false,
  concurrency: 0,
  allowedOutputFormats: ["yuv420p8"]
});
assert.equal(decoder instanceof Error, false);

const shortFrame = new module.Frame();
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
console.log("DNx decoder error and frame contract passed.");

async function loadDecoderModule({ simulateSharedWorkerFailure = false } = {}) {
  const decoderModule = JSON.stringify(path.join(repoRoot, "src/dnxDecoder.ts"));
  const frameModule = JSON.stringify(path.join(repoRoot, "src/dnxFrame.ts"));
  const workerHarness = simulateSharedWorkerFailure ? `
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

      postMessage(request) {
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
  ` : "";
  const result = await build({
    stdin: {
      contents: `
        ${workerHarness}
        export { Decoder, Frame } from ${decoderModule};
        export { findDnxFramePackets } from ${frameModule};
      `,
      resolveDir: repoRoot,
      sourcefile: "dnx-decoder-contract-entry.ts"
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    define: simulateSharedWorkerFailure
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
