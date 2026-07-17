import { hex, readI64BE, readU16BE, readU32BE, readU64BE, safeNumber, signedByte, utf16Be } from "./mxfBinary.js";
import { MxfCountingSource, toMxfSource, type MxfSource, type MxfSourceInput } from "./mxfSource.js";
import type {
  MxfDemuxResult,
  MxfDescriptor,
  MxfEssenceElement,
  MxfIndexEntry,
  MxfIndexTableSegment,
  MxfKlvPacket,
  MxfLocalSetItem,
  MxfMetadataSet,
  MxfPacket,
  MxfPartition,
  MxfPartitionKind,
  MxfRandomIndexEntry,
  MxfRational,
  MxfTimecode,
  MxfTimecodeTrack,
  MxfTrack,
  MxfTrackKind
} from "./mxfTypes.js";

const KLV_PREFIX = [0x06, 0x0e, 0x2b, 0x34] as const;
const PARTITION_PREFIX = "060e2b34020501010d01020101";
const PRIMER_KEY = "060e2b34020501010d01020101050100";
const RANDOM_INDEX_KEY = "060e2b34020501010d01020101110100";
const INDEX_TABLE_KEY = "060e2b34025301010d01020101100100";
const GENERIC_ESSENCE_PREFIX = "060e2b34010201010d010301";
const AVID_ESSENCE_PREFIX = "060e2b34010201010e040301";
const CANOPUS_ESSENCE_PREFIX = "060e2b340102010a0e0f0301";
const RESYNC_CHUNK_BYTES = 64 * 1024;

const METADATA_TYPES = new Map<string, string>([
  ["060e2b34025301010d01010101012f00", "Preface"],
  ["060e2b34025301010d01010101013000", "Identification"],
  ["060e2b34025301010d01010101011800", "ContentStorage"],
  ["060e2b34025301010d01010101013700", "SourcePackage"],
  ["060e2b34025301010d01010101013600", "MaterialPackage"],
  ["060e2b34025301010d01010101010f00", "Sequence"],
  ["060e2b34025301010d01010101011100", "SourceClip"],
  ["060e2b34025301010d01010101014400", "MultipleDescriptor"],
  ["060e2b34025301010d01010101014200", "GenericSoundDescriptor"],
  ["060e2b34025301010d01010101012800", "CDCIDescriptor"],
  ["060e2b34025301010d01010101012900", "RGBADescriptor"],
  ["060e2b34025301010d01010101014800", "WaveAudioDescriptor"],
  ["060e2b34025301010d01010101014700", "AES3AudioDescriptor"],
  ["060e2b34025301010d01010101015100", "MpegVideoDescriptor"],
  ["060e2b34025301010d01010101013a00", "StaticTrack"],
  ["060e2b34025301010d01010101013b00", "Track"],
  ["060e2b34025301010d01010101011400", "TimecodeComponent"],
  ["060e2b34025301010d01010101012300", "EssenceContainerData"],
  [INDEX_TABLE_KEY, "IndexTableSegment"]
]);

export interface MxfDemuxOptions {
  signal?: AbortSignal;
  onProgress?(progress: MxfDemuxProgress): void;
  limits?: Partial<MxfDemuxLimits>;
}

export interface MxfDemuxLimits {
  maxMetadataValueBytes: number;
  maxMetadataSets: number;
  maxKlvPackets: number;
  maxTracks: number;
  maxPackets: number;
  maxResyncBytes: number;
  maxWidth: number;
  maxHeight: number;
  maxFramePixels: number;
}

const DEFAULT_LIMITS: MxfDemuxLimits = {
  maxMetadataValueBytes: 64 * 1024 * 1024,
  maxMetadataSets: 100_000,
  maxKlvPackets: 2_000_000,
  maxTracks: 1_024,
  maxPackets: 2_000_000,
  maxResyncBytes: 16 * 1024 * 1024,
  maxWidth: 16_384,
  maxHeight: 16_384,
  maxFramePixels: 268_435_456
};

export interface MxfDemuxProgress {
  phase: "indexing";
  offset: number;
  totalBytes: number;
  bytesRead: number;
}

export class MxfDemuxer {
  readonly result: MxfDemuxResult;

  private constructor(result: MxfDemuxResult) {
    this.result = result;
  }

  static async open(input: MxfSourceInput, options: MxfDemuxOptions = {}): Promise<MxfDemuxer> {
    const source = new MxfCountingSource(toMxfSource(input));
    return new MxfDemuxer(await demuxMxfSource(source, options));
  }

  get tracks(): readonly MxfTrack[] {
    return this.result.tracks;
  }

  get packets(): readonly MxfPacket[] {
    return this.result.packets;
  }

  get timecodeTracks(): readonly MxfTimecodeTrack[] {
    return this.result.timecodeTracks;
  }

