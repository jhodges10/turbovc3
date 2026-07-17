import {
  findAscii,
  hasExtension,
  type CodecBuildTarget,
  type CodecModule,
  type CodecProbe,
  type CodecProbeInput,
  type DecodeEvent,
  type DecodeInput,
  type DecodeColorSpace,
  type DecodePixelAspectRatio,
  type DecodeSession,
  type DecodeSessionOptions
} from "./core/index.js";
import { Decoder, Frame } from "./dnxDecoder.js";
import { inspectDnxContainer, type DnxPacketSummary } from "./dnxMediabunny.js";
import { demuxDnxMxf, isMxfFile, type DnxMxfEditRate } from "./dnxMxf.js";
import {
  DNX_SAMPLE_ENTRIES,
  findDnxFramePackets,
  findDnxFrameHeader,
  dnxColorSpaceForHeader,
  parseDnxFrameHeader,
  summarizeDnxFrameHeader
} from "./dnxFrame.js";

const DNX_EXTENSIONS = [".mov", ".mxf", ".dnxhd", ".dnxhr"] as const;
const ISO_BMFF_ATOMS = ["ftyp", "moov", "mdat"] as const;
type ParsedDnxFrameHeader = NonNullable<ReturnType<typeof parseDnxFrameHeader>>;
type PacketTiming = Pick<DnxPacketSummary, "timestamp" | "duration" | "sequenceNumber">;
type PacketDecodeResult = { ok: true; event: DecodeEvent } | { ok: false; event: DecodeEvent };
interface PacketDecodeInput {
  header: ParsedDnxFrameHeader;
  bytes: Uint8Array;
  frameIndex: number;
  timing?: PacketTiming;
  pixelAspectRatio?: DecodePixelAspectRatio;
  colorSpace?: DecodeColorSpace;
}

export const dnxBuildTargets: readonly CodecBuildTarget[] = [
  {
    name: "dnx-mediabunny-demux",
    runtime: "worker",
    sourceRoot: "src",
    outputRoot: "dist",
    status: "experimental",
    notes: [
      "Uses Mediabunny 1.50.8 to extract AVdn/AVdh packets from MOV/QuickTime files.",
      "registerDnxDecoder provides the CustomVideoDecoder entry point and a guarded recognition shim until Mediabunny has first-class DNx support."
    ]
  },
  {
    name: "dnx-idct-wasm-kernel",
    runtime: "wasm",
    sourceRoot: "src/native",
    outputRoot: "wasm/generated",
    status: "experimental",
    notes: [
      "Retained as the scalar WASM IDCT fallback and parity oracle.",
      "The Zig row decoder is preferred for supported packets."
    ]
  },
  {
    name: "dnx-bitstream-wasm",
    runtime: "wasm",
    sourceRoot: "src/native",
    outputRoot: "wasm/generated",
    status: "experimental",
    notes: [
      "Zig/WASM decodes VLCs, inverse quantization, SIMD IDCT, and complete planar frames.",
      "Cross-origin-isolated pages split each frame across shared-memory row workers; other runtimes use bounded packet workers."
    ]
  },
  {
    name: "dnx-color-webgpu",
    runtime: "webgpu",
    sourceRoot: "src",
    outputRoot: "dist",
    status: "experimental",
    notes: [
      "Uploads planar 4:2:0, 4:2:2, and 4:4:4 8/10-bit YUV and applies DNx Rec. 709/Rec. 2020 display conversion in WGSL."
    ]
  }
];

export const dnxCodec: CodecModule = {
  id: "dnx",
  label: "Avid DNxHD/DNxHR",
  status: "experimental",
  extensions: DNX_EXTENSIONS,
  probe: probeDnx,
  createSession(options) {
    return new DnxDecodeSession(options, "packet-workers");
  }
};

