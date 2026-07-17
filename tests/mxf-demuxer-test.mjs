#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const module = await loadMxfModule();

await testSyntheticKlv(module);
await testSyntheticMalformedKlv(module);
testIndexSegments(module);
testTimecodeFormatting(module);
await testLazyDnxAdapter(module, "tests/fixtures/dnxhr-lb-op1a-pcm.mxf");
await testStructuralMutations(module, "tests/fixtures/dnxhr-lb-op1a-pcm.mxf");
await testFixture(module, "samples/wip_gallery_page_1920x1080_60fps.mxf", {
  width: 1920,
  height: 1080,
  frameCount: 2285,
  frameSize: 188416,
  frameRate: 60
});
await testFixture(module, "samples/wip_gallery_page_3840x2160_60fps.mxf", {
  width: 3840,
  height: 2160,
  frameCount: 2285,
  frameRate: 60
});
await testAudioVideoFixture(module, "samples/mxf_demux_op1a_dnx_pcm.mxf");
await testFixture(module, "samples/mxf_demux_opatom_dnx.mxf", {
  width: 1280,
  height: 720,
  frameCount: 30,
  frameRate: 30,
  operationalPattern: "060e2b34040101020d01020110030000"
});
await testAudioVideoFixture(module, "tests/fixtures/dnxhr-lb-op1a-pcm.mxf", 1);
await testTimecodeFixture(module, "tests/fixtures/dnxhr-lb-op1a-pcm.mxf");
await testAudioVideoFixture(module, "tests/fixtures/dnxhr-lb-op1a-pcm24-mono-24fps-tc.mxf", 1, {
  frameRate: 24,
  sampleRate: 48_000,
  channels: 1,
  bitsPerSample: 24
});
await testTimecodeFixture(module, "tests/fixtures/dnxhr-lb-op1a-pcm24-mono-24fps-tc.mxf", {
  frameRate: 24,
  startTimecode: 89_356,
  formatted: "01:02:03:04"
});
await testFixture(module, "tests/fixtures/dnxhr-lb-opatom.mxf", {
  width: 1280,
  height: 720,
  frameCount: 1,
  frameRate: 30,
  operationalPattern: "060e2b34040101020d01020110030000"
});
await testTimecodeFixture(module, "tests/fixtures/dnxhr-lb-opatom.mxf");

console.log("MXF demuxer contracts passed.");

function testIndexSegments(module) {
  const segment = (start, offsets, options = {}) => ({
    offset: options.offset ?? start,
    indexEditRate: { numerator: 30, denominator: 1 },
    indexStartPosition: start,
    indexDuration: options.duration ?? offsets.length,
    editUnitByteCount: options.editUnitByteCount ?? 0,
    indexSid: 2,
    bodySid: options.bodySid ?? 1,
    entries: offsets.map((streamOffset, index) => ({
      temporalOffset: 0,
      keyFrameOffset: 0,
      flags: index === 0 ? 0x80 : 0,
      streamOffset
    }))
  });
  const variableSegments = [segment(0, [100, 110]), segment(2, [125, 140])];
  assert.deepEqual(module.essenceSlices(60, 1, 1, variableSegments), [
    { offset: 0, length: 10 },
    { offset: 10, length: 15 },
    { offset: 25, length: 15 },
    { offset: 40, length: 20 }
  ]);
  assert.equal(module.indexEntryAt(variableSegments, 1, 2)?.streamOffset, 125);
  assert.equal(module.indexEntryAt(variableSegments, 1, 4), undefined);

  const fixedSegments = [
    segment(0, [], { duration: 2, editUnitByteCount: 10 }),
    segment(2, [], { duration: 2, editUnitByteCount: 10 })
  ];
  assert.deepEqual(module.essenceSlices(40, 1, 1, fixedSegments), [
    { offset: 0, length: 10 },
    { offset: 10, length: 10 },
    { offset: 20, length: 10 },
    { offset: 30, length: 10 }
  ]);
  assert.throws(
    () => module.indexEntryAt([segment(0, [0, 10]), segment(1, [10, 20])], 1, 1),
    /covered by multiple index segments/
  );
  assert.throws(
    () => module.essenceSlices(40, 1, 1, [segment(0, [0, 10]), segment(3, [20, 30])]),
    /sparse or overlapping variable-byte-count clip index/
  );
  assert.throws(
    () => module.essenceSlices(40, 1, 1, [segment(0, [10, 5])]),
    /ambiguous clip-wrapped index entry offsets/
  );
  assert.throws(
    () => module.essenceSlices(40, 1, 1, [
      segment(0, [], { duration: 2, editUnitByteCount: 10 }),
      segment(2, [], { duration: 2, editUnitByteCount: 12 })
    ]),
    /conflicting EditUnitByteCount/
  );
  assert.throws(
    () => module.essenceSlices(40, 1, 1, [
      segment(0, [], { duration: 2, editUnitByteCount: 10 }),
      segment(3, [], { duration: 2, editUnitByteCount: 10 })
    ]),
    /sparse or overlapping constant-byte-count clip index/
  );
}