  timecodeAt(track: MxfTimecodeTrack, editUnit: number): MxfTimecode {
    return mxfTimecodeAtEditUnit(track, editUnit);
  }

  packetsForTrack(track: MxfTrack | number): readonly MxfPacket[] {
    const trackNumber = typeof track === "number" ? track : track.number;
    return this.result.packets.filter((packet) => packet.track.number === trackNumber);
  }

  get bytesRead(): number {
    return this.result.source instanceof MxfCountingSource ? this.result.source.bytesRead : 0;
  }

  async readPacket(packet: MxfPacket, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    return this.result.source.read(packet.byteOffset, packet.byteLength, options);
  }
}

export async function demuxMxf(input: MxfSourceInput, options: MxfDemuxOptions = {}): Promise<MxfDemuxResult> {
  return demuxMxfSource(new MxfCountingSource(toMxfSource(input)), options);
}

async function demuxMxfSource(source: MxfSource, options: MxfDemuxOptions): Promise<MxfDemuxResult> {
  const limits = resolveLimits(options.limits);
  const partitions: MxfPartition[] = [];
  const klvPackets: MxfKlvPacket[] = [];
  const primer = new Map<number, string>();
  const metadataSets: MxfMetadataSet[] = [];
  const essenceElements: MxfEssenceElement[] = [];
  const indexTableSegments: MxfIndexTableSegment[] = [];
  let randomIndex: MxfRandomIndexEntry[] = [];
  let operationalPattern: string | null = null;
  let currentBodySid = 0;
  let offset = 0;
  reportProgress(options, source, offset);

  while (offset + 17 <= source.size) {
    throwIfAborted(options.signal);
    const klv = await readKlvAt(source, offset);
    if (!klv) {
      const next = await findNextKlv(source, offset + 1, limits.maxResyncBytes);
      if (next === null) {
        break;
      }
      offset = next;
      reportProgress(options, source, offset);
      continue;
    }
    klvPackets.push(klv);
    enforceCount("KLV packets", klvPackets.length, limits.maxKlvPackets);

    if (isPartitionKey(klv)) {
      const partition = await parsePartition(source, klv);
      partitions.push(partition);
      currentBodySid = partition.bodySid;
      operationalPattern ??= partition.operationalPattern;
    } else if (klv.keyHex === PRIMER_KEY) {
      for (const [tag, propertyUl] of await parsePrimer(source, klv, limits.maxMetadataValueBytes)) {
        primer.set(tag, propertyUl);
      }
    } else if (isEssenceKey(klv.keyHex)) {
      const trackNumber = readU32BE(klv.key, 12);
      essenceElements.push({
        index: essenceElements.length,
        trackNumber,
        trackNumberHex: trackNumber.toString(16).padStart(8, "0"),
        itemType: klv.key[12],
        elementCount: klv.key[13],
        elementType: klv.key[14],
        elementNumber: klv.key[15],
        bodySid: currentBodySid,
        klv
      });
    } else if (klv.keyHex === RANDOM_INDEX_KEY) {
      randomIndex = await parseRandomIndex(source, klv, limits.maxMetadataValueBytes);
    } else {
      const metadataType = METADATA_TYPES.get(klv.keyHex);
      if (metadataType) {
        const set = await parseMetadataSet(source, klv, metadataType, primer, limits.maxMetadataValueBytes);
        metadataSets.push(set);
        enforceCount("metadata sets", metadataSets.length, limits.maxMetadataSets);
        if (klv.keyHex === INDEX_TABLE_KEY) {
          indexTableSegments.push(parseIndexTable(set));
        }
      }
    }

    offset = klv.nextOffset;
    reportProgress(options, source, offset);
  }

  const descriptors = metadataSets
    .filter((set) => set.type.endsWith("Descriptor"))
    .map(parseDescriptor);
  for (const descriptor of descriptors) {
    enforceDimensions(descriptor, limits);
  }
  const tracks = buildTracks(metadataSets, descriptors, essenceElements);
  const timecodeTracks = buildTimecodeTracks(metadataSets);
  enforceCount("tracks", tracks.length + timecodeTracks.length, limits.maxTracks);
  const packets = buildPackets(tracks, essenceElements, indexTableSegments);
  enforceCount("packets", packets.length, limits.maxPackets);
  for (const track of tracks) {
    track.packetCount = packets.filter((packet) => packet.track.number === track.number).length;
  }
  for (const entry of randomIndex) {
    if (entry.byteOffset < 0 || entry.byteOffset >= source.size) {
      throw new Error(
        `MXF random index byte offset ${entry.byteOffset} is outside the ${source.size}-byte source.`
      );
    }
  }
  validateMxfStructure(partitions, indexTableSegments, randomIndex);

  return {
    source,
    operationalPattern,
    klvPackets,
    partitions,
    primer,
    metadataSets,
    descriptors,
    tracks,
    timecodeTracks,
    essenceElements,
    indexTableSegments,
    randomIndex,
    packets
  };
}

