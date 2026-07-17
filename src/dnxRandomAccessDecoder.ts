import type { DecodeFrame } from "./core/codec.js";
import {
  Decoder,
  DnxDecoderClosedError,
  DnxInvalidDataError,
  Frame,
  type DnxPixelFormat
} from "./dnxDecoder.js";
import {
  dnxColorSpaceForHeader,
  findDnxFramePackets,
  type DnxFourCc,
  type DnxFramePacket
} from "./dnxFrame.js";
import { demuxDnxMxf, isMxfFile, type DnxMxfEditRate } from "./dnxMxf.js";
import type { MxfDemuxer, MxfPacket, MxfSourceInput } from "./mxf/index.js";
import type { MxfDemuxLimits, MxfDemuxProgress } from "./mxf/index.js";

export interface DnxRandomAccessDecoderOptions {
  concurrency?: number;
  allowedOutputFormats?: readonly DnxPixelFormat[];
  frameDurationUs?: number;
  signal?: AbortSignal;
  packetCacheSize?: number;
  prefetchFrames?: number;
  onIndexProgress?(progress: MxfDemuxProgress): void;
  mxfLimits?: Partial<MxfDemuxLimits>;
}

export interface DnxRandomAccessDecodeOptions {
  signal?: AbortSignal;
  prefetch?: boolean;
}

export class DnxRandomAccessDecoder implements AsyncDisposable {
  readonly frameCount: number;
  readonly dnxFourCc: DnxFourCc;
  readonly editRate: DnxMxfEditRate | null;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly packetCache = new Map<number, Promise<Uint8Array>>();
  private readonly packetCacheSize: number;
  private readonly prefetchFrames: number;
  private seekTail: Promise<void> = Promise.resolve();
  private seekController: AbortController | null = null;
  private prefetchController: AbortController | null = null;

  private constructor(
    private readonly packets: readonly (DnxFramePacket | MxfPacket)[],
    private readonly decoder: Decoder,
    editRate: DnxMxfEditRate | null,
    private readonly frameDurationUs: number,
    private readonly mxfDemuxer: MxfDemuxer | null,
    firstFourCc: DnxFourCc,
    packetCacheSize: number,
    prefetchFrames: number
  ) {
    this.frameCount = packets.length;
    this.dnxFourCc = firstFourCc;
    this.editRate = editRate;
    this.packetCacheSize = packetCacheSize;
    this.prefetchFrames = prefetchFrames;
  }

  static async create(
    input: MxfSourceInput,
    options: DnxRandomAccessDecoderOptions = {}
  ): Promise<Error | DnxRandomAccessDecoder> {
    throwIfAborted(options.signal);
    const isBuffer = input instanceof Uint8Array;
    const bufferIsMxf = isBuffer && isMxfFile(input);
    const mxf = !isBuffer || bufferIsMxf
      ? await demuxDnxMxf(input, {
          signal: options.signal,
          onProgress: options.onIndexProgress,
          limits: options.mxfLimits
        })
      : null;
    throwIfAborted(options.signal);
    const packets = mxf?.packets ?? (isBuffer && !bufferIsMxf ? findDnxFramePackets(input) : []);
    if (packets.length === 0) {
      return new DnxInvalidDataError("No indexed DNx frames were found for random-access decode.");
    }
    const firstHeader = mxf?.firstFrameHeader ?? (packets[0] as DnxFramePacket).header;

    const decoder = await Decoder.create({
      dnxFourCc: firstHeader.fourCc,
      useSharedMemory: Decoder.canUseSharedMemory(),
      concurrency: options.concurrency ?? 1,
      allowedOutputFormats: options.allowedOutputFormats ?? [
        "yuv422p8", "yuv422p10", "yuv422p12", "yuv444p10", "yuv444p12", "gbrp10", "gbrp12"
      ]
    });
    if (decoder instanceof Error) {
      return decoder;
    }

    const editRate = mxf?.editRate ?? null;
    const frameDurationUs = normalizeFrameDuration(options.frameDurationUs, editRate);
    return new DnxRandomAccessDecoder(
      packets,
      decoder,
      editRate,
      frameDurationUs,
      mxf?.demuxer ?? null,
      firstHeader.fourCc,
      normalizeNonNegativeInteger(options.packetCacheSize, 4, "packetCacheSize"),
      normalizeNonNegativeInteger(options.prefetchFrames, 0, "prefetchFrames")
    );
  }

  get decodeQueueSize(): number {
    return this.decoder.decodeQueueSize;
  }

  get desiredSize(): number {
    return this.closed ? 0 : this.decoder.desiredSize;
  }

  get dequeued(): Promise<void> {
    return this.decoder.dequeued;
  }

  get sourceBytesRead(): number {
    return this.mxfDemuxer?.bytesRead ?? 0;
  }