function probeDnx(input: CodecProbeInput): CodecProbe | null {
  const extensionMatch = hasExtension(input.filename, DNX_EXTENSIONS);
  const scannedHeaderBytes = Math.min(input.bytes.length, 512 * 1024);
  const scannedMovieBytes = Math.min(input.bytes.length, 4 * 1024 * 1024);
  const atomMatches = findAscii(input.bytes, ISO_BMFF_ATOMS, { limit: scannedHeaderBytes });
  const sampleEntryMatches = findAscii(input.bytes, DNX_SAMPLE_ENTRIES, { limit: scannedMovieBytes });
  const directFrame = findDnxFrameHeader(input.bytes, { limit: scannedHeaderBytes });

  if (!extensionMatch && sampleEntryMatches.length === 0 && !directFrame) {
    return null;
  }

  const notes: string[] = [];
  if (sampleEntryMatches.length > 0) {
    notes.push(`Found DNx sample entry "${sampleEntryMatches[0].needle}" at byte ${sampleEntryMatches[0].offset}.`);
  }
  if (directFrame) {
    notes.push(`Found DNx frame header at byte ${directFrame.offset}: ${summarizeDnxFrameHeader(directFrame.header)}.`);
    if (!directFrame.header.supported) {
      notes.push(`v1 unsupported: ${directFrame.header.unsupportedReasons.join(" ")}`);
    }
  }
  if (extensionMatch && sampleEntryMatches.length === 0 && !directFrame) {
    notes.push("Filename extension is compatible with DNx, but no DNx sample entry or frame header was found in the scanned window.");
  }

  return {
    codecId: "dnx",
    label: "Avid DNxHD/DNxHR",
    confidence: confidenceFor(extensionMatch, atomMatches.length > 0, sampleEntryMatches.length > 0, Boolean(directFrame)),
    container: atomMatches.length > 0 ? "QuickTime/ISO BMFF" : directFrame ? "Raw DNx frame" : undefined,
    stream: sampleEntryMatches[0]?.needle ?? directFrame?.header.fourCc,
    notes,
    metadata: {
      scannedHeaderBytes,
      scannedMovieBytes,
      sampleEntryMatches: sampleEntryMatches.slice(0, 8),
      directFrame: directFrame
        ? {
            offset: directFrame.offset,
            header: directFrame.header
          }
        : null,
      buildTargets: dnxBuildTargets
    }
  };
}

export class DnxDecodeSession implements DecodeSession {
  private closed = false;
  private readonly startFrame: number;
  private readonly maxFrames: number;

  constructor(
    private readonly options: DecodeSessionOptions = {},
    private readonly workerMode: "main" | "worker" | "packet-workers" = "main"
  ) {
    this.startFrame = normalizeStartFrame(options.startFrame);
    this.maxFrames = normalizeFrameLimit(options.maxFrames);
  }