export function mxfTimecodeAtEditUnit(track: MxfTimecodeTrack, editUnit: number): MxfTimecode {
  if (!Number.isSafeInteger(editUnit)) {
    throw new RangeError("MXF timecode edit unit must be a safe integer.");
  }
  const base = track.roundedTimecodeBase;
  if (!Number.isSafeInteger(base) || base < 1) {
    throw new RangeError("MXF rounded timecode base must be a positive safe integer.");
  }
  if (track.dropFrame && base !== 30 && base !== 60) {
    throw new RangeError(`Drop-frame MXF timecode requires a base of 30 or 60, received ${base}.`);
  }

  const frameNumber = track.startTimecode + track.origin + editUnit;
  if (!Number.isSafeInteger(frameNumber)) {
    throw new RangeError("MXF timecode frame number exceeds JavaScript's safe integer range.");
  }
  const droppedPerMinute = track.dropFrame ? (base === 60 ? 4 : 2) : 0;
  const framesPer10Minutes = base * 60 * 10 - droppedPerMinute * 9;
  const framesPer24Hours = track.dropFrame ? framesPer10Minutes * 6 * 24 : base * 60 * 60 * 24;
  let displayFrame = ((frameNumber % framesPer24Hours) + framesPer24Hours) % framesPer24Hours;
  if (track.dropFrame) {
    const framesPerDropMinute = base * 60 - droppedPerMinute;
    const tenMinuteBlocks = Math.floor(displayFrame / framesPer10Minutes);
    const remainder = displayFrame % framesPer10Minutes;
    displayFrame += droppedPerMinute * 9 * tenMinuteBlocks;
    if (remainder >= droppedPerMinute) {
      displayFrame += droppedPerMinute * Math.floor((remainder - droppedPerMinute) / framesPerDropMinute);
    }
  }

  const hours = Math.floor(displayFrame / (base * 60 * 60));
  const minutes = Math.floor(displayFrame / (base * 60)) % 60;
  const seconds = Math.floor(displayFrame / base) % 60;
  const frames = displayFrame % base;
  const separator = track.dropFrame ? ";" : ":";
  const pad = (value: number) => value.toString().padStart(2, "0");
  return {
    frameNumber,
    hours,
    minutes,
    seconds,
    frames,
    dropFrame: track.dropFrame,
    formatted: `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(frames)}`
  };
}

function validateMxfStructure(
  partitions: readonly MxfPartition[],
  indexes: readonly MxfIndexTableSegment[],
  randomIndex: readonly MxfRandomIndexEntry[]
): void {
  if (partitions.length === 0) {
    if (indexes.length > 0 || randomIndex.length > 0) {
      throw new Error("MXF index metadata has no partition pack.");
    }
    return;
  }

  const byOffset = new Map(partitions.map((partition) => [partition.offset, partition]));
  const footerOffsets = new Set(
    partitions.filter((partition) => partition.kind === "footer").map((partition) => partition.offset)
  );
  for (let index = 0; index < partitions.length; index += 1) {
    const partition = partitions[index];
    if (partition.thisPartition !== partition.offset) {
      throw new Error(
        `MXF ${partition.kind} partition at ${partition.offset} declares ThisPartition ${partition.thisPartition}.`
      );
    }
    if (index > 0 && partition.previousPartition !== partitions[index - 1].offset) {
      throw new Error(
        `MXF partition at ${partition.offset} links PreviousPartition ${partition.previousPartition}, expected ${partitions[index - 1].offset}.`
      );
    }
    if (partition.footerPartition !== 0 && !footerOffsets.has(partition.footerPartition)) {
      throw new Error(
        `MXF partition at ${partition.offset} links FooterPartition ${partition.footerPartition}, which is not a parsed footer.`
      );
    }
    if (partition.kagSize > 1 && partition.offset % partition.kagSize !== 0) {
      throw new Error(
        `MXF partition at ${partition.offset} is not aligned to its ${partition.kagSize}-byte KAG.`
      );
    }
  }

  if (randomIndex.length > 0) {
    const ripOffsets = new Set<number>();
    for (const entry of randomIndex) {
      const partition = byOffset.get(entry.byteOffset);
      if (!partition) {
        throw new Error(`MXF random index offset ${entry.byteOffset} does not reference a parsed partition.`);
      }
      if (entry.bodySid !== partition.bodySid) {
        throw new Error(
          `MXF random index BodySID ${entry.bodySid} does not match partition ${entry.byteOffset} BodySID ${partition.bodySid}.`
        );
      }
      if (ripOffsets.has(entry.byteOffset)) {
        throw new Error(`MXF random index repeats partition offset ${entry.byteOffset}.`);
      }
      ripOffsets.add(entry.byteOffset);
    }
    for (const partition of partitions) {
      if (!ripOffsets.has(partition.offset)) {
        throw new Error(`MXF random index omits partition offset ${partition.offset}.`);
      }
    }
  }

  const bodySids = new Set(partitions.map((partition) => partition.bodySid).filter((sid) => sid !== 0));
  for (const segment of indexes) {
    let owner: MxfPartition | undefined;
    for (const partition of partitions) {
      if (partition.offset > segment.offset) {
        break;
      }
      owner = partition;
    }
    if (!owner) {
      throw new Error(`MXF index table at ${segment.offset} has no owning partition.`);
    }
    if (segment.indexSid === 0 || segment.indexSid !== owner.indexSid) {
      throw new Error(
        `MXF index table at ${segment.offset} uses IndexSID ${segment.indexSid}, but its partition uses ${owner.indexSid}.`
      );
    }
    if (segment.bodySid === 0 || !bodySids.has(segment.bodySid)) {
      throw new Error(`MXF index table at ${segment.offset} references unknown BodySID ${segment.bodySid}.`);
    }
  }
}

