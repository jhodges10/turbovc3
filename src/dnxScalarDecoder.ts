import { DnxBitReader } from "./dnxBitReader.js";
import type { DnxFrameHeader } from "./dnxFrame.js";
import { DnxTypescriptIdctKernel, type DnxIdctKernel } from "./dnxIdctKernel.js";
import type { DnxRowDecoder, DnxRowTableSet } from "./dnxZigRowDecoder.js";
import {
  createDnxFrameLayout,
  parseDnxRowSpans,
  type DnxFrameLayout
} from "./dnxReconstruction.js";
import {
  DNXHD_1235_AC_BITS_COMPLETE,
  DNXHD_1235_AC_CODES,
  DNXHD_1235_AC_INFO,
  DNXHD_1235_CHROMA_WEIGHT,
  DNXHD_1235_DC_BITS,
  DNXHD_1235_DC_CODES,
  DNXHD_1235_LUMA_WEIGHT,
  DNXHD_1235_RUN,
  DNXHD_1235_RUN_BITS,
  DNXHD_1235_RUN_CODES,
  DNXHD_1237_AC_BITS_COMPLETE,
  DNXHD_1237_AC_CODES,
  DNXHD_1237_AC_INFO,
  DNXHD_1237_CHROMA_WEIGHT,
  DNXHD_1237_DC_BITS,
  DNXHD_1237_DC_CODES,
  DNXHD_1237_LUMA_WEIGHT,
  DNXHD_1237_RUN,
  DNXHD_1237_RUN_BITS,
  DNXHD_1237_RUN_CODES,
  DNXHD_1238_AC_BITS_COMPLETE,
  DNXHD_1238_AC_CODES,
  DNXHD_1238_AC_INFO,
  DNXHD_1238_CHROMA_WEIGHT,
  DNXHD_1238_LUMA_WEIGHT,
  DNXHD_1238_RUN,
  DNXHD_1241_CHROMA_WEIGHT,
  DNXHD_1241_LUMA_WEIGHT,
  DNXHD_1250_RUN,
  DNXHD_1250_RUN_BITS,
  DNXHD_1250_RUN_CODES,
  DNXHD_1251_AC_BITS,
  DNXHD_1251_AC_CODES,
  DNXHD_1251_AC_INFO,
  DNXHD_1251_CHROMA_WEIGHT,
  DNXHD_1251_LUMA_WEIGHT
} from "./dnxTables.js";

export interface DnxScalarDecodeResult {
  layout: DnxFrameLayout;
  rowsDecoded: number;
  macroblocksDecoded: number;
}

interface HuffmanEntry {
  code: number;
  bits: number;
  symbol: number;
}

interface HuffmanTable {
  entries: readonly HuffmanEntry[];
  lookup: Int32Array;
  zigLookup: Uint16Array;
}

export interface DnxScalarTableSet extends DnxRowTableSet {
  dcTable: HuffmanTable;
  acTable: HuffmanTable;
  runTable: HuffmanTable;
  acInfo: readonly number[];
  run: readonly number[];
  eobIndex: number;
  indexBits: number;
  levelBias: number;
  levelShift: number;
  lumaWeight: readonly number[];
  chromaWeight: readonly number[];
}

interface RowState {
  bits: DnxBitReader;
  tables: DnxScalarTableSet;
  lastDc: [number, number, number];
  lastQscale: number;
  lumaScale: number[];
  chromaScale: number[];
  dcShift: number;
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63
] as const;

