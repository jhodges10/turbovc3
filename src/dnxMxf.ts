import {
  MxfDemuxer,
  type MxfDemuxOptions,
  type MxfPacket,
  type MxfSourceInput,
  type MxfTrack
} from "./mxf/index.js";
import { parseDnxFrameHeader, type DnxFrameHeader } from "./dnxFrame.js";
import { DnxInvalidDataError, DnxNotSupportedError } from "./dnxDecoder.js";

export { MxfDemuxer } from "./mxf/index.js";
export type {
  MxfDemuxLimits,
  MxfDemuxOptions,
  MxfDemuxProgress
} from "./mxf/mxfDemuxer.js";
export type {
  MxfSource,
  MxfSourceInput
} from "./mxf/mxfSource.js";
export type * from "./mxf/mxfTypes.js";

export interface DnxMxfEditRate {
  numerator: number;
  denominator: number;
  framesPerSecond: number;
}

export interface DnxMxfDemuxResult {
  demuxer: MxfDemuxer;
  track: MxfTrack;
  packets: readonly MxfPacket[];
  firstFrameHeader: DnxFrameHeader;
  editRate: DnxMxfEditRate;
}

const MXF_KEY_PREFIX = [0x06, 0x0e, 0x2b, 0x34] as const;
const SAMPLE_RATE_TAG = [0x4b, 0x01, 0x00, 0x08] as const;
const HEADER_SCAN_LIMIT = 2 * 1024 * 1024;
const DNX_HEADER_BYTES = 0x280;

type SupportedMxfOperationalPattern = "op1a" | "opatom";

export function parseDnxMxfEditRate(bytes: Uint8Array): DnxMxfEditRate | null {
  if (!matches(bytes, 0, MXF_KEY_PREFIX)) {
    return null;
  }

  const limit = Math.min(bytes.length, HEADER_SCAN_LIMIT);
  for (let offset = 0; offset <= limit - 12; offset += 1) {
    if (!matches(bytes, offset, SAMPLE_RATE_TAG)) {
      continue;
    }

    const numerator = readU32BE(bytes, offset + 4);
    const denominator = readU32BE(bytes, offset + 8);
    const framesPerSecond = denominator === 0 ? 0 : numerator / denominator;
    if (
      numerator > 0 &&
      denominator > 0 &&
      Number.isFinite(framesPerSecond) &&
      framesPerSecond >= 1 &&
      framesPerSecond <= 240
    ) {
      return { numerator, denominator, framesPerSecond };
    }
  }

  return null;
}

export function isMxfFile(bytes: Uint8Array): boolean {
  return matches(bytes, 0, MXF_KEY_PREFIX);
}

export async function demuxDnxMxf(
  input: MxfSourceInput,
  options: MxfDemuxOptions = {}
): Promise<DnxMxfDemuxResult | null> {
  if (input instanceof Uint8Array && !isMxfFile(input)) {
    return null;
  }

  const demuxer = await MxfDemuxer.open(input, options);
  const operationalPattern = supportedOperationalPattern(demuxer.result.operationalPattern);
  if (!operationalPattern) {
    throw new DnxNotSupportedError(
      `DNx MXF adapter supports OP1a and OPAtom; received ${demuxer.result.operationalPattern ?? "no operational-pattern label"}.`
    );
  }
  if (operationalPattern === "opatom") {
    const essenceTracks = demuxer.tracks.filter((track) => track.packetCount > 0);
    if (essenceTracks.length !== 1) {
      throw new DnxInvalidDataError(
        `OPAtom MXF must contain exactly one essence track; found ${essenceTracks.length}.`
      );
    }
  }
  if (demuxer.compositions.length === 0) {
    throw new DnxInvalidDataError(
      `${operationalPattern === "opatom" ? "OPAtom" : "OP1a"} DNx MXF has no material-package composition.`
    );
  }
  for (const track of demuxer.tracks) {
    if (track.kind !== "video") {
      continue;
    }
    const packetLocators = demuxer.packetsForTrack(track);
    if (packetLocators.length === 0) {
      continue;
    }
    const firstPacket = packetLocators[0];
    const firstBytes = await demuxer.result.source.read(
      firstPacket.byteOffset,
      Math.min(DNX_HEADER_BYTES, firstPacket.byteLength),
      { signal: options.signal }
    );
    const firstFrameHeader = parseDnxFrameHeader(firstBytes, {
      declaredPacketLength: firstPacket.byteLength
    });
    if (!firstFrameHeader) {
      continue;
    }
    const referencedByComposition = demuxer.compositions.some((composition) =>
      composition.tracks.some((compositionTrack) =>
        compositionTrack.sourceClips.some((clip) => clip.sourceTrack === track)
      )
    );
    if (!referencedByComposition) {
      throw new DnxInvalidDataError(
        `${operationalPattern === "opatom" ? "OPAtom" : "OP1a"} DNx track ${track.id} is not referenced by a resolvable material SourceClip.`
      );
    }

    const { numerator, denominator } = track.editRate;
    return {
      demuxer,
      track,
      packets: packetLocators,
      firstFrameHeader,
      editRate: {
        numerator,
        denominator,
        framesPerSecond: numerator / denominator
      }
    };
  }

  return null;
}

function supportedOperationalPattern(value: string | null): SupportedMxfOperationalPattern | null {
  if (!value?.startsWith("060e2b340401010")) {
    return null;
  }
  if (/^060e2b34040101010d01020101[0-9a-f]{4}00$/.test(value)) {
    return "op1a";
  }
  if (/^060e2b34040101020d01020110[0-9a-f]{4}00$/.test(value)) {
    return "opatom";
  }
  return null;
}

function matches(bytes: Uint8Array, offset: number, pattern: readonly number[]): boolean {
  if (offset + pattern.length > bytes.length) {
    return false;
  }
  return pattern.every((value, index) => bytes[offset + index] === value);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 2 ** 24 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}