function reportProgress(options: MxfDemuxOptions, source: MxfSource, offset: number): void {
  options.onProgress?.({
    phase: "indexing",
    offset: Math.min(offset, source.size),
    totalBytes: source.size,
    bytesRead: source instanceof MxfCountingSource ? source.bytesRead : 0
  });
}

async function readKlvAt(source: MxfSource, offset: number): Promise<MxfKlvPacket | null> {
  const available = Math.min(25, source.size - offset);
  if (available < 17) {
    return null;
  }
  const header = await source.read(offset, available);
  if (!matchesPrefix(header, 0, KLV_PREFIX)) {
    return null;
  }

  const firstLengthByte = header[16];
  const longForm = (firstLengthByte & 0x80) !== 0;
  const lengthBytes = longForm ? firstLengthByte & 0x7f : 0;
  if (longForm && lengthBytes === 0) {
    throw new Error(`MXF KLV at ${offset} uses the unsupported indefinite BER length form.`);
  }
  if (longForm && lengthBytes > 8) {
    throw new Error(`MXF KLV at ${offset} uses an invalid ${lengthBytes}-byte BER length.`);
  }
  if (longForm && 17 + lengthBytes > header.length) {
    throw new Error(`MXF KLV at ${offset} has a truncated BER length field.`);
  }
  const lengthFieldLength = longForm ? 1 + lengthBytes : 1;
  let valueLength = BigInt(longForm ? 0 : firstLengthByte);
  for (let index = 0; index < lengthBytes; index += 1) {
    valueLength = (valueLength << 8n) | BigInt(header[17 + index]);
  }
  const numericLength = safeNumber(valueLength);
  const valueOffset = offset + 16 + lengthFieldLength;
  const nextOffset = valueOffset + numericLength;
  if (nextOffset > source.size) {
    throw new Error(`MXF KLV at ${offset} extends beyond the ${source.size}-byte source.`);
  }
  const key = header.slice(0, 16);
  return {
    offset,
    key,
    keyHex: hex(key),
    lengthFieldLength,
    valueOffset,
    valueLength: numericLength,
    nextOffset
  };
}

async function findNextKlv(source: MxfSource, start: number, maxResyncBytes: number): Promise<number | null> {
  let offset = start;
  const limit = Math.min(source.size, start + maxResyncBytes);
  while (offset + KLV_PREFIX.length <= limit) {
    const length = Math.min(RESYNC_CHUNK_BYTES, limit - offset);
    const bytes = await source.read(offset, length);
    for (let index = 0; index <= bytes.length - KLV_PREFIX.length; index += 1) {
      if (matchesPrefix(bytes, index, KLV_PREFIX)) {
        return offset + index;
      }
    }
    if (length <= KLV_PREFIX.length) {
      break;
    }
    offset += length - (KLV_PREFIX.length - 1);
  }
  if (limit < source.size) {
    throw new Error(`MXF resynchronization exceeded the ${maxResyncBytes}-byte limit at offset ${start}.`);
  }
  return null;
}

