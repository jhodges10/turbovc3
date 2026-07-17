import type { DecodePixelFormat } from "./core/codec.js";
import {
  DNX_SAMPLE_ENTRIES,
  dnxFrameMetadataForHeader,
  parseDnxFrameHeader,
  type DnxFourCc,
  type DnxFrameHeader,
  type DnxScanType
} from "./dnxFrame.js";
import {
  analyzeDnxPixelReconstruction,
  type DnxFrameLayout,
  type DnxReconstructionState
} from "./dnxReconstruction.js";
import { createDnxIdctKernel, type DnxIdctKernel, type DnxIdctMode } from "./dnxIdctKernel.js";
import { decodeDnxScalarFrame } from "./dnxScalarDecoder.js";
import { convertDnxFrameLayout, selectDnxOutputFormat } from "./dnxPixelConversion.js";
import { DnxSharedRowDecoder } from "./dnxSharedRowDecoder.js";
import { createDnxZigRowDecoder, type DnxRowDecoder } from "./dnxZigRowDecoder.js";
import { DnxDecoderWorkerPool } from "./dnxDecoderWorkerPool.js";

export type DnxPixelFormat = Extract<
  DecodePixelFormat,
  | "yuv420p8"
  | "yuv420p10"
  | "yuv420p12"
  | "yuv422p8"
  | "yuv422p10"
  | "yuv422p12"
  | "yuv444p8"
  | "yuv444p10"
  | "yuv444p12"
  | "gbrp10"
  | "gbrp12"
>;

export interface DecoderOptions {
  dnxFourCc: DnxFourCc;
  useSharedMemory: boolean;
  concurrency?: number;
  allowedOutputFormats?: readonly DnxPixelFormat[];
}

export interface DecodeOptions {
  transfer?: boolean;
}

export type FilledFrame = {
  [K in keyof Frame]: NonNullable<Frame[K]>;
};

export class DnxDecoderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnxDecoderError";
  }
}

export class DnxInvalidDataError extends DnxDecoderError {
  constructor(message = "Invalid DNx packet data.") {
    super(message);
    this.name = "DnxInvalidDataError";
  }
}

export class DnxUnexpectedEofError extends DnxInvalidDataError {
  constructor(message = "DNx packet ended before the frame could be decoded.") {
    super(message);
    this.name = "DnxUnexpectedEofError";
  }
}

export class DnxOutOfMemoryError extends DnxDecoderError {
  constructor(message = "The DNx decoder could not allocate its output frame.") {
    super(message);
    this.name = "DnxOutOfMemoryError";
  }
}

export class DnxNotSupportedError extends DnxDecoderError {
  constructor(message = "DNx feature is not supported by this decoder yet.") {
    super(message);
    this.name = "DnxNotSupportedError";
  }
}

export class DnxReconstructionPendingError extends DnxNotSupportedError {
  constructor(
    message: string,
    readonly state: DnxReconstructionState
  ) {
    super(message);
    this.name = "DnxReconstructionPendingError";
  }
}

export class DnxDecoderClosedError extends DnxDecoderError {
  constructor(message = "DNx decoder is closed.") {
    super(message);
    this.name = "DnxDecoderClosedError";
  }
}

export class DnxFrameLockedError extends DnxDecoderError {
  constructor(message = "DNx output frame is already in use by another decode.") {
    super(message);
    this.name = "DnxFrameLockedError";
  }
}

export class Frame implements Disposable {
  frameData: Uint8Array | null = null;
  codedWidth: number | null = null;
  codedHeight: number | null = null;
  visibleWidth: number | null = null;
  visibleHeight: number | null = null;
  pixelFormat: DnxPixelFormat | null = null;
  originalPixelFormat: DnxPixelFormat | null = null;
  colorSpace: DnxFrameHeader["colorSpace"] | null = null;
  pixelAspectRatio: { num: number; den: number } | null = null;
  colorPrimaries: number | null = null;
  colorTransfer: number | null = null;
  colorMatrix: number | null = null;
  colorRangeFull: false | null = null;
  scanType: DnxScanType | null = null;
  header: DnxFrameHeader | null = null;
  layout: DnxFrameLayout | null = null;
  private locked = false;