async function testLazyDnxAdapter(module, relativePath) {
  const fixturePath = path.join(repoRoot, relativePath);
  const bytes = new Uint8Array(await readFile(fixturePath));
  let bytesRead = 0;
  const source = {
    size: bytes.length,
    async read(offset, length) {
      bytesRead += length;
      return bytes.subarray(offset, offset + length);
    }
  };
  const progress = [];
  const result = await module.demuxDnxMxf(source, {
    onProgress(value) {
      progress.push(value);
    }
  });
  assert.ok(result);
  assert.equal(result.packets.length, 1);
  assert.equal(result.firstFrameHeader.profile, "dnxhr_lb");
  assert.equal("bytes" in result.packets[0], false);
  assert.equal(result.packets[0].byteLength > 0, true);
  const bytesReadAfterOpen = bytesRead;
  assert.equal(bytesReadAfterOpen < result.packets[0].byteLength, true);
  assert.equal(result.demuxer.bytesRead, bytesReadAfterOpen);
  assert.equal(progress.length > 1, true);
  assert.equal(progress[0].offset, 0);
  assert.equal(progress.every((value) => value.totalBytes === bytes.length), true);
  assert.equal(progress.every((value, index) => index === 0 || value.offset >= progress[index - 1].offset), true);
  assert.deepEqual(
    Array.from((await result.demuxer.readPacket(result.packets[0])).subarray(0, 6)),
    [0, 0, 2, 128, 3, 1]
  );
  assert.equal(bytesRead - bytesReadAfterOpen, result.packets[0].byteLength);

  const blobResult = await module.demuxDnxMxf(new Blob([bytes]));
  assert.ok(blobResult);
  await assert.rejects(
    module.MxfDemuxer.open(bytes, { limits: { maxTracks: 1 } }),
    /tracks exceed the configured limit of 1/
  );
  await assert.rejects(
    module.MxfDemuxer.open(bytes, { limits: { maxMetadataValueBytes: 1 } }),
    /metadata KLV.*exceeds the 1-byte limit/
  );
  await assert.rejects(
    module.MxfDemuxer.open(bytes, { limits: { maxWidth: 100 } }),
    /descriptor dimensions.*exceed configured limits/
  );
  await assert.rejects(
    module.MxfDemuxer.open(bytes, { limits: { maxTracks: 0 } }),
    /maxTracks must be a positive safe integer/
  );

  await assert.rejects(
    module.MxfDemuxer.open(new Uint8Array(128), { limits: { maxResyncBytes: 32 } }),
    /resynchronization exceeded the 32-byte limit/
  );
}