async function parsePartition(source: MxfSource, klv: MxfKlvPacket): Promise<MxfPartition> {
  if (klv.valueLength < 80) {
    throw new Error(`MXF partition pack at ${klv.offset} is only ${klv.valueLength} bytes.`);
  }
  const bytes = await source.read(klv.valueOffset, Math.min(klv.valueLength, 88));
  const essenceContainers: string[] = [];
  if (bytes.length >= 88) {
    const count = readU32BE(bytes, 80);
    const itemLength = readU32BE(bytes, 84);
    if (itemLength === 16 && klv.valueLength >= 88 + count * itemLength) {
      const containerBytes = await source.read(klv.valueOffset + 88, count * itemLength);
      for (let index = 0; index < count; index += 1) {
        essenceContainers.push(hex(containerBytes.subarray(index * 16, index * 16 + 16)));
      }
    }
  }
  return {
    kind: partitionKind(klv.key[13]),
    status: klv.key[14],
    offset: klv.offset,
    majorVersion: readU16BE(bytes, 0),
    minorVersion: readU16BE(bytes, 2),
    kagSize: readU32BE(bytes, 4),
    thisPartition: safeNumber(readU64BE(bytes, 8)),
    previousPartition: safeNumber(readU64BE(bytes, 16)),
    footerPartition: safeNumber(readU64BE(bytes, 24)),
    headerByteCount: safeNumber(readU64BE(bytes, 32)),
    indexByteCount: safeNumber(readU64BE(bytes, 40)),
    indexSid: readU32BE(bytes, 48),
    bodyOffset: safeNumber(readU64BE(bytes, 52)),
    bodySid: readU32BE(bytes, 60),
    operationalPattern: hex(bytes.subarray(64, 80)),
    essenceContainers
  };
}

async function parsePrimer(
  source: MxfSource,
  klv: MxfKlvPacket,
  maxMetadataValueBytes: number
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const bytes = await readMetadataValue(source, klv, maxMetadataValueBytes);
  if (bytes.length < 8) {
    return result;
  }
  const count = readU32BE(bytes, 0);
  const itemLength = readU32BE(bytes, 4);
  if (itemLength < 18 || 8 + count * itemLength > bytes.length) {
    throw new Error(`Invalid MXF primer pack at ${klv.offset}.`);
  }
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * itemLength;
    result.set(readU16BE(bytes, offset), hex(bytes.subarray(offset + 2, offset + 18)));
  }
  return result;
}

async function parseMetadataSet(
  source: MxfSource,
  klv: MxfKlvPacket,
  type: string,
  primer: ReadonlyMap<number, string>,
  maxMetadataValueBytes: number
): Promise<MxfMetadataSet> {
  const bytes = await readMetadataValue(source, klv, maxMetadataValueBytes);
  const items: MxfLocalSetItem[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const localTag = readU16BE(bytes, offset);
    const length = readU16BE(bytes, offset + 2);
    offset += 4;
    if (offset + length > bytes.length) {
      throw new Error(`MXF local tag ${localTag.toString(16)} overruns ${type} at ${klv.offset}.`);
    }
    items.push({
      localTag,
      propertyUl: primer.get(localTag) ?? null,
      value: bytes.slice(offset, offset + length)
    });
    offset += length;
  }
  if (offset !== bytes.length) {
    throw new Error(`MXF ${type} local set at ${klv.offset} has ${bytes.length - offset} trailing bytes.`);
  }
  const instanceUid = item(items, 0x3c0a);
  return {
    type,
    key: klv.keyHex,
    offset: klv.offset,
    instanceUid: instanceUid && instanceUid.length >= 16 ? hex(instanceUid.subarray(0, 16)) : null,
    items
  };
}

function parseDescriptor(set: MxfMetadataSet): MxfDescriptor {
  return {
    instanceUid: set.instanceUid,
    linkedTrackId: itemU32(set, 0x3006),
    essenceContainerUl: itemHex(set, 0x3004),
    codecUl: itemHex(set, 0x3201) ?? itemHex(set, 0x3d06) ?? itemHex(set, 0x3005),
    width: itemU32(set, 0x3203),
    height: itemU32(set, 0x3202),
    aspectRatio: itemRational(set, 0x320e),
    componentDepth: itemU32(set, 0x3301),
    horizontalSubsampling: itemU32(set, 0x3302),
    verticalSubsampling: itemU32(set, 0x3308),
    sampleRate: itemRational(set, 0x3d03),
    channels: itemU32(set, 0x3d07),
    bitsPerSample: itemU32(set, 0x3d01),
    duration: itemI64(set, 0x3002)
  };
}