  get isLocked(): boolean {
    return this.locked;
  }

  get isFilled(): boolean {
    return this.frameData !== null
      && this.codedWidth !== null
      && this.codedHeight !== null
      && this.visibleWidth !== null
      && this.visibleHeight !== null
      && this.pixelFormat !== null
      && this.originalPixelFormat !== null
      && this.colorSpace !== null
      && this.header !== null
      && this.layout !== null
      && this.pixelAspectRatio !== null
      && this.colorPrimaries !== null
      && this.colorTransfer !== null
      && this.colorMatrix !== null
      && this.colorRangeFull !== null
      && this.scanType !== null;
  }

  toFilled(): FilledFrame | null {
    return this.isFilled ? this as FilledFrame : null;
  }

  get colorPrimariesString(): string | undefined {
    return this.colorPrimaries === 1 ? "bt709" : this.colorPrimaries === 9 ? "bt2020" : undefined;
  }

  get colorTransferString(): string | undefined {
    return this.colorTransfer === 1 ? "bt709" : undefined;
  }

  get colorMatrixString(): string | undefined {
    return this.colorMatrix === 1 ? "bt709" : this.colorMatrix === 9 ? "bt2020-ncl" : this.colorMatrix === 10 ? "bt2020-cl" : undefined;
  }

  acquireLock(): boolean {
    if (this.locked) {
      return false;
    }
    this.locked = true;
    return true;
  }

  releaseLock(): void {
    this.locked = false;
  }

  clear(): void {
    if (this.locked) {
      throw new DnxFrameLockedError("Cannot clear a DNx output frame while decode is in progress.");
    }
    this.frameData = null;
    this.codedWidth = null;
    this.codedHeight = null;
    this.visibleWidth = null;
    this.visibleHeight = null;
    this.pixelFormat = null;
    this.originalPixelFormat = null;
    this.colorSpace = null;
    this.pixelAspectRatio = null;
    this.colorPrimaries = null;
    this.colorTransfer = null;
    this.colorMatrix = null;
    this.colorRangeFull = null;
    this.scanType = null;
    this.header = null;
    this.layout = null;
  }

  [Symbol.dispose](): void {
    this.clear();
  }
}

export class Decoder implements AsyncDisposable {
  readonly useSharedMemory: boolean;
  readonly concurrency: number;
  readonly dnxFourCc: DnxFourCc;
  readonly allowedOutputFormats: readonly DnxPixelFormat[];
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(
    options: Required<DecoderOptions>,
    private readonly idctKernel: DnxIdctKernel | null,
    private readonly rowDecoder: DnxRowDecoder | null,
    private readonly sharedRowDecoder: DnxSharedRowDecoder | null,
    private readonly workerPool: DnxDecoderWorkerPool | null
  ) {
    this.dnxFourCc = options.dnxFourCc;
    this.useSharedMemory = options.useSharedMemory;
    this.concurrency = options.concurrency;
    this.allowedOutputFormats = options.allowedOutputFormats;
  }

  get decodeQueueSize(): number {
    return this.sharedRowDecoder?.decodeQueueSize ?? this.workerPool?.decodeQueueSize ?? 0;
  }

  get desiredSize(): number {
    return this.closed ? 0 : (this.sharedRowDecoder?.desiredSize ?? this.workerPool?.desiredSize ?? 1);
  }

