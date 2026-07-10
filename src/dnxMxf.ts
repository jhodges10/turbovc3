import { MxfDemuxer, type MxfTrack } from "./mxf/index.js";
import { parseDnxFrameHeader, type DnxFramePacket } from "./dnxFrame";

export interface DnxMxfEditRate {
  numerator: number;
  denominator: number;
  framesPerSecond: number;
}

export interface DnxMxfDemuxResult {
  demuxer: MxfDemuxer;
  track: MxfTrack;
  packets: readonly DnxFramePacket[];
  editRate: DnxMxfEditRate;
}

const MXF_KEY_PREFIX = [0x06, 0x0e, 0x2b, 0x34] as const;
const SAMPLE_RATE_TAG = [0x4b, 0x01, 0x00, 0x08] as const;
const HEADER_SCAN_LIMIT = 2 * 1024 * 1024;

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

export async function demuxDnxMxf(bytes: Uint8Array): Promise<DnxMxfDemuxResult | null> {
  if (!isMxfFile(bytes)) {
    return null;
  }

  const demuxer = await MxfDemuxer.open(bytes);
  for (const track of demuxer.tracks) {
    if (track.kind !== "video") {
      continue;
    }
    const packetLocators = demuxer.packetsForTrack(track);
    if (packetLocators.length === 0) {
      continue;
    }
    const firstBytes = await demuxer.readPacket(packetLocators[0]);
    if (!parseDnxFrameHeader(firstBytes)) {
      continue;
    }

    const packets: DnxFramePacket[] = [];
    for (const locator of packetLocators) {
      const packetBytes = await demuxer.readPacket(locator);
      const header = parseDnxFrameHeader(packetBytes);
      if (!header) {
        throw new Error(`MXF DNx packet ${locator.index} does not contain a valid frame header.`);
      }
      packets.push({ offset: locator.byteOffset, bytes: packetBytes, header });
    }
    const { numerator, denominator } = track.editRate;
    return {
      demuxer,
      track,
      packets,
      editRate: {
        numerator,
        denominator,
        framesPerSecond: numerator / denominator
      }
    };
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