const DC_TABLE_1235 = buildHuffmanTable(DNXHD_1235_DC_CODES, DNXHD_1235_DC_BITS);
const DC_TABLE_1237 = buildHuffmanTable(DNXHD_1237_DC_CODES, DNXHD_1237_DC_BITS);
const TABLE_1235_10BIT: DnxScalarTableSet = {
  dcTable: DC_TABLE_1235,
  acTable: buildHuffmanTable(DNXHD_1235_AC_CODES, DNXHD_1235_AC_BITS_COMPLETE),
  runTable: buildHuffmanTable(DNXHD_1235_RUN_CODES, DNXHD_1235_RUN_BITS),
  acInfo: DNXHD_1235_AC_INFO,
  run: DNXHD_1235_RUN,
  eobIndex: 4,
  indexBits: 6,
  levelBias: 8,
  levelShift: 4,
  lumaWeight: DNXHD_1235_LUMA_WEIGHT,
  chromaWeight: DNXHD_1235_CHROMA_WEIGHT
};
const TABLE_1237_8BIT: DnxScalarTableSet = {
  dcTable: DC_TABLE_1237,
  acTable: buildHuffmanTable(DNXHD_1237_AC_CODES, DNXHD_1237_AC_BITS_COMPLETE),
  runTable: buildHuffmanTable(DNXHD_1237_RUN_CODES, DNXHD_1237_RUN_BITS),
  acInfo: DNXHD_1237_AC_INFO,
  run: DNXHD_1237_RUN,
  eobIndex: 3,
  indexBits: 4,
  levelBias: 32,
  levelShift: 6,
  lumaWeight: DNXHD_1237_LUMA_WEIGHT,
  chromaWeight: DNXHD_1237_CHROMA_WEIGHT
};
const CID_TABLES = new Map<number, DnxScalarTableSet>([
  [1235, TABLE_1235_10BIT],
  [1237, TABLE_1237_8BIT],
  [
    1256,
    {
      ...TABLE_1235_10BIT,
      levelBias: 32,
      levelShift: 6,
      chromaWeight: DNXHD_1235_LUMA_WEIGHT
    }
  ],
  [
    1270,
    {
      ...TABLE_1235_10BIT,
      levelBias: 32,
      levelShift: 6,
      chromaWeight: DNXHD_1235_LUMA_WEIGHT
    }
  ],
  [
    1251,
    {
      dcTable: DC_TABLE_1237,
      acTable: buildHuffmanTable(DNXHD_1251_AC_CODES, DNXHD_1251_AC_BITS),
      runTable: buildHuffmanTable(DNXHD_1250_RUN_CODES, DNXHD_1250_RUN_BITS),
      acInfo: DNXHD_1251_AC_INFO,
      run: DNXHD_1250_RUN,
      eobIndex: 4,
      indexBits: 4,
      levelBias: 32,
      levelShift: 6,
      lumaWeight: DNXHD_1251_LUMA_WEIGHT,
      chromaWeight: DNXHD_1251_CHROMA_WEIGHT
    }
  ],
  [
    1271,
    {
      ...TABLE_1235_10BIT,
      levelBias: 32,
      levelShift: 6,
      lumaWeight: DNXHD_1241_LUMA_WEIGHT,
      chromaWeight: DNXHD_1241_CHROMA_WEIGHT
    }
  ],
  [
    1272,
    {
      dcTable: DC_TABLE_1237,
      acTable: buildHuffmanTable(DNXHD_1238_AC_CODES, DNXHD_1238_AC_BITS_COMPLETE),
      runTable: buildHuffmanTable(DNXHD_1235_RUN_CODES, DNXHD_1235_RUN_BITS),
      acInfo: DNXHD_1238_AC_INFO,
      run: DNXHD_1238_RUN,
      eobIndex: 4,
      indexBits: 4,
      levelBias: 32,
      levelShift: 6,
      lumaWeight: DNXHD_1238_LUMA_WEIGHT,
      chromaWeight: DNXHD_1238_CHROMA_WEIGHT
    }
  ],
  [1273, TABLE_1237_8BIT],
  [1274, TABLE_1237_8BIT]
]);