  get dequeued(): Promise<void> {
    return this.sharedRowDecoder?.dequeued ?? this.workerPool?.dequeued ?? Promise.resolve();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get idctMode(): DnxIdctMode | DnxRowDecoder["mode"] | string {
    return this.sharedRowDecoder?.mode ?? this.workerPool?.mode ?? this.rowDecoder?.mode ?? this.idctKernel?.mode ?? "uninitialized";
  }

  static async create(options: DecoderOptions): Promise<DnxNotSupportedError | Decoder> {
    if (!DNX_SAMPLE_ENTRIES.includes(options.dnxFourCc)) {
      return new DnxNotSupportedError(`Unsupported DNx sample entry "${options.dnxFourCc}".`);
    }
    if (options.useSharedMemory && !Decoder.canUseSharedMemory()) {
      return new DnxNotSupportedError(
        "Shared-memory DNx row threading requires Worker, SharedArrayBuffer, and a cross-origin-isolated page."
      );
    }

    const resolvedOptions: Required<DecoderOptions> = {
      dnxFourCc: options.dnxFourCc,
      useSharedMemory: options.useSharedMemory,
      concurrency: options.concurrency ?? Math.min(4, Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 4)),
      allowedOutputFormats: options.allowedOutputFormats ?? [
        "yuv422p8", "yuv422p10", "yuv422p12", "yuv444p10", "yuv444p12", "gbrp10", "gbrp12"
      ]
    };
    if (resolvedOptions.useSharedMemory) {
      try {
        const sharedRowDecoder = await DnxSharedRowDecoder.create(Math.max(1, resolvedOptions.concurrency));
        return new Decoder(resolvedOptions, null, null, sharedRowDecoder, null);
      } catch {
        // A page can satisfy the shared-memory capability checks while its row
        // worker module is temporarily unavailable (for example during a Vite
        // restart). Retry with the ordinary packet/scalar backends instead of
        // making shared-worker startup a hard requirement for DNx decoding.
        resolvedOptions.useSharedMemory = false;
      }
    }
    if (resolvedOptions.concurrency > 0 && typeof Worker !== "undefined") {
      try {
        const workerPoolOptions = { ...resolvedOptions, useSharedMemory: false };
        const workerPool = await DnxDecoderWorkerPool.create(workerPoolOptions);
        return new Decoder(workerPoolOptions, null, null, null, workerPool);
      } catch {
        // Fall through to the synchronous backend when nested workers are unavailable.
      }
    }

    const [idctKernel, rowDecoder] = await Promise.all([createDnxIdctKernel(), createDnxZigRowDecoder()]);
    return new Decoder(resolvedOptions, idctKernel, rowDecoder, null, null);
  }

  static canUseSharedMemory(): boolean {
    return (
      typeof Worker !== "undefined" &&
      typeof SharedArrayBuffer !== "undefined" &&
      globalThis.crossOriginIsolated === true
    );
  }

