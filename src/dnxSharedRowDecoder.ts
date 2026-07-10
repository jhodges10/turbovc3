import type { DnxFrameHeader } from "./dnxFrame";
import {
  createDnxFrameLayout,
  dnxFrameByteLength,
  parseDnxRowSpans,
  type DnxFrameLayout
} from "./dnxReconstruction";
import type {
  DnxSharedRowWorkerRequest,
  DnxSharedRowWorkerResponse
} from "./dnxSharedRowWorkerProtocol";

interface WorkerSlot {
  worker: Worker;
  failed: boolean;
}

interface PendingRow {
  resolve(): void;
  reject(error: Error): void;
}

export class DnxSharedRowDecoder {
  readonly mode = "shared-row-workers/zig-wasm-row";
  readonly concurrency: number;
  private readonly pendingRows = new Map<number, PendingRow>();
  private nextRequestId = 1;
  private queueSize = 0;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private dequeuedResolve: (() => void) | null = null;
  private dequeuedPromise = new Promise<void>((resolve) => {
    this.dequeuedResolve = resolve;
  });

  private constructor(private readonly slots: WorkerSlot[]) {
    this.concurrency = slots.length;
  }

  static async create(concurrency: number): Promise<DnxSharedRowDecoder> {
    const slots = Array.from({ length: Math.max(1, concurrency) }, () => ({
      worker: new Worker(new URL("./workers/dnxSharedRowDecode.worker.js", import.meta.url), { type: "module" }),
      failed: false
    }));
    const pool = new DnxSharedRowDecoder(slots);
    try {
      await Promise.all(slots.map((slot) => pool.initializeSlot(slot)));
      return pool;
    } catch (error) {
      pool.destroy();
      throw error;
    }
  }

  get decodeQueueSize(): number {
    return this.queueSize;
  }

  get desiredSize(): number {
    return this.closed ? 0 : 1 - this.queueSize;
  }

  get dequeued(): Promise<void> {
    return this.dequeuedPromise;
  }

  decode(packet: Uint8Array, header: DnxFrameHeader): Promise<DnxFrameLayout> {
    if (this.closed) {
      return Promise.reject(new Error("DNx shared row decoder is closed."));
    }

    this.queueSize += 1;
    const preceding = this.tail;
    let releaseTail!: () => void;
    this.tail = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });

    return preceding
      .then(() => this.decodeNow(packet, header))
      .finally(() => {
        this.queueSize -= 1;
        releaseTail();
        this.signalDequeued();
      });
  }

  destroy(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new Error("DNx shared row decoder was closed during decode.");
    for (const pending of this.pendingRows.values()) {
      pending.reject(error);
    }
    this.pendingRows.clear();
    for (const slot of this.slots) {
      const request: DnxSharedRowWorkerRequest = { type: "close" };
      try {
        slot.worker.postMessage(request);
      } catch {
        // An initialization failure can leave the worker's message port
        // disconnected. It still needs to be terminated along with its peers.
      } finally {
        slot.worker.terminate();
      }
    }
    this.queueSize = 0;
    this.signalDequeued();
  }

  private async decodeNow(packet: Uint8Array, header: DnxFrameHeader): Promise<DnxFrameLayout> {
    if (this.closed) {
      throw new Error("DNx shared row decoder is closed.");
    }
    const availableSlots = this.slots.filter((slot) => !slot.failed);
    if (availableSlots.length === 0) {
      throw new Error("No DNx shared row workers are available.");
    }

    const rows = parseDnxRowSpans(packet, header);
    const packetBuffer = new SharedArrayBuffer(packet.byteLength);
    new Uint8Array(packetBuffer).set(packet);
    const frameBuffer = new SharedArrayBuffer(dnxFrameByteLength(header));
    const layout = createDnxFrameLayout(header, frameBuffer);

    await Promise.all(rows.map((row, index) => {
      const slot = availableSlots[index % availableSlots.length];
      const requestId = this.nextRequestId++;
      return new Promise<void>((resolve, reject) => {
        this.pendingRows.set(requestId, { resolve, reject });
        const request: DnxSharedRowWorkerRequest = {
          type: "decode-row",
          requestId,
          packet: packetBuffer,
          frame: frameBuffer,
          rowStart: row.start,
          rowEnd: row.end,
          row: row.row,
          header
        };
        try {
          slot.worker.postMessage(request);
        } catch (error) {
          this.pendingRows.delete(requestId);
          reject(toError(error, "Failed to schedule a DNx row decode."));
        }
      });
    }));

    return layout;
  }

  private initializeSlot(slot: WorkerSlot): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onReady = (event: MessageEvent<DnxSharedRowWorkerResponse>) => {
        if (event.data.type === "ready") {
          cleanup();
          resolve();
        } else if (event.data.type === "error" && event.data.requestId === undefined) {
          cleanup();
          reject(new Error(event.data.message));
        }
      };
      const onInitialError = (event: ErrorEvent) => {
        cleanup();
        reject(new Error(event.message || "DNx shared row worker initialization failed."));
      };
      const cleanup = () => {
        slot.worker.removeEventListener("message", onReady);
        slot.worker.removeEventListener("error", onInitialError);
      };
      slot.worker.addEventListener("message", onReady);
      slot.worker.addEventListener("error", onInitialError);
      slot.worker.addEventListener("message", (event: MessageEvent<DnxSharedRowWorkerResponse>) => {
        this.handleResponse(event.data);
      });
      slot.worker.addEventListener("error", (event) => {
        this.failSlot(slot, new Error(event.message || "DNx shared row worker failed."));
      });
      const request: DnxSharedRowWorkerRequest = { type: "init" };
      slot.worker.postMessage(request);
    });
  }

  private handleResponse(response: DnxSharedRowWorkerResponse): void {
    if (response.type === "ready" || response.requestId === undefined) {
      return;
    }
    const pending = this.pendingRows.get(response.requestId);
    if (!pending) {
      return;
    }
    this.pendingRows.delete(response.requestId);
    if (response.type === "decoded-row") {
      pending.resolve();
    } else {
      pending.reject(new Error(response.message));
    }
  }

  private failSlot(slot: WorkerSlot, error: Error): void {
    if (slot.failed) {
      return;
    }
    slot.failed = true;
    slot.worker.terminate();
    for (const pending of this.pendingRows.values()) {
      pending.reject(error);
    }
    this.pendingRows.clear();
  }

  private signalDequeued(): void {
    this.dequeuedResolve?.();
    this.dequeuedPromise = new Promise<void>((resolve) => {
      this.dequeuedResolve = resolve;
    });
  }
}

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
