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

export interface DnxRandomAccessDecoderOptions {
  concurrency?: number;
  allowedOutputFormats?: readonly DnxPixelFormat[];
  frameDurationUs?: number;
}

export class DnxRandomAccessDecoder implements AsyncDisposable {
  readonly frameCount: number;
  readonly dnxFourCc: DnxFourCc;
  readonly editRate: DnxMxfEditRate | null;
  private closed = false;

  private constructor(
    private readonly packets: readonly DnxFramePacket[],
    private readonly decoder: Decoder,
    editRate: DnxMxfEditRate | null,
    private readonly frameDurationUs: number
  ) {
    this.frameCount = packets.length;
    this.dnxFourCc = packets[0].header.fourCc;
    this.editRate = editRate;
  }

  static async create(
    bytes: Uint8Array,
    options: DnxRandomAccessDecoderOptions = {}
  ): Promise<Error | DnxRandomAccessDecoder> {
    const mxf = isMxfFile(bytes) ? await demuxDnxMxf(bytes) : null;
    const packets = mxf?.packets ?? (isMxfFile(bytes) ? [] : findDnxFramePackets(bytes));
    if (packets.length === 0) {
      return new DnxInvalidDataError("No indexed DNx frames were found for random-access decode.");
    }

    const decoder = await Decoder.create({
      dnxFourCc: packets[0].header.fourCc,
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
    return new DnxRandomAccessDecoder(packets, decoder, editRate, frameDurationUs);
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

  async decode(index: number): Promise<DecodeFrame | DnxInvalidDataError | DnxDecoderClosedError> {
    if (this.closed) {
      return new DnxDecoderClosedError("DNx random-access decoder is closed.");
    }
    if (!Number.isInteger(index) || index < 0 || index >= this.packets.length) {
      return new DnxInvalidDataError(`DNx frame index ${index} is outside 0-${this.packets.length - 1}.`);
    }

    const packet = this.packets[index];
    const frame = new Frame();
    const decoded = await this.decoder.decode(packet.bytes, frame);
    if (decoded instanceof Error) {
      frame.clear();
      return decoded;
    }

    return {
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
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.decoder.close();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
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