  async decode(
    packetData: Uint8Array,
    frame: Frame,
    options: DecodeOptions = {}
  ): Promise<
    | DnxInvalidDataError
    | DnxNotSupportedError
    | DnxDecoderClosedError
    | DnxFrameLockedError
    | DnxOutOfMemoryError
    | FilledFrame
  > {
    if (this.closed) {
      return new DnxDecoderClosedError();
    }
    if (!frame.acquireLock()) {
      return new DnxFrameLockedError();
    }

    try {
      const header = parseDnxFrameHeader(packetData);
      if (!header) {
        return packetData.byteLength < 0x280
          ? new DnxUnexpectedEofError(
              `DNx packet ended after ${packetData.byteLength} bytes; a frame header requires at least 640 bytes.`
            )
          : new DnxInvalidDataError("Packet does not contain a valid DNx frame header.");
      }

      if (header.fourCc !== this.dnxFourCc) {
        return new DnxInvalidDataError(`Packet sample entry ${header.fourCc} does not match decoder ${this.dnxFourCc}.`);
      }

      if (header.expectedFrameSize !== null && packetData.byteLength < header.expectedFrameSize) {
        return new DnxUnexpectedEofError(
          `DNx packet ended after ${packetData.byteLength} bytes; CID ${header.cid} requires ${header.expectedFrameSize} bytes.`
        );
      }

      if (!header.supported) {
        return new DnxNotSupportedError(header.unsupportedReasons.join(" "));
      }

      const sourcePixelFormat = header.pixelFormat as DnxPixelFormat;
      const outputPixelFormat = selectDnxOutputFormat(sourcePixelFormat, this.allowedOutputFormats);
      if (!outputPixelFormat) {
        return new DnxNotSupportedError(
          `No allowed output pixel format can be produced from ${header.pixelFormat}.`
        );
      }

      if (this.sharedRowDecoder) {
        try {
          const nativeLayout = await this.sharedRowDecoder.decode(packetData, header);
          const layout = convertDnxFrameLayout(nativeLayout, sourcePixelFormat, outputPixelFormat, header.colorSpace);
          populateDecodedFrame(frame, header, layout, outputPixelFormat);
          return frame as FilledFrame;
        } catch (error) {
          return decodeErrorFrom(error);
        }
      }

      if (this.workerPool) {
        try {
          return await this.workerPool.decode(packetData, frame, options);
        } catch (error) {
          return decodeErrorFrom(error);
        }
      }

      try {
        populateFrameHeader(frame, header);
        if (
          header.cid === 1235 ||
          header.cid === 1237 ||
          header.cid === 1251 ||
          header.cid === 1256 ||
          (header.cid >= 1270 && header.cid <= 1274)
        ) {
          const decoded = decodeDnxScalarFrame(packetData, header, this.idctKernel ?? undefined, this.rowDecoder);
          const layout = convertDnxFrameLayout(decoded.layout, sourcePixelFormat, outputPixelFormat, header.colorSpace);
          frame.pixelFormat = outputPixelFormat;
          frame.layout = layout;
          frame.frameData = layout.planes[0].bytes;
          return frame as FilledFrame;
        }

        const reconstruction = analyzeDnxPixelReconstruction(packetData, header);
        frame.layout = reconstruction.layout;
        return new DnxReconstructionPendingError(
          "DNx frame layout, row spans, and first macroblock header were reconstructed; coefficient VLC and IDCT decode are not implemented yet.",
          reconstruction
        );
      } catch (error) {
        return decodeErrorFrom(error);
      }
    } finally {
      frame.releaseLock();
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.closed = true;
    this.closePromise = (async () => {
      await Promise.all([
        this.workerPool?.close(),
        this.sharedRowDecoder?.close()
      ]);
      this.rowDecoder?.destroy();
      this.idctKernel?.destroy();
    })();
    return this.closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

function populateFrameHeader(frame: Frame, header: DnxFrameHeader): void {
  const metadata = dnxFrameMetadataForHeader(header);
  frame.header = header;
  frame.codedWidth = Math.ceil(header.width / 16) * 16;
  frame.codedHeight = Math.ceil(header.height / 16) * 16;
  frame.visibleWidth = header.width;
  frame.visibleHeight = header.height;
  frame.pixelFormat = header.pixelFormat as DnxPixelFormat;
  frame.originalPixelFormat = header.pixelFormat as DnxPixelFormat;
  frame.colorSpace = header.colorSpace;
  frame.pixelAspectRatio = metadata.pixelAspectRatio;
  frame.colorPrimaries = metadata.colorPrimaries;
  frame.colorTransfer = metadata.colorTransfer;
  frame.colorMatrix = metadata.colorMatrix;
  frame.colorRangeFull = metadata.colorRangeFull;
  frame.scanType = metadata.scanType;
}

function populateDecodedFrame(
  frame: Frame,
  header: DnxFrameHeader,
  layout: DnxFrameLayout,
  outputPixelFormat: DnxPixelFormat
): void {
  populateFrameHeader(frame, header);
  frame.pixelFormat = outputPixelFormat;
  frame.layout = layout;
  frame.frameData = layout.planes[0].bytes;
}

function decodeErrorFrom(error: unknown): DnxInvalidDataError | DnxUnexpectedEofError | DnxOutOfMemoryError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RangeError || /out of memory|allocation failed/i.test(message)) {
    return new DnxOutOfMemoryError(message);
  }
  if (/unexpected end|ended before|outside the packet|smaller than/i.test(message)) {
    return new DnxUnexpectedEofError(message);
  }
  return new DnxInvalidDataError(message);
}