export function decodeDnxScalarFrame(
  packet: Uint8Array,
  header: DnxFrameHeader,
  idctKernel: DnxIdctKernel = new DnxTypescriptIdctKernel(),
  rowDecoder: DnxRowDecoder | null = null
): DnxScalarDecodeResult {
  const baseTables = CID_TABLES.get(header.cid);
  if (!baseTables || header.interlaced || header.mbaff || (header.is444 && header.bitDepth === 8)) {
    throw new Error("Scalar decode currently supports progressive 8/10/12-bit DNx 4:2:2 and 10/12-bit DNx 4:4:4.");
  }
  const tables = header.bitDepth === 12
    ? { ...baseTables, indexBits: 6, levelBias: header.is444 ? 32 : 8, levelShift: 4 }
    : baseTables;

  const layout = createDnxFrameLayout(header);
  const rows = parseDnxRowSpans(packet, header);
  const blocksPerMacroblock = header.is444 ? 12 : 8;
  const blocksPerRow = header.macroblockWidth * blocksPerMacroblock;
  const rowCoefficients = new Int32Array(blocksPerRow * 64);
  let macroblocksDecoded = 0;

  if (rowDecoder) {
    try {
      const frameBytes = rowDecoder.decodeFrame(
        packet,
        rows,
        header.macroblockWidth,
        header.macroblockHeight,
        header.bitDepth,
        header.is444,
        tables
      );
      new Uint8Array(layout.planes[0].bytes.buffer).set(frameBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`DNx Zig decode failed: ${message}`);
    }
    return {
      layout,
      rowsDecoded: rows.length,
      macroblocksDecoded: rows.length * header.macroblockWidth
    };
  }

  for (const row of rows) {
    rowCoefficients.fill(0);
    const state: RowState = {
      bits: new DnxBitReader(packet.subarray(row.start, row.end)),
      tables,
      lastDc: [1 << (header.bitDepth + 2), 1 << (header.bitDepth + 2), 1 << (header.bitDepth + 2)],
      lastQscale: -1,
      lumaScale: new Array(64).fill(0),
      chromaScale: new Array(64).fill(0),
      dcShift: header.bitDepth === 12 ? 2 : 0
    };

    for (let x = 0; x < header.macroblockWidth; x += 1) {
      try {
        decodeMacroblock(state, rowCoefficients, x, header.is444);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`DNx decode failed at row ${row.row}, macroblock ${x}: ${message}`);
      }
      macroblocksDecoded += 1;
    }
    const samples = idctKernel.transform(rowCoefficients, blocksPerRow, header.bitDepth);

    for (let x = 0; x < header.macroblockWidth; x += 1) {
      putMacroblock(layout, x, row.row, samples, header.is444);
    }
  }

  return {
    layout,
    rowsDecoded: rows.length,
    macroblocksDecoded
  };
}

export function getDnxRowTableSet(cid: number, bitDepth?: 8 | 10 | 12, is444 = false): DnxRowTableSet | null {
  const tables = CID_TABLES.get(cid);
  if (!tables) {
    return null;
  }
  return bitDepth === 12
    ? { ...tables, indexBits: 6, levelBias: is444 ? 32 : 8, levelShift: 4 }
    : tables;
}

export function putDnxDecodedRow(
  layout: DnxFrameLayout,
  macroblockRow: number,
  macroblockWidth: number,
  is444: boolean,
  samples: Uint16Array
): void {
  const expectedSamples = macroblockWidth * (is444 ? 12 : 8) * 64;
  if (samples.length < expectedSamples) {
    throw new Error(`DNx decoded row requires ${expectedSamples} samples, got ${samples.length}.`);
  }
  for (let x = 0; x < macroblockWidth; x += 1) {
    putMacroblock(layout, x, macroblockRow, samples, is444);
  }
}

function decodeMacroblock(state: RowState, rowCoefficients: Int32Array, mbX: number, is444: boolean): void {
  const qscale = state.bits.readBits(11);
  const act = state.bits.readBits(1);
  if (qscale === null || act === null) {
    throw new Error("Unexpected end of DNx macroblock header.");
  }
  if (act && !is444) {
    throw new Error("ACT macroblocks are not supported for scalar DNxHD 4:2:2 decode.");
  }

  if (qscale !== state.lastQscale) {
    for (let index = 0; index < 64; index += 1) {
      state.lumaScale[index] = qscale * state.tables.lumaWeight[index];
      state.chromaScale[index] = qscale * state.tables.chromaWeight[index];
    }
    state.lastQscale = qscale;
  }

  const blocksPerMacroblock = is444 ? 12 : 8;
  const firstBlock = mbX * blocksPerMacroblock;
  for (let blockIndex = 0; blockIndex < blocksPerMacroblock; blockIndex += 1) {
    try {
      const blockOffset = (firstBlock + blockIndex) * 64;
      decodeDctBlock(state, blockIndex, rowCoefficients, blockOffset, is444);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`block ${blockIndex}: ${message}`);
    }
  }
}