function buildTracks(
  metadataSets: readonly MxfMetadataSet[],
  descriptors: readonly MxfDescriptor[],
  essence: readonly MxfEssenceElement[]
): MxfTrack[] {
  const essenceByTrack = groupBy(essence, (element) => element.trackNumber);
  const sequences = new Map(metadataSets.filter((set) => set.type === "Sequence").map((set) => [set.instanceUid, set]));
  const candidates = metadataSets
    .filter((set) => set.type === "Track" || set.type === "StaticTrack")
    .map((set): MxfTrack | null => {
      const id = itemU32(set, 0x4801);
      const numberBytes = item(set.items, 0x4804);
      const editRate = itemRational(set, 0x4b01);
      if (id === null || !numberBytes || numberBytes.length < 4 || !editRate) {
        return null;
      }
      const number = readU32BE(numberBytes, 0);
      const sequenceBytes = item(set.items, 0x4803);
      const sequenceUid = sequenceBytes && sequenceBytes.length >= 16 ? hex(sequenceBytes.subarray(0, 16)) : null;
      const sequence = sequenceUid ? sequences.get(sequenceUid) : null;
      const elements = essenceByTrack.get(number) ?? [];
      return {
        id,
        number,
        numberHex: number.toString(16).padStart(8, "0"),
        kind: kindForEssence(elements[0]),
        name: itemString(set, 0x4802),
        editRate,
        origin: itemI64(set, 0x4b02) ?? 0,
        duration: sequence ? itemI64(sequence, 0x0202) : null,
        sequenceUid,
        descriptor: descriptors.find((descriptor) => descriptor.linkedTrackId === id) ?? null,
        bodySid: elements[0]?.bodySid ?? null,
        packetCount: elements.length
      };
    })
    .filter((track): track is MxfTrack => track !== null && track.packetCount > 0);

  const byNumber = new Map<number, MxfTrack>();
  for (const track of candidates) {
    const existing = byNumber.get(track.number);
    if (!existing || (track.descriptor && !existing.descriptor)) {
      byNumber.set(track.number, track);
    }
  }
  for (const [number, elements] of essenceByTrack) {
    if (byNumber.has(number)) {
      continue;
    }
    byNumber.set(number, {
      id: number,
      number,
      numberHex: number.toString(16).padStart(8, "0"),
      kind: kindForEssence(elements[0]),
      name: null,
      editRate: { numerator: 1, denominator: 1 },
      origin: 0,
      duration: elements.length,
      sequenceUid: null,
      descriptor: null,
      bodySid: elements[0]?.bodySid ?? null,
      packetCount: elements.length
    });
  }
  return [...byNumber.values()];
}

function buildTimecodeTracks(metadataSets: readonly MxfMetadataSet[]): MxfTimecodeTrack[] {
  const setsByUid = new Map(
    metadataSets
      .filter((set): set is MxfMetadataSet & { instanceUid: string } => set.instanceUid !== null)
      .map((set) => [set.instanceUid, set])
  );
  const result: MxfTimecodeTrack[] = [];
  for (const packageSet of metadataSets) {
    if (packageSet.type !== "MaterialPackage" && packageSet.type !== "SourcePackage") {
      continue;
    }
    for (const trackUid of itemReferenceArray(packageSet, 0x4403)) {
      const trackSet = setsByUid.get(trackUid);
      if (!trackSet || (trackSet.type !== "Track" && trackSet.type !== "StaticTrack")) {
        continue;
      }
      const trackId = itemU32(trackSet, 0x4801);
      const editRate = itemRational(trackSet, 0x4b01);
      const sequenceUid = itemUid(trackSet, 0x4803);
      const sequence = sequenceUid ? setsByUid.get(sequenceUid) : null;
      if (trackId === null || !editRate || sequence?.type !== "Sequence") {
        continue;
      }
      const component = itemReferenceArray(sequence, 0x1001)
        .map((uid) => setsByUid.get(uid))
        .find((set) => set?.type === "TimecodeComponent");
      if (!component) {
        continue;
      }
      const startTimecode = itemI64(component, 0x1501);
      const roundedTimecodeBase = itemU16(component, 0x1502);
      const dropFrameValue = item(component.items, 0x1503);
      if (startTimecode === null || roundedTimecodeBase === null || !dropFrameValue?.length) {
        continue;
      }
      result.push({
        packageKind: packageSet.type === "MaterialPackage" ? "material" : "source",
        packageUid: itemHex(packageSet, 0x4401),
        packageInstanceUid: packageSet.instanceUid,
        trackId,
        name: itemString(trackSet, 0x4802),
        editRate,
        origin: itemI64(trackSet, 0x4b02) ?? 0,
        duration: itemI64(sequence, 0x0202) ?? itemI64(component, 0x0202),
        startTimecode,
        roundedTimecodeBase,
        dropFrame: dropFrameValue[0] !== 0
      });
    }
  }
  return result;
}

