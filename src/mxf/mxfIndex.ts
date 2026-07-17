import type { MxfIndexEntry, MxfIndexTableSegment } from "./mxfTypes.js";

export interface MxfEssenceSlice {
  offset: number;
  length: number;
}

function segmentLength(segment: MxfIndexTableSegment): number {
  return segment.indexDuration > 0 ? segment.indexDuration : segment.entries.length;
}

export function indexEntryAt(
  segments: readonly MxfIndexTableSegment[],
  bodySid: number,
  position: number
): MxfIndexEntry | undefined {
  const candidates = segments.filter((segment) => {
    const length = segmentLength(segment);
    return (
      segment.bodySid === bodySid &&
      position >= segment.indexStartPosition &&
      position < segment.indexStartPosition + length
    );
  });
  if (candidates.length > 1) {
    throw new Error(`MXF index position ${position} for BodySID ${bodySid} is covered by multiple index segments.`);
  }
  const segment = candidates[0];
  return segment?.entries[position - segment.indexStartPosition];
}

export function essenceSlices(
  valueLength: number,
  elementCount: number,
  bodySid: number,
  segments: readonly MxfIndexTableSegment[]
): MxfEssenceSlice[] {
  const matching = segments
    .filter((segment) => segment.bodySid === bodySid)
    .slice()
    .sort((left, right) => left.indexStartPosition - right.indexStartPosition || left.offset - right.offset);
  const editUnitByteCounts = new Set(
    matching.map((segment) => segment.editUnitByteCount).filter((size) => size > 0)
  );
  if (editUnitByteCounts.size > 1) {
    throw new Error(`MXF BodySID ${bodySid} has conflicting EditUnitByteCount values.`);
  }
  const editUnitByteCount: number = editUnitByteCounts.values().next().value ?? 0;
  if (editUnitByteCount > 0 && valueLength >= editUnitByteCount * 2) {
    const indexedDuration = contiguousDuration(matching, bodySid);
    const units = Math.min(Math.floor(valueLength / editUnitByteCount), indexedDuration || Number.MAX_SAFE_INTEGER);
    return Array.from({ length: units }, (_, index) => ({
      offset: index * editUnitByteCount,
      length: editUnitByteCount
    }));
  }

  if (elementCount === 1) {
    const entries = contiguousEntries(matching, bodySid);
    if (entries.length > 1) {
      const firstOffset = entries[0].streamOffset;
      const offsets = entries.map((entry) => entry.streamOffset - firstOffset);
      if (
        offsets[0] !== 0 ||
        !offsets.every(
          (offset, index) => offset >= 0 && offset < valueLength && (index === 0 || offset > offsets[index - 1])
        )
      ) {
        throw new Error(`MXF BodySID ${bodySid} has ambiguous clip-wrapped index entry offsets.`);
      }
      return offsets.map((offset, index) => ({
        offset,
        length: (offsets[index + 1] ?? valueLength) - offset
      }));
    }
  }

  return [{ offset: 0, length: valueLength }];
}

function contiguousDuration(segments: readonly MxfIndexTableSegment[], bodySid: number): number {
  let duration = 0;
  let nextPosition: number | null = null;
  for (const segment of segments) {
    const length = segmentLength(segment);
    if (length === 0) {
      continue;
    }
    if (nextPosition !== null && segment.indexStartPosition !== nextPosition) {
      throw new Error(`MXF BodySID ${bodySid} has a sparse or overlapping constant-byte-count clip index.`);
    }
    duration += length;
    nextPosition = segment.indexStartPosition + length;
  }
  return duration;
}

function contiguousEntries(
  segments: readonly MxfIndexTableSegment[],
  bodySid: number
): readonly MxfIndexEntry[] {
  const result: MxfIndexEntry[] = [];
  let nextPosition: number | null = null;
  for (const segment of segments) {
    if (segment.entries.length === 0) {
      continue;
    }
    if (nextPosition !== null && segment.indexStartPosition !== nextPosition) {
      throw new Error(`MXF BodySID ${bodySid} has a sparse or overlapping variable-byte-count clip index.`);
    }
    result.push(...segment.entries);
    nextPosition = segment.indexStartPosition + segment.entries.length;
  }
  return result;
}