async function testStructuralMutations(module, relativePath) {
  const bytes = new Uint8Array(await readFile(path.join(repoRoot, relativePath)));
  const parsed = await module.demuxMxf(bytes);

  const randomIndexKlv = parsed.klvPackets.find(
    (packet) => packet.keyHex === "060e2b34020501010d01020101110100"
  );
  assert.ok(randomIndexKlv);
  const invalidRip = bytes.slice();
  const ripView = new DataView(invalidRip.buffer, invalidRip.byteOffset, invalidRip.byteLength);
  ripView.setUint32(randomIndexKlv.valueOffset, ripView.getUint32(randomIndexKlv.valueOffset) + 99);
  await assert.rejects(module.demuxMxf(invalidRip), /random index BodySID .* does not match partition/);

  const indexKlv = parsed.klvPackets.find(
    (packet) => packet.keyHex === "060e2b34025301010d01020101100100"
  );
  assert.ok(indexKlv);
  const invalidIndexSid = bytes.slice();
  const indexSidTag = findBytes(
    invalidIndexSid,
    Uint8Array.from([0x3f, 0x06, 0x00, 0x04]),
    indexKlv.valueOffset,
    indexKlv.nextOffset
  );
  assert.notEqual(indexSidTag, -1);
  new DataView(invalidIndexSid.buffer, invalidIndexSid.byteOffset, invalidIndexSid.byteLength).setUint32(
    indexSidTag + 4,
    99
  );
  await assert.rejects(module.demuxMxf(invalidIndexSid), /uses IndexSID 99, but its partition uses/);
}

async function testFixture(module, relativePath, expected) {
  const fixturePath = path.join(repoRoot, relativePath);
  if (!existsSync(fixturePath)) {
    console.log(`Skipping missing local fixture ${relativePath}.`);
    return;
  }

  const file = await open(fixturePath, "r");
  const info = await stat(fixturePath);
  let bytesRead = 0;
  const source = {
    size: info.size,
    async read(offset, length) {
      const bytes = new Uint8Array(length);
      const result = await file.read(bytes, 0, length, offset);
      bytesRead += result.bytesRead;
      return result.bytesRead === length ? bytes : bytes.subarray(0, result.bytesRead);
    }
  };

  try {
    const demuxer = await module.MxfDemuxer.open(source);
    assert.equal(
      demuxer.result.operationalPattern,
      expected.operationalPattern ?? "060e2b34040101010d01020101010900"
    );
    assert.equal(demuxer.result.partitions[0]?.kind, "header");
    assert.equal(demuxer.result.partitions.some((partition) => partition.kind === "footer"), true);
    assert.equal(demuxer.result.randomIndex.length >= 2, true);
    assert.equal(
      demuxer.result.randomIndex.every((entry) =>
        demuxer.result.partitions.some((partition) => partition.offset === entry.byteOffset)
      ),
      true
    );
    assert.equal(
      demuxer.result.indexTableSegments.some(
        (segment) =>
          segment.bodySid > 0 &&
          segment.editUnitByteCount > 0 &&
          segment.indexEditRate?.numerator === expected.frameRate &&
          segment.indexEditRate.denominator === 1
      ),
      true
    );

    const videoTracks = demuxer.tracks.filter((track) => track.kind === "video");
    assert.equal(videoTracks.length, 1);
    const track = videoTracks[0];
    assert.equal(track.editRate.numerator, expected.frameRate);
    assert.equal(track.editRate.denominator, 1);
    assert.equal(track.duration, expected.frameCount);
    assert.equal(track.packetCount, expected.frameCount);
    assert.equal(track.descriptor?.width, expected.width);
    assert.equal(track.descriptor?.height, expected.height);

    const packets = demuxer.packetsForTrack(track);
    assert.equal(packets.length, expected.frameCount);
    assert.equal(packets[0].timestampUs, 0);
    if (packets.length > 1) {
      assert.equal(packets[1].timestampUs, Math.round(1_000_000 / expected.frameRate));
    }
    assert.equal(packets.at(-1).index, expected.frameCount - 1);
    if (expected.frameSize) {
      assert.equal(packets[0].byteLength, expected.frameSize);
    }

    const firstFrame = await demuxer.readPacket(packets[0]);
    assert.equal(firstFrame.length, packets[0].byteLength);
    assert.deepEqual(Array.from(firstFrame.subarray(0, 2)), [0, 0]);
    assert.equal(firstFrame[4], 3);
    if (expected.frameCount > 1) {
      assert.equal(bytesRead < info.size / 20, true, `Demux read ${bytesRead} of ${info.size} bytes`);
    }
    console.log(`${relativePath}: ${packets.length} packets indexed after reading ${bytesRead} bytes`);
  } finally {
    await file.close();
  }
}

