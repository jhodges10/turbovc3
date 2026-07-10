import type { MxfSource } from "./mxfSource";

export interface MxfRational {
  numerator: number;
  denominator: number;
}

export interface MxfKlvPacket {
  offset: number;
  key: Uint8Array;
  keyHex: string;
  lengthFieldLength: number;
  valueOffset: number;
  valueLength: number;
  nextOffset: number;
}

export type MxfPartitionKind = "header" | "body" | "footer" | "unknown";

export interface MxfPartition {
  kind: MxfPartitionKind;
  status: number;
  offset: number;
  majorVersion: number;
  minorVersion: number;
  kagSize: number;
  thisPartition: number;
  previousPartition: number;
  footerPartition: number;
  headerByteCount: number;
  indexByteCount: number;
  indexSid: number;
  bodyOffset: number;
  bodySid: number;
  operationalPattern: string;
  essenceContainers: readonly string[];
}

export interface MxfPrimerEntry {
  localTag: number;
  propertyUl: string;
}

export interface MxfLocalSetItem {
  localTag: number;
  propertyUl: string | null;
  value: Uint8Array;
}

export interface MxfMetadataSet {
  type: string;
  key: string;
  offset: number;
  instanceUid: string | null;
  items: readonly MxfLocalSetItem[];
}

export type MxfTrackKind = "video" | "audio" | "data" | "system" | "unknown";

export interface MxfDescriptor {
  instanceUid: string | null;
  linkedTrackId: number | null;
  essenceContainerUl: string | null;
  codecUl: string | null;
  width: number | null;
  height: number | null;
  aspectRatio: MxfRational | null;
  componentDepth: number | null;
  horizontalSubsampling: number | null;
  verticalSubsampling: number | null;
  sampleRate: MxfRational | null;
  channels: number | null;
  bitsPerSample: number | null;
  duration: number | null;
}

export interface MxfTrack {
  id: number;
  number: number;
  numberHex: string;
  kind: MxfTrackKind;
  name: string | null;
  editRate: MxfRational;
  origin: number;
  duration: number | null;
  sequenceUid: string | null;
  descriptor: MxfDescriptor | null;
  bodySid: number | null;
  packetCount: number;
}

export interface MxfEssenceElement {
  index: number;
  trackNumber: number;
  trackNumberHex: string;
  itemType: number;
  elementCount: number;
  elementType: number;
  elementNumber: number;
  bodySid: number;
  klv: MxfKlvPacket;
}

export interface MxfIndexEntry {
  temporalOffset: number;
  keyFrameOffset: number;
  flags: number;
  streamOffset: number;
}

export interface MxfIndexTableSegment {
  offset: number;
  indexEditRate: MxfRational | null;
  indexStartPosition: number;
  indexDuration: number;
  editUnitByteCount: number;
  indexSid: number;
  bodySid: number;
  entries: readonly MxfIndexEntry[];
}

export interface MxfRandomIndexEntry {
  bodySid: number;
  byteOffset: number;
}

export interface MxfPacket {
  track: MxfTrack;
  index: number;
  timestamp: number;
  duration: number;
  timestampUs: number;
  durationUs: number;
  keyframe: boolean | null;
  byteOffset: number;
  byteLength: number;
  essence: MxfEssenceElement;
}

export interface MxfDemuxResult {
  source: MxfSource;
  operationalPattern: string | null;
  klvPackets: readonly MxfKlvPacket[];
  partitions: readonly MxfPartition[];
  primer: ReadonlyMap<number, string>;
  metadataSets: readonly MxfMetadataSet[];
  descriptors: readonly MxfDescriptor[];
  tracks: readonly MxfTrack[];
  essenceElements: readonly MxfEssenceElement[];
  indexTableSegments: readonly MxfIndexTableSegment[];
  randomIndex: readonly MxfRandomIndexEntry[];
  packets: readonly MxfPacket[];
}