function decodeDctBlock(
  state: RowState,
  blockIndex: number,
  coefficients: Int32Array,
  blockOffset: number,
  is444: boolean
): void {
  const component = is444 ? (blockIndex >> 1) % 3 : blockIndex & 2 ? 1 + (blockIndex & 1) : 0;
  const scale = component === 0 ? state.lumaScale : state.chromaScale;
  const weight = component === 0 ? state.tables.lumaWeight : state.tables.chromaWeight;

  const dcLen = readHuffmanSymbol(state.bits, state.tables.dcTable);
  if (dcLen === null) {
    throw new Error("Invalid DNx DC VLC.");
  }

  if (dcLen > 0) {
    const deltaBits = state.bits.readBits(dcLen);
    if (deltaBits === null) {
      throw new Error("Unexpected end of DNx DC delta.");
    }
    state.lastDc[component] += decodeDnxDcDelta(deltaBits, dcLen) * (1 << state.dcShift);
  }
  coefficients[blockOffset] = state.lastDc[component];

  let coefficientIndex = 0;
  let acIndex = readHuffmanSymbol(state.bits, state.tables.acTable);
  while (acIndex !== null && acIndex !== state.tables.eobIndex) {
    const levelBase = state.tables.acInfo[2 * acIndex];
    const flags = state.tables.acInfo[2 * acIndex + 1];
    const signBit = state.bits.readBits(1);
    if (signBit === null) {
      throw new Error("Unexpected end of DNx AC sign.");
    }

    let level = levelBase;
    if (flags & 1) {
      const extra = state.bits.readBits(state.tables.indexBits);
      if (extra === null) {
        throw new Error("Unexpected end of DNx AC level.");
      }
      level += extra << 7;
    }

    if (flags & 2) {
      const runSymbol = readHuffmanSymbol(state.bits, state.tables.runTable);
      if (runSymbol === null) {
        throw new Error("Invalid DNx run VLC.");
      }
      coefficientIndex += state.tables.run[runSymbol];
    }

    coefficientIndex += 1;
    if (coefficientIndex > 63) {
      throw new Error("DNx AC coefficients overrun the block.");
    }

    const naturalIndex = ZIGZAG[coefficientIndex];
    let value = level * scale[coefficientIndex];
    value += scale[coefficientIndex] >> 1;
    if (state.tables.levelBias < 32 || weight[coefficientIndex] !== state.tables.levelBias) {
      value += state.tables.levelBias;
    }
    value >>= state.tables.levelShift;
    coefficients[blockOffset + naturalIndex] = signBit ? -value : value;

    acIndex = readHuffmanSymbol(state.bits, state.tables.acTable);
  }

  if (acIndex === null) {
    throw new Error("Invalid DNx AC VLC.");
  }
}

function readHuffmanSymbol(bits: DnxBitReader, table: HuffmanTable): number | null {
  if (bits.bitsRemaining >= 16) {
    const prefix = bits.peek16();
    const packed = prefix === null ? 0 : table.lookup[prefix];
    if (packed !== 0) {
      bits.skipBits(packed >>> 16);
      return (packed & 0xffff) - 1;
    }
  }

  for (const entry of table.entries) {
    const value = bits.peekBits(entry.bits);
    if (value === entry.code) {
      bits.skipBits(entry.bits);
      return entry.symbol;
    }
  }

  return null;
}