async function testAudioVideoFixture(module, relativePath, expectedFrameCount = 30, expected = {}) {
  const fixturePath = path.join(repoRoot, relativePath);
  if (!existsSync(fixturePath)) {
    console.log(`Skipping missing local fixture ${relativePath}.`);
    return;
  }
  const bytes = new Uint8Array(await readFile(fixturePath));
  const demuxer = await module.MxfDemuxer.open(bytes);
  const video = demuxer.tracks.find((track) => track.kind === "video");
  const audio = demuxer.tracks.find((track) => track.kind === "audio");
  assert.ok(video);
  assert.ok(audio);
  assert.equal(video.packetCount, expectedFrameCount);
  assert.equal(video.editRate.numerator, expected.frameRate ?? 30);
  assert.equal(video.descriptor?.width, 1280);
  assert.equal(video.descriptor?.height, 720);
  assert.equal(audio.packetCount, expectedFrameCount);
  assert.equal(audio.descriptor?.sampleRate?.numerator, expected.sampleRate ?? 48_000);
  assert.equal(audio.descriptor?.sampleRate?.denominator, 1);
  assert.equal(audio.descriptor?.channels, expected.channels ?? 2);
  assert.equal(audio.descriptor?.bitsPerSample, expected.bitsPerSample ?? 16);
  if (expectedFrameCount > 1) {
    assert.equal(demuxer.packetsForTrack(audio)[1].timestampUs, 33333);
  }
  console.log(`${relativePath}: video and audio tracks resolved`);
}

async function testTimecodeFixture(module, relativePath, expected = {}) {
  const bytes = new Uint8Array(await readFile(path.join(repoRoot, relativePath)));
  const demuxer = await module.MxfDemuxer.open(bytes);
  assert.equal(demuxer.timecodeTracks.length, 2);
  assert.deepEqual(demuxer.timecodeTracks.map((track) => track.packageKind), ["material", "source"]);
  for (const track of demuxer.timecodeTracks) {
    assert.equal(track.packageUid?.length, 64);
    assert.equal(track.editRate.numerator, expected.frameRate ?? 30);
    assert.equal(track.editRate.denominator, 1);
    assert.equal(track.duration, 1);
    assert.equal(track.startTimecode, expected.startTimecode ?? 0);
    assert.equal(track.roundedTimecodeBase, expected.frameRate ?? 30);
    assert.equal(track.dropFrame, false);
    const timecode = demuxer.timecodeAt(track, 0);
    assert.equal(timecode.frameNumber, expected.startTimecode ?? 0);
    assert.equal(timecode.dropFrame, false);
    assert.equal(timecode.formatted, expected.formatted ?? "00:00:00:00");
  }
}

function testTimecodeFormatting(module) {
  const track = {
    packageKind: "material",
    packageUid: null,
    packageInstanceUid: null,
    trackId: 1,
    name: null,
    editRate: { numerator: 30_000, denominator: 1_001 },
    origin: 0,
    duration: null,
    startTimecode: 0,
    roundedTimecodeBase: 30,
    dropFrame: true
  };
  assert.equal(module.mxfTimecodeAtEditUnit(track, 1_799).formatted, "00:00:59;29");
  assert.equal(module.mxfTimecodeAtEditUnit(track, 1_800).formatted, "00:01:00;02");
  assert.equal(module.mxfTimecodeAtEditUnit(track, 17_982).formatted, "00:10:00;00");
  assert.equal(module.mxfTimecodeAtEditUnit(track, -1).formatted, "23:59:59;29");
  assert.equal(
    module.mxfTimecodeAtEditUnit({ ...track, dropFrame: false }, -1).formatted,
    "23:59:59:29"
  );
  assert.throws(() => module.mxfTimecodeAtEditUnit(track, 0.5), /safe integer/);
  assert.throws(
    () => module.mxfTimecodeAtEditUnit({ ...track, roundedTimecodeBase: 25 }, 0),
    /base of 30 or 60/
  );
}

