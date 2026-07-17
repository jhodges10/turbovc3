export type CodecId = "prores" | "r3d" | "dnx" | (string & {});

export type CodecStatus = "scaffold" | "experimental" | "usable";

export type DecodePixelFormat =
  | "rgba8"
  | "bgra8"
  | "rgba16"
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
  | "bayer16"
  | "unknown";

export interface CodecProbeInput {
  bytes: Uint8Array;
  filename?: string;
  mimeType?: string;
}

export interface DecodeInput extends CodecProbeInput {}

export interface CodecProbe {
  codecId: CodecId;
  label: string;
  confidence: number;
  container?: string;
  stream?: string;
  notes?: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface DecodePlane {
  label: string;
  width: number;
  height: number;
  stride: number;
  bytes: Uint8Array;
}

export type DecodeColorPrimaries = "bt709" | "bt470bg" | "smpte170m" | "bt2020" | "smpte432" | "unspecified";
export type DecodeColorTransfer = "bt709" | "smpte170m" | "linear" | "iec61966-2-1" | "pq" | "hlg" | "unspecified";
export type DecodeColorMatrix = "rgb" | "bt709" | "bt470bg" | "smpte170m" | "bt2020-ncl" | "bt2020-cl" | "unspecified";

export interface DecodeColorSpace {
  primaries: DecodeColorPrimaries;
  transfer: DecodeColorTransfer;
  matrix: DecodeColorMatrix;
  fullRange: boolean;
}

export interface DecodePixelAspectRatio {
  numerator: number;
  denominator: number;
}

export interface DecodeFrame {
  index: number;
  timestampUs: number;
  durationUs?: number;
  width: number;
  height: number;
  format: DecodePixelFormat;
  colorSpace?: DecodeColorSpace;
  pixelAspectRatio?: DecodePixelAspectRatio;
  scanType?: "progressive" | "interlaced" | "unknown";
  planes?: readonly DecodePlane[];
  texture?: unknown;
  metadata?: Record<string, unknown>;
}

export interface DecodeLogEvent {
  type: "log";
  level: "debug" | "info" | "warn";
  message: string;
  detail?: unknown;
}

export interface DecodeMetadataEvent {
  type: "metadata";
  codecId: CodecId;
  container?: string;
  width?: number;
  height?: number;
  durationUs?: number;
  frameCount?: number;
  details?: Record<string, unknown>;
}

export interface DecodeFrameEvent {
  type: "frame";
  frame: DecodeFrame;
}

export interface DecodeErrorEvent {
  type: "error";
  message: string;
  detail?: unknown;
}

export interface DecodeDoneEvent {
  type: "done";
  framesDecoded: number;
}

export type DecodeEvent =
  | DecodeLogEvent
  | DecodeMetadataEvent
  | DecodeFrameEvent
  | DecodeErrorEvent
  | DecodeDoneEvent;

export type DecodeLogger = (event: DecodeLogEvent) => void;

export interface DecodeSessionOptions {
  preferWebGpu?: boolean;
  webGpuDevice?: unknown;
  startFrame?: number;
  maxFrames?: number;
  signal?: AbortSignal;
  logger?: DecodeLogger;
}

export interface DecodeSession {
  decode(input: DecodeInput): AsyncIterable<DecodeEvent>;
  close(): Promise<void> | void;
}

export interface CodecModule {
  id: CodecId;
  label: string;
  status: CodecStatus;
  extensions: readonly string[];
  probe(input: CodecProbeInput): Promise<CodecProbe | null> | CodecProbe | null;
  createSession(options?: DecodeSessionOptions): Promise<DecodeSession> | DecodeSession;
}

export async function bytesFromFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function createUnsupportedDecodeSession(options: {
  codecLabel: string;
  reason: string;
}): DecodeSession {
  return {
    async *decode(): AsyncIterable<DecodeEvent> {
      yield {
        type: "log",
        level: "warn",
        message: `${options.codecLabel} decode is not implemented yet.`
      };
      yield {
        type: "error",
        message: options.reason
      };
    },
    close() {
      return undefined;
    }
  };
}