  async *decode(input: DecodeInput): AsyncIterable<DecodeEvent> {
    if (this.closed) {
      return;
    }

    yield {
      type: "log",
      level: "info",
      message: "Inspecting DNx container and frame headers."
    };

    const directHeader = parseDnxFrameHeader(input.bytes);

    try {
      const inspection = await inspectDnxContainer(input.bytes);
        const dnxTrack = inspection.dnxTracks[0];

      if (dnxTrack) {
        yield {
          type: "metadata",
          codecId: "dnx",
          container: "QuickTime/ISO BMFF",
          width: dnxTrack.firstPacket?.header?.width ?? dnxTrack.codedWidth,
          height: dnxTrack.firstPacket?.header?.height ?? dnxTrack.codedHeight,
          frameCount: dnxTrack.packets.length,
          durationUs: durationUsForPackets(dnxTrack.packets),
          details: {
            workerMode: this.workerMode,
            track: detailForTrack(dnxTrack),
            buildTargets: dnxBuildTargets
          }
        };

        if (!dnxTrack.firstPacket?.header) {
          yield {
            type: "error",
            message: "DNx track was found, but the first packet did not contain a parseable DNx frame header."
          };
          yield { type: "done", framesDecoded: 0 };
          return;
        }

        let decodedFrames = 0;
        const decoder = await this.createDecoder(dnxTrack.firstPacket.header);
        if (decoder instanceof Error) {
          yield {
            type: "error",
            message: decoder.message,
            detail: decoder
          };
          yield { type: "done", framesDecoded: decodedFrames };
          return;
        }

        try {
          const pixelAspectRatio = pixelAspectRatioForTrack(dnxTrack);
          const colorSpace = colorSpaceForTrack(dnxTrack, dnxTrack.firstPacket.header);
          const decodeInputs = dnxTrack.packets
            .slice(this.startFrame, rangeEnd(this.startFrame, this.maxFrames))
            .map((packet, index): PacketDecodeInput | null =>
              packet.header
                ? {
                    header: packet.header,
                    bytes: packet.data,
                    frameIndex: this.startFrame + index,
                    timing: packet,
                    pixelAspectRatio,
                    colorSpace
                  }
                : null
            );
          if (decodeInputs.some((packet) => packet === null)) {
            yield {
              type: "error",
              message: "A DNx packet did not contain a parseable frame header."
            };
          } else {
            yield this.headerLogEvent(dnxTrack.firstPacket.header);
            for await (const decoded of this.decodePacketSequence(decoder, decodeInputs as PacketDecodeInput[])) {
              yield decoded.event;
              if (decoded.ok) {
                decodedFrames += 1;
              } else {
                break;
              }
            }
          }
        } finally {
          await decoder.close();
        }

        yield { type: "done", framesDecoded: decodedFrames };
        return;
      }

      if (inspection.tracks.length > 0) {
        yield {
          type: "log",
          level: "warn",
          message: "Mediabunny found video tracks, but none used AVdn/AVdh DNx sample entries.",
          detail: inspection.tracks
        };
      }
    } catch (error) {
      yield {
        type: "log",
        level: "warn",
        message: "Mediabunny container inspection failed; trying raw DNx frame validation.",
        detail: formatError(error)
      };
    }

    if (isMxfFile(input.bytes)) {
      try {
        const mxf = await demuxDnxMxf(input.bytes);
        if (!mxf) {
          yield { type: "error", message: "MXF tracks were parsed, but no DNx picture essence track was found." };
          yield { type: "done", framesDecoded: 0 };
          return;
        }
        const packets = mxf.packets.slice(this.startFrame, rangeEnd(this.startFrame, this.maxFrames));
        yield {
          type: "metadata",
          codecId: "dnx",
          container: "MXF",
          width: mxf.firstFrameHeader.width,
          height: mxf.firstFrameHeader.height,
          frameCount: mxf.packets.length,
          durationUs: Math.round(
            (mxf.packets.length * mxf.editRate.denominator * 1_000_000) / mxf.editRate.numerator
          ),
          details: {
            workerMode: this.workerMode,
            editRate: mxf.editRate,
            header: mxf.firstFrameHeader,
            track: mxf.track,
            partitions: mxf.demuxer.result.partitions.length,
            indexTableSegments: mxf.demuxer.result.indexTableSegments.length,
            randomIndexEntries: mxf.demuxer.result.randomIndex.length,
            buildTargets: dnxBuildTargets
          }
        };

        let decodedFrames = 0;
        const decoder = await this.createDecoder(mxf.firstFrameHeader);
        if (decoder instanceof Error) {
          yield { type: "error", message: decoder.message, detail: decoder };
        } else {
          try {
            yield this.headerLogEvent(mxf.firstFrameHeader);
            const decodeInputs: PacketDecodeInput[] = [];
            for (const [index, packet] of packets.entries()) {
              const bytes = await mxf.demuxer.readPacket(packet);
              const header = parseDnxFrameHeader(bytes);
              if (!header) {
                throw new Error(`MXF DNx packet ${packet.index} does not contain a valid frame header.`);
              }
              decodeInputs.push({
                header,
                bytes,
                frameIndex: this.startFrame + index,
                timing: timingForEditRate(this.startFrame + index, mxf.editRate)
              });
            }
            for await (const decoded of this.decodePacketSequence(decoder, decodeInputs)) {
              yield decoded.event;
              if (decoded.ok) {
                decodedFrames += 1;
              } else {
                break;
              }
            }
          } finally {
            await decoder.close();
          }
        }
        yield { type: "done", framesDecoded: decodedFrames };
        return;
      } catch (error) {
        yield { type: "error", message: `MXF demux failed: ${formatError(error)}`, detail: error };
        yield { type: "done", framesDecoded: 0 };
        return;
      }
    }

    const packetScanLimit = rangeEnd(this.startFrame, this.maxFrames);
    const packets = findDnxFramePackets(input.bytes, { maxFrames: packetScanLimit }).slice(this.startFrame);
    if (packets.length > 0) {
      yield {
        type: "metadata",
        codecId: "dnx",
        container: "Raw DNx stream",
        width: packets[0].header.width,
        height: packets[0].header.height,
        frameCount: packets.length,
        durationUs: undefined,
        details: {
          workerMode: this.workerMode,
          firstFrameOffset: packets[0].offset,
          editRate: null,
          header: packets[0].header,
          buildTargets: dnxBuildTargets
        }
      };

      let decodedFrames = 0;
      const decoder = await this.createDecoder(packets[0].header);
      if (decoder instanceof Error) {
        yield {
          type: "error",
          message: decoder.message,
          detail: decoder
        };
      } else {
        try {
          yield this.headerLogEvent(packets[0].header);
          const decodeInputs = packets.map((packet, index): PacketDecodeInput => ({
            header: packet.header,
            bytes: packet.bytes,
            frameIndex: this.startFrame + index,
            timing: undefined
          }));
          for await (const decoded of this.decodePacketSequence(decoder, decodeInputs)) {
            yield decoded.event;
            if (decoded.ok) {
              decodedFrames += 1;
            } else {
              break;
            }
          }
        } finally {
          await decoder.close();
        }
      }

      yield { type: "done", framesDecoded: decodedFrames };
      return;
    }

    if (directHeader) {
      yield {
        type: "metadata",
        codecId: "dnx",
        container: "Raw DNx frame",
        width: directHeader.width,
        height: directHeader.height,
        details: {
          workerMode: this.workerMode,
          header: directHeader,
          buildTargets: dnxBuildTargets
        }
      };
      yield this.headerLogEvent(directHeader);
      if (this.startFrame > 0) {
        yield {
          type: "error",
          message: `Raw DNx packet input cannot seek to frame ${this.startFrame}.`
        };
        yield { type: "done", framesDecoded: 0 };
        return;
      }
      const decoded = await this.decodePacket(directHeader, input.bytes, 0);
      yield decoded.event;
      yield { type: "done", framesDecoded: decoded.ok ? 1 : 0 };
      return;
    }

    yield {
      type: "error",
      message: "No DNxHD/DNxHR track or raw DNx frame header was found."
    };
  }