async function testSyntheticKlv(module) {
  const key = Uint8Array.from([6, 14, 43, 52, 1, 2, 1, 1, 13, 1, 3, 1, 21, 1, 12, 0]);
  const payload = Uint8Array.from([1, 2, 3, 4]);
  const bytes = new Uint8Array(16 + 2 + payload.length);
  bytes.set(key);
  bytes[16] = 0x81;
  bytes[17] = payload.length;
  bytes.set(payload, 18);
  const result = await module.demuxMxf(bytes);
  assert.equal(result.essenceElements.length, 1);
  assert.equal(result.essenceElements[0].klv.valueLength, payload.length);
  assert.equal(result.essenceElements[0].trackNumberHex, "15010c00");
  assert.equal(result.packets.length, 1);
  assert.equal(result.klvPackets.length, 1);

  const runIn = new Uint8Array(bytes.length + 7);
  runIn.set(bytes, 7);
  const blobResult = await module.demuxMxf(new Blob([runIn]));
  assert.equal(blobResult.essenceElements[0].klv.offset, 7);
  assert.deepEqual(Array.from(await blobResult.source.read(blobResult.packets[0].byteOffset, 4)), [1, 2, 3, 4]);

  const truncated = bytes.slice();
  truncated[17] = 100;
  await assert.rejects(() => module.demuxMxf(truncated), /extends beyond/);
}

async function testSyntheticMalformedKlv(module) {
  const essenceKey = "060e2b34010201010d01030115010c00";
  const partitionKey = "060e2b34020501010d01020101020400";
  const primerKey = "060e2b34020501010d01020101050100";
  const prefaceKey = "060e2b34025301010d01010101012f00";
  const indexKey = "060e2b34025301010d01020101100100";
  const randomIndexKey = "060e2b34020501010d01020101110100";

  await assert.rejects(
    module.demuxMxf(withRawLength(essenceKey, [0x80], new Uint8Array(16))),
    /indefinite BER length/
  );
  await assert.rejects(
    module.demuxMxf(withRawLength(essenceKey, [0x89], new Uint8Array(16))),
    /invalid 9-byte BER length/
  );
  await assert.rejects(
    module.demuxMxf(klv(partitionKey, new Uint8Array(4))),
    /partition pack.*only 4 bytes/
  );

  const inconsistentThisPartition = partitionPayload({ thisPartition: 1 });
  await assert.rejects(
    module.demuxMxf(klv(partitionKey, inconsistentThisPartition)),
    /declares ThisPartition 1/
  );

  const header = klv(partitionKey, partitionPayload());
  const footerOffset = header.byteLength;
  const footerKey = "060e2b34020501010d01020101040400";
  const footer = klv(footerKey, partitionPayload({
    thisPartition: footerOffset,
    previousPartition: 99,
    footerPartition: footerOffset
  }));
  await assert.rejects(
    module.demuxMxf(concatBytes(header, footer)),
    /links PreviousPartition 99, expected 0/
  );

  const missingFooter = partitionPayload({ footerPartition: 99 });
  await assert.rejects(module.demuxMxf(klv(partitionKey, missingFooter)), /is not a parsed footer/);

  const invalidPrimer = new Uint8Array(8);
  new DataView(invalidPrimer.buffer).setUint32(0, 1);
  new DataView(invalidPrimer.buffer).setUint32(4, 18);
  await assert.rejects(module.demuxMxf(klv(primerKey, invalidPrimer)), /Invalid MXF primer pack/);

  const overflowingLocalSet = Uint8Array.from([0x3c, 0x0a, 0, 16, 1]);
  await assert.rejects(module.demuxMxf(klv(prefaceKey, overflowingLocalSet)), /local tag.*overruns/);
  await assert.rejects(
    module.demuxMxf(klv(prefaceKey, Uint8Array.from([0, 0, 0, 0, 1]))),
    /local set.*trailing bytes/
  );

  const invalidIndexArray = new Uint8Array(12);
  invalidIndexArray.set([0x3f, 0x0a, 0, 8], 0);
  const invalidIndexView = new DataView(invalidIndexArray.buffer);
  invalidIndexView.setUint32(4, 1);
  invalidIndexView.setUint32(8, 10);
  await assert.rejects(module.demuxMxf(klv(indexKey, invalidIndexArray)), /Invalid MXF index entry array/);

  await assert.rejects(
    module.demuxMxf(klv(randomIndexKey, new Uint8Array(5))),
    /Invalid MXF random index pack/
  );
  const outOfRangeRandomIndex = new Uint8Array(16);
  const randomIndexView = new DataView(outOfRangeRandomIndex.buffer);
  randomIndexView.setUint32(0, 1);
  randomIndexView.setBigUint64(4, 10_000n);
  randomIndexView.setUint32(12, 16);
  await assert.rejects(
    module.demuxMxf(klv(randomIndexKey, outOfRangeRandomIndex)),
    /random index byte offset 10000 is outside/
  );
}

