import type { DecodeOptions, FilledFrame, Frame, DecoderOptions } from "./dnxDecoder";
import type {
  DnxPacketWorkerRequest,
  DnxPacketWorkerResponse,
  DnxWorkerFrameContents
} from "./dnxDecoderWorkerProtocol";

interface WorkerSlot {
  worker: Worker;
  load: number;
  failed: boolean;
}

interface PendingDecode {
  slot: WorkerSlot;
  frame: Frame;
  resolve(frame: FilledFrame): void;
  reject(error: Error): void;
}

export class DnxDecoderWorkerPool {
  readonly concurrency: number;
  private readonly slots: WorkerSlot[];
  private readonly pending = new Map<number, PendingDecode>();
  private nextRequestId = 1;
  private queueSize = 0;
  private closed = false;
  private dequeuedResolve: (() => void) | null = null;
  private dequeuedPromise = new Promise<void>((resolve) => {
    this.dequeuedResolve = resolve;
  });
  private currentMode = "worker-pool/initializing";

  private constructor(slots: WorkerSlot[]) {
    this.slots = slots;
    this.concurrency = slots.length;
  }

  static async create(options: Required<DecoderOptions>): Promise<DnxDecoderWorkerPool> {
    const slots = Array.from({ length: options.concurrency }, () => ({
      worker: new Worker(new URL("./workers/dnxPacketDecode.worker.ts", import.meta.url), { type: "module" }),
      load: 0,
      failed: false
    }));
    const pool = new DnxDecoderWorkerPool(slots);
    try {
      await Promise.all(slots.map((slot) => pool.initializeSlot(slot, options)));
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
    const availableWorkers = this.slots.filter((slot) => !slot.failed).length;
    return this.closed ? 0 : availableWorkers * 2 - this.queueSize;
  }

  get dequeued(): Promise<void> {
    return this.dequeuedPromise;
  }

  get mode(): string {
    return this.currentMode;
  }

  decode(packetData: Uint8Array, frame: Frame, options: DecodeOptions): Promise<FilledFrame> {
    if (this.closed) {
      return Promise.reject(new Error("DNx decoder worker pool is closed."));
    }

    const availableSlots = this.slots.filter((slot) => !slot.failed);
    if (availableSlots.length === 0) {
      return Promise.reject(new Error("No DNx packet workers are available."));
    }

    const slot = availableSlots.reduce((best, candidate) =>
      candidate.load < best.load ? candidate : best
    );
    const packet = transferablePacket(packetData, options.transfer === true);
    const requestId = this.nextRequestId++;
    slot.load += 1;
    this.queueSize += 1;

    return new Promise<FilledFrame>((resolve, reject) => {
      this.pending.set(requestId, { slot, frame, resolve, reject });
      const request: DnxPacketWorkerRequest = {
        type: "decode",
        requestId,
        packet: packet.buffer
      };
      try {
        slot.worker.postMessage(request, [packet.buffer]);
      } catch (error) {
        this.failSlot(slot, toError(error, "Failed to send a DNx packet to its worker."));
      }
    });
  }

  destroy(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const error = new Error("DNx decoder worker pool was closed during decode.");
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const slot of this.slots) {
      const request: DnxPacketWorkerRequest = { type: "close" };
      try {
        slot.worker.postMessage(request);
      } catch {
        // A failed worker may already have terminated.
      } finally {
        slot.worker.terminate();
      }
    }
    this.queueSize = 0;
    this.signalDequeued();
  }

  private initializeSlot(slot: WorkerSlot, options: Required<DecoderOptions>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent<DnxPacketWorkerResponse>) => {
        if (event.data.type === "ready") {
          this.currentMode = `worker-pool/${event.data.mode}`;
          resolve();
        } else if (event.data.type === "error" && event.data.requestId === undefined) {
          reject(new Error(event.data.message));
        } else {
          return;
        }
        slot.worker.removeEventListener("message", onMessage);
        slot.worker.removeEventListener("error", onError);
      };
      const onError = (event: ErrorEvent) => {
        reject(new Error(event.message || "DNx packet worker initialization failed."));
        slot.worker.removeEventListener("message", onMessage);
        slot.worker.removeEventListener("error", onError);
      };
      slot.worker.addEventListener("message", onMessage);
      slot.worker.addEventListener("error", onError);
      slot.worker.addEventListener("message", (event: MessageEvent<DnxPacketWorkerResponse>) => {
        this.handleResponse(event.data);
      });
      slot.worker.addEventListener("error", (event) => {
        this.failSlot(slot, new Error(event.message || "DNx packet worker failed."));
      });
      const request: DnxPacketWorkerRequest = {
        type: "init",
        dnxFourCc: options.dnxFourCc,
        allowedOutputFormats: options.allowedOutputFormats
      };
      slot.worker.postMessage(request);
    });
  }

  private handleResponse(response: DnxPacketWorkerResponse): void {
    if (response.type === "ready") {
      return;
    }
    if (response.requestId === undefined) {
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      return;
    }

    this.pending.delete(response.requestId);
    pending.slot.load -= 1;
    this.queueSize -= 1;
    if (response.type === "decoded") {
      this.currentMode = `worker-pool/${response.mode}`;
      populateFrame(pending.frame, response.frame);
      pending.resolve(pending.frame as FilledFrame);
    } else {
      pending.reject(new Error(response.message));
    }
    this.signalDequeued();
  }

  private failSlot(slot: WorkerSlot, error: Error): void {
    if (slot.failed) {
      return;
    }
    slot.failed = true;
    slot.worker.terminate();
    for (const [requestId, pending] of this.pending) {
      if (pending.slot !== slot) {
        continue;
      }
      this.pending.delete(requestId);
      this.queueSize -= 1;
      pending.reject(error);
    }
    slot.load = 0;
    this.signalDequeued();
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

function transferablePacket(packetData: Uint8Array, transfer: boolean): Uint8Array<ArrayBuffer> {
  if (
    transfer &&
    packetData.buffer instanceof ArrayBuffer &&
    packetData.byteOffset === 0 &&
    packetData.byteLength === packetData.buffer.byteLength
  ) {
    return packetData as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(packetData);
}

function populateFrame(frame: Frame, contents: DnxWorkerFrameContents): void {
  frame.codedWidth = contents.codedWidth;
  frame.codedHeight = contents.codedHeight;
  frame.visibleWidth = contents.visibleWidth;
  frame.visibleHeight = contents.visibleHeight;
  frame.pixelFormat = contents.pixelFormat;
  frame.originalPixelFormat = contents.originalPixelFormat;
  frame.colorSpace = contents.colorSpace;
  frame.header = contents.header;
  frame.layout = contents.layout;
  frame.frameData = contents.layout.planes[0].bytes;
}
