import type { DecodePlane } from "./core/codec.js";
import { DnxBitReader } from "./dnxBitReader.js";
import type { DnxFrameHeader } from "./dnxFrame.js";

export interface DnxRowSpan {
  row: number;
  start: number;
  end: number;
  byteLength: number;
}

export interface DnxMacroblockHeader {
  qscale: number;
  act: boolean;
  interlaced: boolean;
  bitsRead: number;
}

export interface DnxFrameLayout {
  codedWidth: number;
  codedHeight: number;
  visibleWidth: number;
  visibleHeight: number;
  chromaWidth: number;
  chromaHeight: number;
  bytesPerSample: 1 | 2;
  planes: readonly DecodePlane[];
}

export interface DnxReconstructionState {
  layout: DnxFrameLayout;
  rows: readonly DnxRowSpan[];
  firstMacroblock: DnxMacroblockHeader | null;
  nextStep: "coefficient-vlc";
}

export function analyzeDnxPixelReconstruction(packet: Uint8Array, header: DnxFrameHeader): DnxReconstructionState {
  const rows = parseDnxRowSpans(packet, header);
  return {
    layout: createDnxFrameLayout(header),
    rows,
    firstMacroblock: rows[0] ? readMacroblockHeader(packet.subarray(rows[0].start, rows[0].end), header) : null,
    nextStep: "coefficient-vlc"
  };
}

export function dnxFrameByteLength(header: DnxFrameHeader): number {
  const codedWidth = Math.ceil(header.width / 16) * 16;
  const codedHeight = Math.ceil(header.height / 16) * 16;
  const chromaWidth = header.is444 ? codedWidth : codedWidth / 2;
  const bytesPerSample = header.bitDepth === 8 ? 1 : 2;
  const yByteLength = codedWidth * codedHeight * bytesPerSample;
  const chromaByteLength = chromaWidth * codedHeight * bytesPerSample;
  return yByteLength + 2 * chromaByteLength;
}

export function createDnxFrameLayout(
  header: DnxFrameHeader,
  backingBuffer?: ArrayBufferLike
): DnxFrameLayout {
  const codedWidth = Math.ceil(header.width / 16) * 16;
  const codedHeight = Math.ceil(header.height / 16) * 16;
  const chromaWidth = header.is444 ? codedWidth : codedWidth / 2;
  const chromaHeight = codedHeight;
  const bytesPerSample = header.bitDepth === 8 ? 1 : 2;
  const yByteLength = codedWidth * codedHeight * bytesPerSample;
  const chromaByteLength = chromaWidth * chromaHeight * bytesPerSample;
  const byteLength = yByteLength + 2 * chromaByteLength;
  if (backingBuffer && backingBuffer.byteLength < byteLength) {
    throw new Error(`DNx frame buffer requires ${byteLength} bytes, got ${backingBuffer.byteLength}.`);
  }
  const frameBytes = new Uint8Array(backingBuffer ?? new ArrayBuffer(byteLength), 0, byteLength);

  const planeLabels = header.pixelFormat.startsWith("gbrp") ? ["G", "B", "R"] : ["Y", "Cb", "Cr"];
  const y = createPlane(
    planeLabels[0],
    codedWidth,
    codedHeight,
    codedWidth * bytesPerSample,
    frameBytes.subarray(0, yByteLength)
  );
  const cb = createPlane(
    planeLabels[1],
    chromaWidth,
    chromaHeight,
    chromaWidth * bytesPerSample,
    frameBytes.subarray(yByteLength, yByteLength + chromaByteLength)
  );
  const cr = createPlane(
    planeLabels[2],
    chromaWidth,
    chromaHeight,
    chromaWidth * bytesPerSample,
    frameBytes.subarray(yByteLength + chromaByteLength)
  );

  return {
    codedWidth,
    codedHeight,
    visibleWidth: header.width,
    visibleHeight: header.height,
    chromaWidth,
    chromaHeight,
    bytesPerSample,
    planes: [y, cb, cr]
  };
}

export function parseDnxRowSpans(packet: Uint8Array, header: DnxFrameHeader): DnxRowSpan[] {
  const payloadLength = packet.length - header.dataOffset;
  if (payloadLength <= 0) {
    throw new Error("DNx packet does not contain macroblock payload bytes.");
  }

  const rows: DnxRowSpan[] = [];
  let previous = 0;
  for (let row = 0; row < header.macroblockHeight; row += 1) {
    const scanOffset = 0x170 + row * 4;
    if (scanOffset + 4 > packet.length) {
      throw new Error(`DNx row scan index ${row} is outside the packet.`);
    }

    const relativeStart = readU32BE(packet, scanOffset);
    if (relativeStart < previous) {
      throw new Error(`DNx row scan index ${row} is not monotonic.`);
    }
    if (relativeStart > payloadLength) {
      throw new Error(`DNx row scan index ${row} points outside the macroblock payload.`);
    }

    const nextScanOffset = 0x170 + (row + 1) * 4;
    const relativeEnd =
      row + 1 < header.macroblockHeight && nextScanOffset + 4 <= packet.length
        ? readU32BE(packet, nextScanOffset)
        : payloadLength;

    if (relativeEnd < relativeStart || relativeEnd > payloadLength) {
      throw new Error(`DNx row scan span ${row} is invalid.`);
    }

    rows.push({
      row,
      start: header.dataOffset + relativeStart,
      end: header.dataOffset + relativeEnd,
      byteLength: relativeEnd - relativeStart
    });
    previous = relativeStart;
  }

  return rows;
}

export function readMacroblockHeader(rowBytes: Uint8Array, header: DnxFrameHeader): DnxMacroblockHeader | null {
  const bits = new DnxBitReader(rowBytes);
  const interlaced = header.mbaff ? bits.readBits(1) : 0;
  const qscale = bits.readBits(header.mbaff ? 10 : 11);
  const act = bits.readBits(1);

  if (interlaced === null || qscale === null || act === null) {
    return null;
  }

  return {
    qscale,
    act: act === 1,
    interlaced: interlaced === 1,
    bitsRead: bits.bitsRead
  };
}

function createPlane(
  label: string,
  width: number,
  height: number,
  stride: number,
  bytes: Uint8Array
): DecodePlane {
  return {
    label,
    width,
    height,
    stride,
    bytes
  };
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 2 ** 24 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}