function klv(key, payload) {
  assert.equal(payload.byteLength < 128, true);
  return withRawLength(key, [payload.byteLength], payload);
}

function withRawLength(key, lengthBytes, payload) {
  const keyBytes = Uint8Array.from(key.match(/../g).map((value) => Number.parseInt(value, 16)));
  const result = new Uint8Array(keyBytes.byteLength + lengthBytes.length + payload.byteLength);
  result.set(keyBytes, 0);
  result.set(lengthBytes, keyBytes.byteLength);
  result.set(payload, keyBytes.byteLength + lengthBytes.length);
  return result;
}

function partitionPayload({
  thisPartition = 0,
  previousPartition = 0,
  footerPartition = 0,
  kagSize = 1,
  indexSid = 0,
  bodySid = 0
} = {}) {
  const bytes = new Uint8Array(88);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 1);
  view.setUint16(2, 3);
  view.setUint32(4, kagSize);
  view.setBigUint64(8, BigInt(thisPartition));
  view.setBigUint64(16, BigInt(previousPartition));
  view.setBigUint64(24, BigInt(footerPartition));
  view.setUint32(48, indexSid);
  view.setUint32(60, bodySid);
  view.setUint32(80, 0);
  view.setUint32(84, 16);
  return bytes;
}

function concatBytes(...parts) {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function findBytes(bytes, needle, start, end) {
  for (let offset = start; offset + needle.byteLength <= end; offset += 1) {
    if (needle.every((value, index) => bytes[offset + index] === value)) {
      return offset;
    }
  }
  return -1;
}

async function loadMxfModule() {
  const mxfModule = JSON.stringify(path.join(repoRoot, "src/mxf/index.ts"));
  const mxfIndexModule = JSON.stringify(path.join(repoRoot, "src/mxf/mxfIndex.ts"));
  const dnxMxfModule = JSON.stringify(path.join(repoRoot, "src/dnxMxf.ts"));
  const result = await build({
    stdin: {
      contents: `
        export * from ${mxfModule};
        export * from ${mxfIndexModule};
        export * from ${dnxMxfModule};
      `,
      resolveDir: repoRoot,
      sourcefile: "mxf-demux-test-entry.ts"
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "mxf-demux-test-"));
  const modulePath = path.join(tempDirectory, "mxf-demuxer.mjs");
  await writeFile(modulePath, result.outputFiles[0].text);
  const loaded = await import(`${pathToFileURL(modulePath)}?test=${Date.now()}`);
  await rm(tempDirectory, { recursive: true, force: true });
  return loaded;
}