  get cachedPacketCount(): number {
    return this.packetCache.size;
  }

  decode(
    index: number,
    options: DnxRandomAccessDecodeOptions = {}
  ): Promise<DecodeFrame | Error> {
    if (this.closed) {
      return Promise.resolve(new DnxDecoderClosedError("DNx random-access decoder is closed."));
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.packets.length) {
      return Promise.resolve(new DnxInvalidDataError(`DNx frame index ${index} is outside 0-${this.packets.length - 1}.`));
    }
    return this.track(this.decodeNow(index, options));
  }

  private async decodeNow(index: number, options: DnxRandomAccessDecodeOptions): Promise<DecodeFrame | Error> {
    let packetBytes: Uint8Array;
    try {
      throwIfAborted(options.signal);
      packetBytes = await this.readPacket(index, options.signal);
      throwIfAborted(options.signal);
    } catch (error) {
      return toError(error);
    }
    const frame = new Frame();
    const decoded = await this.decoder.decode(packetBytes, frame);
    if (options.signal?.aborted) {
      frame.clear();
      return abortError(options.signal);
    }
    if (decoded instanceof Error) {
      frame.clear();
      return decoded;
    }

    const result: DecodeFrame = {
      index,
      timestampUs: index * this.frameDurationUs,
      durationUs: this.frameDurationUs,
      width: decoded.visibleWidth,
      height: decoded.visibleHeight,
      format: decoded.pixelFormat,
      colorSpace: dnxColorSpaceForHeader(decoded.header),
      scanType: "progressive",
      planes: decoded.layout.planes,
      metadata: {
        header: decoded.header,
        idctMode: this.decoder.idctMode,
        randomAccess: true
      }
    };
    if (options.prefetch !== false) {
      this.prefetchAfter(index);
    }
    return result;
  }

  seek(index: number, options: DnxRandomAccessDecodeOptions = {}): Promise<DecodeFrame | Error> {
    if (this.closed) {
      return Promise.resolve(new DnxDecoderClosedError("DNx random-access decoder is closed."));
    }
    this.seekController?.abort(new DOMException("This seek was superseded by a newer target.", "AbortError"));
    const controller = new AbortController();
    const unlink = forwardAbort(options.signal, controller);
    this.seekController = controller;
    const preceding = this.seekTail.catch(() => undefined);
    const result = preceding
      .then(() => {
        throwIfAborted(controller.signal);
        return this.decode(index, { ...options, signal: controller.signal });
      })
      .catch((error: unknown) => toError(error));
    this.seekTail = result.then(() => undefined);
    void result.finally(() => {
      unlink();
      if (this.seekController === controller) {
        this.seekController = null;
      }
    });
    return result;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.seekController?.abort(new DOMException("The DNx random-access decoder was closed.", "AbortError"));
    this.prefetchController?.abort(new DOMException("The DNx random-access decoder was closed.", "AbortError"));
    this.packetCache.clear();
    this.closePromise = (async () => {
      await this.seekTail;
      await Promise.allSettled([...this.activeOperations]);
      await this.decoder.close();
    })();
    return this.closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private readPacket(index: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (!this.mxfDemuxer) {
      return Promise.resolve((this.packets[index] as DnxFramePacket).bytes);
    }
    const cached = this.packetCache.get(index);
    if (cached) {
      this.packetCache.delete(index);
      this.packetCache.set(index, cached);
      return cached;
    }
    const read = this.mxfDemuxer.readPacket(this.packets[index] as MxfPacket, { signal }).catch((error) => {
      this.packetCache.delete(index);
      throw error;
    });
    if (this.packetCacheSize > 0) {
      this.packetCache.set(index, read);
      while (this.packetCache.size > this.packetCacheSize) {
        this.packetCache.delete(this.packetCache.keys().next().value as number);
      }
    }
    return read;
  }

  private prefetchAfter(index: number): void {
    this.prefetchController?.abort(new DOMException("A newer prefetch window was requested.", "AbortError"));
    const controller = new AbortController();
    this.prefetchController = controller;
    for (let offset = 1; offset <= this.prefetchFrames && index + offset < this.frameCount; offset += 1) {
      void this.track(this.readPacket(index + offset, controller.signal)).catch(() => undefined);
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    void operation.then(
      () => this.activeOperations.delete(operation),
      () => this.activeOperations.delete(operation)
    );
    return operation;
  }
}

function normalizeFrameDuration(value: number | undefined, editRate: DnxMxfEditRate | null): number {
  if (value !== undefined && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (editRate) {
    return Math.round((editRate.denominator * 1_000_000) / editRate.numerator);
  }
  return Math.round(1_000_000 / 30);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
  return resolved;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The DNx operation was aborted.", "AbortError");
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => undefined;
  }
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }
  return () => signal.removeEventListener("abort", abort);
}
