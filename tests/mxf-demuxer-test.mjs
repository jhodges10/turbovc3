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
await testLazyDnxAdapter(module, "tests/fixtures/dnxhr-lb-op1a-pcm.mxf");
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
await testFixture(module, "tests/fixtures/dnxhr-lb-opatom.mxf", {
  width: 1280,
  height: 720,
  frameCount: 1,
  frameRate: 30,
  operationalPattern: "060e2b34040101020d01020110030000"
});

console.log("MXF demuxer contracts passed.");

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

async function testAudioVideoFixture(module, relativePath, expectedFrameCount = 30) {
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
  assert.equal(video.descriptor?.width, 1280);
  assert.equal(video.descriptor?.height, 720);
  assert.equal(audio.packetCount, expectedFrameCount);
  assert.equal(audio.descriptor?.sampleRate?.numerator, 48000);
  assert.equal(audio.descriptor?.sampleRate?.denominator, 1);
  assert.equal(audio.descriptor?.channels, 2);
  assert.equal(audio.descriptor?.bitsPerSample, 16);
  if (expectedFrameCount > 1) {
    assert.equal(demuxer.packetsForTrack(audio)[1].timestampUs, 33333);
  }
  console.log(`${relativePath}: video and audio tracks resolved`);
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

async function loadMxfModule() {
  const mxfModule = JSON.stringify(path.join(repoRoot, "src/mxf/index.ts"));
  const dnxMxfModule = JSON.stringify(path.join(repoRoot, "src/dnxMxf.ts"));
  const result = await build({
    stdin: {
      contents: `
        export * from ${mxfModule};
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