function buildPackets(
  tracks: readonly MxfTrack[],
  essence: readonly MxfEssenceElement[],
  indexes: readonly MxfIndexTableSegment[]
): MxfPacket[] {
  const tracksByNumber = new Map(tracks.map((track) => [track.number, track]));
  const elementsPerTrack = new Map<number, number>();
  for (const element of essence) {
    elementsPerTrack.set(element.trackNumber, (elementsPerTrack.get(element.trackNumber) ?? 0) + 1);
  }
  const counters = new Map<number, number>();
  return essence.flatMap((element): MxfPacket[] => {
    const track = tracksByNumber.get(element.trackNumber);
    if (!track) {
      return [];
    }
    const duration = track.editRate.denominator / track.editRate.numerator;
    const indexSegment = indexes.find((segment) => segment.bodySid === element.bodySid);
    const editUnitByteCount = indexSegment?.editUnitByteCount ?? 0;
    const slices = essenceSlices(
      element.klv.valueLength,
      elementsPerTrack.get(element.trackNumber) ?? 1,
      indexSegment
    );
    const packets: MxfPacket[] = [];
    for (const slice of slices) {
      const index = counters.get(track.number) ?? 0;
      counters.set(track.number, index + 1);
      const indexEntry = indexSegment?.entries[index - indexSegment.indexStartPosition];
      packets.push({
        track,
        index,
        timestamp: (index + track.origin) * duration,
        duration,
        timestampUs: Math.round((index + track.origin) * duration * 1_000_000),
        durationUs: Math.round(duration * 1_000_000),
        keyframe: indexEntry ? (indexEntry.flags & 0x80) !== 0 : null,
        byteOffset: element.klv.valueOffset + slice.offset,
        byteLength: slice.length,
        essence: element
      });
    }
    return packets;
  });
}

function essenceSlices(
  valueLength: number,
  elementCount: number,
  indexSegment: MxfIndexTableSegment | undefined
): Array<{ offset: number; length: number }> {
  const editUnitByteCount = indexSegment?.editUnitByteCount ?? 0;
  if (editUnitByteCount > 0 && valueLength >= editUnitByteCount * 2) {
    const units = Math.min(
      Math.floor(valueLength / editUnitByteCount),
      indexSegment?.indexDuration || Number.MAX_SAFE_INTEGER
    );
    return Array.from({ length: units }, (_, index) => ({
      offset: index * editUnitByteCount,
      length: editUnitByteCount
    }));
  }

  const entries = indexSegment?.entries ?? [];
  if (elementCount === 1 && entries.length > 1) {
    const firstOffset = entries[0].streamOffset;
    const offsets = entries.map((entry) => entry.streamOffset - firstOffset);
    if (
      offsets[0] === 0 &&
      offsets.every((offset, index) => offset >= 0 && offset < valueLength && (index === 0 || offset > offsets[index - 1]))
    ) {
      return offsets.map((offset, index) => ({
        offset,
        length: (offsets[index + 1] ?? valueLength) - offset
      }));
    }
  }

  return [{ offset: 0, length: valueLength }];
}

function parseIndexTable(set: MxfMetadataSet): MxfIndexTableSegment {
  const entries: MxfIndexEntry[] = [];
  const entryArray = item(set.items, 0x3f0a);
  if (entryArray) {
    if (entryArray.length < 8) {
      throw new Error(`MXF index entry array at ${set.offset} is shorter than its 8-byte header.`);
    }
    const count = readU32BE(entryArray, 0);
    const itemLength = readU32BE(entryArray, 4);
    if (itemLength < 11 || 8 + count * itemLength > entryArray.length) {
      throw new Error(`Invalid MXF index entry array at ${set.offset}.`);
    }
    for (let index = 0; index < count; index += 1) {
      const offset = 8 + index * itemLength;
      entries.push({
        temporalOffset: signedByte(entryArray[offset]),
        keyFrameOffset: signedByte(entryArray[offset + 1]),
        flags: entryArray[offset + 2],
        streamOffset: safeNumber(readU64BE(entryArray, offset + 3))
      });
    }
  }
  return {
    offset: set.offset,
    indexEditRate: itemRational(set, 0x3f0b),
    indexStartPosition: itemI64(set, 0x3f0c) ?? 0,
    indexDuration: itemI64(set, 0x3f0d) ?? 0,
    editUnitByteCount: itemU32(set, 0x3f05) ?? 0,
    indexSid: itemU32(set, 0x3f06) ?? 0,
    bodySid: itemU32(set, 0x3f07) ?? 0,
    entries
  };
}

async function parseRandomIndex(
  source: MxfSource,
  klv: MxfKlvPacket,
  maxMetadataValueBytes: number
): Promise<MxfRandomIndexEntry[]> {
  const bytes = await readMetadataValue(source, klv, maxMetadataValueBytes);
  if (bytes.length < 4 || (bytes.length - 4) % 12 !== 0) {
    throw new Error(`Invalid MXF random index pack at ${klv.offset}.`);
  }
  const entries: MxfRandomIndexEntry[] = [];
  for (let offset = 0; offset + 12 <= bytes.length - 4; offset += 12) {
    entries.push({
      bodySid: readU32BE(bytes, offset),
      byteOffset: safeNumber(readU64BE(bytes, offset + 4))
    });
  }
  return entries;
}