  close(): void {
    this.closed = true;
  }

  private headerLogEvent(header: ParsedDnxFrameHeader): DecodeEvent {
    return {
      type: "log",
      level: header.supported ? "info" : "warn",
      message: `${summarizeDnxFrameHeader(header)} ${header.supported ? "is in v1 scope." : "is outside v1 decode scope."}`,
      detail: header
    };
  }

  private async createDecoder(header: ParsedDnxFrameHeader): Promise<Decoder | Error> {
    return Decoder.create({
      dnxFourCc: header.fourCc,
      useSharedMemory: Decoder.canUseSharedMemory(),
      allowedOutputFormats: [
        "yuv422p8", "yuv422p10", "yuv422p12", "yuv444p10", "yuv444p12", "gbrp10", "gbrp12"
      ],
      concurrency: Math.min(4, Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 4))
    });
  }

  private async *decodePacketSequence(
    decoder: Decoder,
    packets: readonly PacketDecodeInput[]
  ): AsyncIterable<PacketDecodeResult> {
    const maximumInFlight = Math.max(1, decoder.concurrency * 2);
    const pending = new Map<number, Promise<PacketDecodeResult>>();
    let nextToSchedule = 0;
    let nextToYield = 0;

    while (nextToYield < packets.length) {
      while (nextToSchedule < packets.length && pending.size < maximumInFlight) {
        const packet = packets[nextToSchedule];
        pending.set(
          nextToSchedule,
          this.decodePacketWithDecoder(
            decoder,
            packet.header,
            packet.bytes,
            packet.frameIndex,
            packet.timing,
            packet.pixelAspectRatio,
            packet.colorSpace
          )
        );
        nextToSchedule += 1;
      }

      const result = await pending.get(nextToYield)!;
      pending.delete(nextToYield);
      nextToYield += 1;
      yield result;
      if (!result.ok) {
        return;
      }
    }
  }

  private async decodePacket(
    header: ParsedDnxFrameHeader,
    packetData: Uint8Array,
    index: number,
    timing?: PacketTiming,
    pixelAspectRatio?: DecodePixelAspectRatio,
    colorSpace?: DecodeColorSpace
  ): Promise<PacketDecodeResult> {
    const decoder = await this.createDecoder(header);

    if (decoder instanceof Error) {
      return {
        ok: false,
        event: {
          type: "error",
          message: decoder.message,
          detail: decoder
        }
      };
    }

    try {
      return await this.decodePacketWithDecoder(decoder, header, packetData, index, timing, pixelAspectRatio, colorSpace);
    } finally {
      await decoder.close();
    }
  }

  private async decodePacketWithDecoder(
    decoder: Decoder,
    header: ParsedDnxFrameHeader,
    packetData: Uint8Array,
    index: number,
    timing?: PacketTiming,
    pixelAspectRatio?: DecodePixelAspectRatio,
    colorSpace?: DecodeColorSpace
  ): Promise<PacketDecodeResult> {
    const frame = new Frame();
    try {
      const result = await decoder.decode(packetData, frame);
      if (result instanceof Error) {
        return {
          ok: false,
          event: {
            type: "error",
            message: result.message,
            detail: {
              name: result.name,
              state: "state" in result ? result.state : undefined,
              header
            }
          }
        };
      }

      return {
        ok: true,
        event: {
          type: "frame",
          frame: {
            index,
            timestampUs: timestampUsForPacket(index, timing),
            durationUs: durationUsForPacket(timing),
            width: result.visibleWidth,
            height: result.visibleHeight,
            format: result.pixelFormat,
            colorSpace: colorSpace ?? dnxColorSpaceForHeader(result.header),
            pixelAspectRatio: pixelAspectRatio ?? {
              numerator: result.pixelAspectRatio.num,
              denominator: result.pixelAspectRatio.den
            },
            scanType: result.scanType === "progressive" ? "progressive" : "interlaced",
            planes: result.layout.planes,
            metadata: {
              header: result.header,
              packet: timing,
              idctMode: decoder.idctMode
            }
          }
        }
      };
    } catch (error) {
      return {
        ok: false,
        event: {
          type: "error",
          message: formatError(error),
          detail: { header }
        }
      };
    } finally {
      frame.clear();
    }
  }
}