function decodeDnxDcDelta(value: number, bitLength: number): number {
  const positiveThreshold = 1 << (bitLength - 1);
  return value < positiveThreshold ? value - ((1 << bitLength) - 1) : value;
}

function putMacroblock(
  layout: DnxFrameLayout,
  mbX: number,
  mbY: number,
  rowSamples: Uint16Array,
  is444: boolean
): void {
  if (is444) {
    const firstBlock = mbX * 12;
    for (let plane = 0; plane < 3; plane += 1) {
      const top = firstBlock + plane * 2;
      const bottom = firstBlock + 6 + plane * 2;
      putLayoutBlock(layout, plane, mbX * 16, mbY * 16, rowSamples, top);
      putLayoutBlock(layout, plane, mbX * 16 + 8, mbY * 16, rowSamples, top + 1);
      putLayoutBlock(layout, plane, mbX * 16, mbY * 16 + 8, rowSamples, bottom);
      putLayoutBlock(layout, plane, mbX * 16 + 8, mbY * 16 + 8, rowSamples, bottom + 1);
    }
    return;
  }

  const firstBlock = mbX * 8;
  putLayoutBlock(layout, 0, mbX * 16, mbY * 16, rowSamples, firstBlock + 0);
  putLayoutBlock(layout, 0, mbX * 16 + 8, mbY * 16, rowSamples, firstBlock + 1);
  putLayoutBlock(layout, 0, mbX * 16, mbY * 16 + 8, rowSamples, firstBlock + 4);
  putLayoutBlock(layout, 0, mbX * 16 + 8, mbY * 16 + 8, rowSamples, firstBlock + 5);
  putLayoutBlock(layout, 1, mbX * 8, mbY * 16, rowSamples, firstBlock + 2);
  putLayoutBlock(layout, 2, mbX * 8, mbY * 16, rowSamples, firstBlock + 3);
  putLayoutBlock(layout, 1, mbX * 8, mbY * 16 + 8, rowSamples, firstBlock + 6);
  putLayoutBlock(layout, 2, mbX * 8, mbY * 16 + 8, rowSamples, firstBlock + 7);
}

function putLayoutBlock(
  layout: DnxFrameLayout,
  planeIndex: number,
  x: number,
  y: number,
  samples: Uint16Array,
  blockIndex: number
): void {
  const plane = layout.planes[planeIndex];
  putBlock(plane.bytes, plane.stride, layout.bytesPerSample, x, y, samples, blockIndex * 64);
}

function putBlock(
  target: Uint8Array,
  stride: number,
  bytesPerSample: 1 | 2,
  x: number,
  y: number,
  samples: Uint16Array,
  sampleOffset: number
): void {
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      const sample = samples[sampleOffset + row * 8 + column];
      if (bytesPerSample === 1) {
        target[(y + row) * stride + x + column] = sample;
      } else {
        const offset = (y + row) * stride + (x + column) * 2;
        target[offset] = sample & 0xff;
        target[offset + 1] = sample >> 8;
      }
    }
  }
}

function buildHuffmanTable(codes: readonly number[], bits: readonly number[]): HuffmanTable {
  if (codes.length !== bits.length) {
    throw new Error(
      `Invalid DNx Huffman table: ${codes.length} codes require ${codes.length} bit lengths, got ${bits.length}.`
    );
  }

  const entries = codes
    .map((code, symbol) => ({ code, bits: bits[symbol], symbol }))
    .filter((entry) => entry.bits > 0)
    .sort((left, right) => left.bits - right.bits);
  const lookup = new Int32Array(1 << 16);
  const zigLookup = new Uint16Array(1 << 16);
  for (const entry of entries) {
    const suffixBits = 16 - entry.bits;
    const start = entry.code << suffixBits;
    const end = start + (1 << suffixBits);
    const packed = (entry.bits << 16) | (entry.symbol + 1);
    const zigPacked = ((entry.bits - 1) << 12) | (entry.symbol + 1);
    lookup.fill(packed, start, end);
    zigLookup.fill(zigPacked, start, end);
  }

  return { entries, lookup, zigLookup };
}