async function readMetadataValue(
  source: MxfSource,
  klv: MxfKlvPacket,
  maxMetadataValueBytes: number
): Promise<Uint8Array> {
  if (klv.valueLength > maxMetadataValueBytes) {
    throw new Error(`MXF metadata KLV at ${klv.offset} exceeds the ${maxMetadataValueBytes}-byte limit.`);
  }
  return source.read(klv.valueOffset, klv.valueLength);
}

function item(items: readonly MxfLocalSetItem[], localTag: number): Uint8Array | null {
  return items.find((candidate) => candidate.localTag === localTag)?.value ?? null;
}

function itemU32(set: MxfMetadataSet, localTag: number): number | null {
  const value = item(set.items, localTag);
  return value && value.length >= 4 ? readU32BE(value, 0) : null;
}

function itemU16(set: MxfMetadataSet, localTag: number): number | null {
  const value = item(set.items, localTag);
  return value && value.length >= 2 ? readU16BE(value, 0) : null;
}

function itemUid(set: MxfMetadataSet, localTag: number): string | null {
  const value = item(set.items, localTag);
  return value && value.length >= 16 ? hex(value.subarray(0, 16)) : null;
}

function itemReferenceArray(set: MxfMetadataSet, localTag: number): string[] {
  const value = item(set.items, localTag);
  if (!value || value.length < 8) {
    return [];
  }
  const count = readU32BE(value, 0);
  const itemLength = readU32BE(value, 4);
  if (itemLength < 16 || count > Math.floor((value.length - 8) / itemLength)) {
    return [];
  }
  return Array.from({ length: count }, (_, index) => {
    const offset = 8 + index * itemLength;
    return hex(value.subarray(offset, offset + 16));
  });
}

function itemI64(set: MxfMetadataSet, localTag: number): number | null {
  const value = item(set.items, localTag);
  return value && value.length >= 8 ? readI64BE(value, 0) : null;
}

function itemRational(set: MxfMetadataSet, localTag: number): MxfRational | null {
  const value = item(set.items, localTag);
  if (!value || value.length < 8) {
    return null;
  }
  const numerator = readU32BE(value, 0);
  const denominator = readU32BE(value, 4);
  return numerator > 0 && denominator > 0 ? { numerator, denominator } : null;
}

function itemHex(set: MxfMetadataSet, localTag: number): string | null {
  const value = item(set.items, localTag);
  return value ? hex(value) : null;
}

function itemString(set: MxfMetadataSet, localTag: number): string | null {
  const value = item(set.items, localTag);
  return value ? utf16Be(value) : null;
}

function partitionKind(value: number): MxfPartitionKind {
  return value === 2 ? "header" : value === 3 ? "body" : value === 4 ? "footer" : "unknown";
}

function kindForEssence(element: MxfEssenceElement | undefined): MxfTrackKind {
  if (!element) {
    return "unknown";
  }
  switch (element.itemType) {
    case 0x14:
      return "system";
    case 0x15:
      return "video";
    case 0x16:
      return "audio";
    case 0x17:
      return "data";
    default:
      return "unknown";
  }
}

function isEssenceKey(key: string): boolean {
  return key.startsWith(GENERIC_ESSENCE_PREFIX) || key.startsWith(AVID_ESSENCE_PREFIX) || key.startsWith(CANOPUS_ESSENCE_PREFIX);
}

function isPartitionKey(klv: MxfKlvPacket): boolean {
  return klv.keyHex.startsWith(PARTITION_PREFIX) && klv.key[13] >= 2 && klv.key[13] <= 4;
}

function matchesPrefix(bytes: Uint8Array, offset: number, prefix: readonly number[]): boolean {
  return offset + prefix.length <= bytes.length && prefix.every((value, index) => bytes[offset + index] === value);
}

function groupBy<T, K>(values: readonly T[], keyFor: (value: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = result.get(key);
    if (group) {
      group.push(value);
    } else {
      result.set(key, [value]);
    }
  }
  return result;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("MXF demux was aborted.", "AbortError");
  }
}

function resolveLimits(input: Partial<MxfDemuxLimits> | undefined): MxfDemuxLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`MXF limit ${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function enforceCount(label: string, actual: number, maximum: number): void {
  if (actual > maximum) {
    throw new Error(`MXF ${label} exceed the configured limit of ${maximum}.`);
  }
}

function enforceDimensions(descriptor: MxfDescriptor, limits: MxfDemuxLimits): void {
  const width = descriptor.width ?? 0;
  const height = descriptor.height ?? 0;
  if (width > limits.maxWidth || height > limits.maxHeight || width * height > limits.maxFramePixels) {
    throw new Error(
      `MXF descriptor dimensions ${width}x${height} exceed configured limits ` +
      `${limits.maxWidth}x${limits.maxHeight}/${limits.maxFramePixels} pixels.`
    );
  }
}