function pixelAspectRatioForTrack(track: {
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
}): DecodePixelAspectRatio | undefined {
  const numerator = Math.round(track.displayWidth * track.codedHeight);
  const denominator = Math.round(track.displayHeight * track.codedWidth);
  if (numerator <= 0 || denominator <= 0) {
    return undefined;
  }
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

const COLOR_PRIMARIES = ["bt709", "bt470bg", "smpte170m", "bt2020", "smpte432"] as const;
const COLOR_TRANSFERS = ["bt709", "smpte170m", "linear", "iec61966-2-1", "pq", "hlg"] as const;
const COLOR_MATRICES = ["rgb", "bt709", "bt470bg", "smpte170m", "bt2020-ncl", "bt2020-cl"] as const;

function colorSpaceForTrack(
  track: {
    colorSpace: {
      primaries: string | null;
      transfer: string | null;
      matrix: string | null;
      fullRange: boolean | null;
    };
  },
  header: ParsedDnxFrameHeader
): DecodeColorSpace {
  const fallback = dnxColorSpaceForHeader(header);
  return {
    primaries: includesString(COLOR_PRIMARIES, track.colorSpace.primaries)
      ? track.colorSpace.primaries
      : fallback.primaries,
    transfer: includesString(COLOR_TRANSFERS, track.colorSpace.transfer)
      ? track.colorSpace.transfer
      : fallback.transfer,
    matrix: includesString(COLOR_MATRICES, track.colorSpace.matrix)
      ? track.colorSpace.matrix
      : fallback.matrix,
    fullRange: track.colorSpace.fullRange ?? fallback.fullRange
  };
}

function includesString<const Values extends readonly string[]>(
  values: Values,
  value: string | null
): value is Values[number] {
  return value !== null && (values as readonly string[]).includes(value);
}

function greatestCommonDivisor(left: number, right: number): number {
  while (right !== 0) {
    [left, right] = [right, left % right];
  }
  return left;
}

function confidenceFor(extensionMatch: boolean, atomMatch: boolean, sampleEntryMatch: boolean, frameHeaderMatch: boolean): number {
  if (sampleEntryMatch || frameHeaderMatch) {
    return 0.95;
  }

  if (extensionMatch && atomMatch) {
    return 0.65;
  }

  return extensionMatch ? 0.35 : 0.1;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function normalizeFrameLimit(value: number | undefined): number {
  if (value === undefined) {
    return Infinity;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError("DecodeSessionOptions.maxFrames must be a positive finite number.");
  }
  return Math.floor(value);
}

function normalizeStartFrame(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("DecodeSessionOptions.startFrame must be a non-negative integer.");
  }
  return value;
}

function rangeEnd(startFrame: number, maxFrames: number): number {
  return maxFrames === Infinity ? Infinity : startFrame + maxFrames;
}

function timingForEditRate(index: number, editRate: DnxMxfEditRate | null): PacketTiming | undefined {
  if (!editRate) {
    return undefined;
  }
  const duration = editRate.denominator / editRate.numerator;
  return {
    timestamp: index * duration,
    duration,
    sequenceNumber: index
  };
}

function detailForTrack(track: Awaited<ReturnType<typeof inspectDnxContainer>>["tracks"][number]): Record<string, unknown> {
  return {
    trackNumber: track.trackNumber,
    codec: track.codec,
    internalCodecId: track.internalCodecId,
    codedWidth: track.codedWidth,
    codedHeight: track.codedHeight,
    displayWidth: track.displayWidth,
    displayHeight: track.displayHeight,
    pixelAspectRatio: pixelAspectRatioForTrack(track),
    isDnx: track.isDnx,
    packetCount: track.packets.length,
    firstPacket: summarizePacket(track.firstPacket),
    packets: track.packets.slice(0, 12).map(summarizePacket)
  };
}

function summarizePacket(packet: DnxPacketSummary | null): Record<string, unknown> | null {
  return packet
    ? {
        byteLength: packet.byteLength,
        timestamp: packet.timestamp,
        duration: packet.duration,
        sequenceNumber: packet.sequenceNumber,
        header: packet.header
      }
    : null;
}

function timestampUsForPacket(index: number, timing?: PacketTiming): number {
  return timing && Number.isFinite(timing.timestamp)
    ? Math.round(timing.timestamp * 1_000_000)
    : Math.round((index * 1_000_000) / 30);
}

function durationUsForPacket(timing?: PacketTiming): number {
  return timing && Number.isFinite(timing.duration) && timing.duration > 0
    ? Math.round(timing.duration * 1_000_000)
    : Math.round(1_000_000 / 30);
}

function durationUsForPackets(packets: readonly DnxPacketSummary[]): number | undefined {
  if (packets.length === 0) {
    return undefined;
  }

  const firstTimestamp = packets[0].timestamp;
  const lastPacket = packets[packets.length - 1];
  if (!Number.isFinite(firstTimestamp) || !Number.isFinite(lastPacket.timestamp) || !Number.isFinite(lastPacket.duration)) {
    return undefined;
  }

  return Math.round((lastPacket.timestamp + lastPacket.duration - firstTimestamp) * 1_000_000);
}
