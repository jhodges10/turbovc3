#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const fixtureDir = path.resolve(repoRoot, args.fixtureDir ?? "samples");
const wasmKernelPath = path.join(repoRoot, "wasm/generated/dnx_idct_kernel.wasm");
const zigDecoderPath = path.join(repoRoot, "wasm/generated/dnx_row_decoder.wasm");
const frames = Number(args.frames ?? 3);
const ffmpeg = args.ffmpeg ?? process.env.FFMPEG ?? findExecutable("ffmpeg") ?? "/opt/homebrew/bin/ffmpeg";
const source = args.source ?? process.env.DNX_SOURCE ?? firstExisting([
  path.join(repoRoot, "samples/source.mov")
]);

const supportedFixtures = [
  {
    name: "dnxhd-720p30-8bit-cid1251",
    output: path.join(fixtureDir, "oracle_dnxhd_720p30_8bit_cid1251.mxf"),
    vf: "fps=30,scale=1280:720,format=yuv422p",
    bitrate: "90M",
    expected: {
      cid: 1251,
      width: 1280,
      height: 720,
      pixelFormat: "yuv422p8",
      frameCount: frames
    }
  },
  {
    name: "dnxhd-1080p30-8bit-cid1237",
    output: path.join(fixtureDir, "oracle_dnxhd_1080p30_8bit_cid1237.mxf"),
    vf: "fps=30,scale=1920:1080,format=yuv422p",
    bitrate: "145M",
    expected: {
      cid: 1237,
      width: 1920,
      height: 1080,
      pixelFormat: "yuv422p8",
      frameCount: frames
    }
  },
  {
    name: "dnxhd-1080p30-10bit-cid1235",
    output: path.join(fixtureDir, "oracle_dnxhd_1080p30_10bit_cid1235.mxf"),
    vf: "fps=30,scale=1920:1080,format=yuv422p10le",
    bitrate: "175M",
    oraclePixelFormat: "yuv422p10le",
    expected: {
      cid: 1235,
      width: 1920,
      height: 1080,
      pixelFormat: "yuv422p10",
      frameCount: frames
    }
  },
  {
    name: "dnxhr-lb-1080p30-8bit-cid1274",
    output: path.join(fixtureDir, "oracle_dnxhr_lb_1080p30_8bit_cid1274.mov"),
    vf: "fps=30,scale=1920:1080,format=yuv422p",
    profile: "dnxhr_lb",
    expected: {
      cid: 1274,
      profile: "dnxhr_lb",
      width: 1920,
      height: 1080,
      pixelFormat: "yuv422p8",
      frameCount: frames
    }
  },
  {
    name: "dnxhr-sq-1080p30-8bit-cid1273",
    output: path.join(fixtureDir, "oracle_dnxhr_sq_1080p30_8bit_cid1273.mov"),
    vf: "fps=30,scale=1920:1080,format=yuv422p",
    profile: "dnxhr_sq",
    expected: {
      cid: 1273,
      profile: "dnxhr_sq",
      width: 1920,
      height: 1080,
      pixelFormat: "yuv422p8",
      frameCount: frames
    }
  },
  {
    name: "dnxhr-hq-1080p30-8bit-cid1272",
    output: path.join(fixtureDir, "oracle_dnxhr_hq_1080p30_8bit_cid1272.mov"),
    vf: "fps=30,scale=1920:1080,format=yuv422p",
    profile: "dnxhr_hq",
    expected: {
      cid: 1272,
      profile: "dnxhr_hq",
      width: 1920,
      height: 1080,
      pixelFormat: "yuv422p8",
      frameCount: frames
    }
  },
  {
    name: "dnxhr-hqx-1080p30-10bit-cid1271",
    output: path.join(fixtureDir, "oracle_dnxhr_hqx_1080p30_10bit_cid1271.mov"),
    vf: "fps=30,scale=1920:1080,format=yuv422p10le",
    profile: "dnxhr_hqx",
    oraclePixelFormat: "yuv422p10le",
    expected: {
      cid: 1271,
      profile: "dnxhr_hqx",
      width: 1920,
      height: 1080,
      pixelFormat: "yuv422p10",
      frameCount: frames
    }
  },
  {
    name: "dnxhr-444-1080p30-10bit-cid1270",
    output: path.join(fixtureDir, "oracle_dnxhr_444_1080p30_10bit.mov"),
    vf: "fps=30,scale=1920:1080,format=yuv444p10le",
    profile: "dnxhr_444",
    oraclePixelFormat: "yuv444p10le",
    expected: {
      cid: 1270,
      profile: "dnxhr_444",
      width: 1920,
      height: 1080,
      pixelFormat: "yuv444p10",
      frameCount: frames
    }
  },
  {
    name: "dnxhr-hqx-1080p-12bit-cid1271-fate",
    output: path.join(fixtureDir, "oracle_fate_dnxhr_cid1271_12bit.mov"),
    generate: false,
    oraclePixelFormat: "yuv422p12le",
    expected: {
      cid: 1271,
      profile: "dnxhr_hqx",
      width: 1920,
      height: 1080,
      pixelFormat: "yuv422p12",
      frameCount: 1
    }
  }
];

const unsupportedFixtures = [];

const sustainedFixtures = [
  {
    name: "dnxhd-1080p30-10bit-30-frame-regression",
    output: path.join(fixtureDir, "playback_dnxhd_1080p30_10bit_30f.mxf"),
    expectedFrameCount: 30
  },
  {
    name: "dnxhr-lb-op1a-video-pcm-demux",
    output: path.join(fixtureDir, "mxf_demux_op1a_dnx_pcm.mxf"),
    expectedFrameCount: 30
  },
  {
    name: "dnxhr-lb-opatom-clip-wrapped-demux",
    output: path.join(fixtureDir, "mxf_demux_opatom_dnx.mxf"),
    expectedFrameCount: 30
  }
];

const primaryPlaybackFixtures = [
  {
    name: "dnxhr-lb-1080p60-primary",
    output: path.join(fixtureDir, "wip_gallery_page_1920x1080_60fps.mxf"),
    width: 1920,
    height: 1080,
    supported: true
  },
  {
    name: "dnxhr-lb-uhd60-primary",
    output: path.join(fixtureDir, "wip_gallery_page_3840x2160_60fps.mxf"),
    width: 3840,
    height: 2160,
    supported: true
  }
];

await main();

async function main() {
  console.log("DNx oracle test harness");
  console.log(`repo: ${repoRoot}`);

  if (args.generate) {
    if (!source) {
      if (!args.allowMissing) {
        throw new Error("No source media found. Pass --source <path> or set DNX_SOURCE.");
      }
      console.log("No source media found; fixture generation skipped.");
    } else {
      assertExecutable(ffmpeg);
      console.log(`source: ${source}`);
      for (const fixture of [...supportedFixtures, ...unsupportedFixtures].filter((candidate) => candidate.generate !== false)) {
        generateFixture(fixture);
      }
    }
  }

  const decoder = await loadBundledDecoder();
  runSyntheticHeaderTests(decoder);
  runSyntheticMxfTests(decoder);
  await runPrimaryPlaybackFixtureChecks(decoder);

  const presentSupported = supportedFixtures.filter((fixture) => existsSync(fixture.output));
  if (presentSupported.length !== supportedFixtures.length) {
    const missing = supportedFixtures.filter((fixture) => !existsSync(fixture.output));
    const message = `Missing DNx oracle fixtures: ${missing.map((fixture) => path.relative(repoRoot, fixture.output)).join(", ")}`;
    if (!args.allowMissing) {
      throw new Error(`${message}. Run npm run fixtures:generate -- --source <media>.`);
    }
    console.log(`${message}; running comparisons for the fixtures that are present.`);
  }

  if (args.requireNative && (!existsSync(wasmKernelPath) || !existsSync(zigDecoderPath))) {
    throw new Error("Native oracle checks require both generated WASM binaries. Run npm run build:wasm first.");
  }

  for (const fixture of presentSupported) {
    await runOracleComparison(decoder, fixture);
    if (path.extname(fixture.output).toLowerCase() === ".mov") {
      await assertCodecSessionDecodesAllFrames(decoder, fixture);
    }
  }

  for (const extensionCase of [
    { name: "dnxhr-lb-1080p30-8bit-cid1274", fourCc: "AVdh", format: "I422" },
    { name: "dnxhr-hqx-1080p30-10bit-cid1271", fourCc: "AVdh", format: "I422P10" },
    { name: "dnxhr-444-1080p30-10bit-cid1270", fourCc: "AVdh", format: "I444P10" },
    { name: "dnxhr-hqx-1080p-12bit-cid1271-fate", fourCc: "AVdh", format: "I422P12" }
  ]) {
    const extensionFixture = presentSupported.find((fixture) => fixture.name === extensionCase.name);
    if (extensionFixture) {
      await assertMediabunnyExtensionDecodes(
        decoder,
        extensionFixture,
        extensionCase.fourCc,
        extensionCase.format
      );
    }
  }

  const localAvdnPath = path.join(fixtureDir, "local_probe_dnxhd_720p_8bit.mov");
  if (existsSync(localAvdnPath)) {
    await assertMediabunnyExtensionDecodes(decoder, {
      name: "dnxhd-720p30-8bit-mediabunny-extension",
      output: localAvdnPath,
      expected: { width: 1280, height: 720 }
    }, "AVdn", "I422");
  }

  const presentUnsupported = unsupportedFixtures.filter((fixture) => existsSync(fixture.output));
  if (presentUnsupported.length > 0) {
    for (const fixture of presentUnsupported) {
      await assertUnsupportedFixture(decoder, fixture);
    }
  }

  for (const fixture of sustainedFixtures.filter((candidate) => existsSync(candidate.output))) {
    const decodedFrames = await decoder.decodeAllFramesZig(fixture.output, zigDecoderPath);
    assertEqual(decodedFrames, fixture.expectedFrameCount, `${fixture.name} Zig frame count`);
    const randomAccess = await decoder.decodeViaCodecSession(fixture.output, {
      startFrame: fixture.expectedFrameCount - 1,
      maxFrames: 1
    });
    assertEqual(randomAccess.frames.length, 1, `${fixture.name} random-access frame count`);
    assertEqual(
      randomAccess.frames[0]?.index,
      fixture.expectedFrameCount - 1,
      `${fixture.name} random-access frame index`
    );
    const requestedFrameDurationUs = 16_667;
    const persistentRandomAccess = await decoder.decodeRandomAccessFrames(
      fixture.output,
      [0, 15, 29],
      { frameDurationUs: requestedFrameDurationUs }
    );
    assertEqual(
      persistentRandomAccess.frameCount,
      fixture.expectedFrameCount,
      `${fixture.name} persistent random-access indexed frame count`
    );
    for (const [position, expectedIndex] of [0, 15, 29].entries()) {
      assertEqual(
        persistentRandomAccess.frames[position]?.index,
        expectedIndex,
        `${fixture.name} persistent random-access frame ${position}`
      );
    }
    assertEqual(
      persistentRandomAccess.frames[1]?.timestampUs,
      15 * requestedFrameDurationUs,
      `${fixture.name} persistent random-access timestamp`
    );
    assertEqual(
      persistentRandomAccess.frames[1]?.durationUs,
      requestedFrameDurationUs,
      `${fixture.name} persistent random-access duration`
    );
    console.log(`${fixture.name}: ${decodedFrames} Zig frames decoded`);
  }

  console.log("DNx oracle tests passed.");
}

function generateFixture(fixture) {
  const outputDir = path.dirname(fixture.output);
  const mkdir = spawnSync("mkdir", ["-p", outputDir], { stdio: "inherit" });
  if (mkdir.status !== 0) {
    throw new Error(`Failed to create ${outputDir}.`);
  }

  const codecArgs = fixture.profile
    ? ["-c:v", "dnxhd", "-profile:v", fixture.profile]
    : ["-c:v", "dnxhd", "-profile:v", "dnxhd", "-b:v", fixture.bitrate];
  const ffmpegArgs = [
    "-v", "error",
    "-y",
    "-i", source,
    "-vf", fixture.vf,
    "-frames:v", String(frames),
    ...codecArgs,
    "-an",
    fixture.output
  ];
  const result = spawnSync(ffmpeg, ffmpegArgs, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Failed to generate ${fixture.name}.`);
  }
  console.log(`generated ${path.relative(repoRoot, fixture.output)}`);
}

async function runOracleComparison(decoder, fixture) {
  const tmp = await mkdtemp(path.join(tmpdir(), "dnx-oracle-"));
  try {
    const goldenPath = fixture.output.replace(/\.[^.]+$/, ".yuv.gz");
    let oracleBytes;
    if (existsSync(goldenPath)) {
      oracleBytes = new Uint8Array(gunzipSync(await readFile(goldenPath)));
    } else {
      assertExecutable(ffmpeg);
      const rawPath = path.join(tmp, `${fixture.name}.yuv`);
      const ffmpegResult = spawnSync(ffmpeg, [
        "-v", "error",
        "-y",
        "-i", fixture.output,
        "-frames:v", "1",
        "-f", "rawvideo",
        "-pix_fmt", fixture.oraclePixelFormat ?? "yuv422p",
        rawPath
      ], { cwd: repoRoot, stdio: "inherit" });
      if (ffmpegResult.status !== 0) {
        throw new Error(`FFmpeg oracle decode failed for ${fixture.name}.`);
      }
      oracleBytes = new Uint8Array(await readFile(rawPath));
    }

    const decoded = await decoder.decodeFirstVisibleFrame(fixture.output);
    const useNative = existsSync(wasmKernelPath) && existsSync(zigDecoderPath);
    const wasmDecoded = useNative
      ? await decoder.decodeFirstVisibleFrameWasm(fixture.output, wasmKernelPath)
      : null;
    const zigDecoded = useNative
      ? await decoder.decodeFirstVisibleFrameZig(fixture.output, zigDecoderPath)
      : null;
    assertEqual(decoded.header.cid, fixture.expected.cid, `${fixture.name} CID`);
    assertEqual(decoded.header.width, fixture.expected.width, `${fixture.name} width`);
    assertEqual(decoded.header.height, fixture.expected.height, `${fixture.name} height`);
    assertEqual(decoded.header.pixelFormat, fixture.expected.pixelFormat, `${fixture.name} pixel format`);
    assertEqual(decoded.frameCount, fixture.expected.frameCount, `${fixture.name} frame count`);

    const stats = diffSamples(decoded.visibleBytes, oracleBytes, decoded.bytesPerSample);
    if (stats.maxAbsDiff > 1 || stats.countOver1 > 0) {
      throw new Error(`${fixture.name} exceeded oracle tolerance: ${JSON.stringify(stats)}`);
    }
    if (wasmDecoded && zigDecoded) {
      const wasmStats = diffSamples(wasmDecoded.visibleBytes, oracleBytes, wasmDecoded.bytesPerSample);
      if (wasmStats.maxAbsDiff > 1 || wasmStats.countOver1 > 0) {
        throw new Error(`${fixture.name} WASM decode exceeded oracle tolerance: ${JSON.stringify(wasmStats)}`);
      }
      const backendParity = diffSamples(wasmDecoded.visibleBytes, decoded.visibleBytes, decoded.bytesPerSample);
      if (backendParity.maxAbsDiff !== 0) {
        throw new Error(`${fixture.name} WASM and TypeScript decode differ: ${JSON.stringify(backendParity)}`);
      }
      const zigStats = diffSamples(zigDecoded.visibleBytes, oracleBytes, zigDecoded.bytesPerSample);
      if (zigStats.maxAbsDiff > 1 || zigStats.countOver1 > 0) {
        throw new Error(`${fixture.name} Zig decode exceeded oracle tolerance: ${JSON.stringify(zigStats)}`);
      }
      const zigBackendParity = diffSamples(zigDecoded.visibleBytes, decoded.visibleBytes, decoded.bytesPerSample);
      if (zigBackendParity.maxAbsDiff > 1 || zigBackendParity.countOver1 > 0) {
        throw new Error(`${fixture.name} Zig and TypeScript decode differ: ${JSON.stringify(zigBackendParity)}`);
      }
    }

    console.log(JSON.stringify({
      fixture: fixture.name,
      cid: decoded.header.cid,
      size: `${decoded.header.width}x${decoded.header.height}`,
      rowsDecoded: decoded.rowsDecoded,
      macroblocksDecoded: decoded.macroblocksDecoded,
      typescriptDecodeMs: decoded.elapsedMs,
      wasmDecodeMs: wasmDecoded?.elapsedMs ?? null,
      zigDecodeMs: zigDecoded?.elapsedMs ?? null,
      idctMode: wasmDecoded?.idctMode ?? "not-built",
      zigMode: zigDecoded?.idctMode ?? "not-built",
      ...stats
    }, null, 2));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function assertUnsupportedFixture(decoder, fixture) {
  const result = await decoder.inspectFirstPacket(fixture.output);
  if (!result.header || result.header.supported) {
    throw new Error(`${fixture.name} should be rejected as unsupported.`);
  }
  if (!result.header.unsupportedReasons.includes(fixture.expectedUnsupported)) {
    throw new Error(`${fixture.name} rejection did not include "${fixture.expectedUnsupported}".`);
  }
  const extension = await decoder.decodeViaMediabunnyExtension(fixture.output, false);
  assertEqual(extension.canDecode, false, `${fixture.name} Mediabunny decodability`);
  assertEqual(extension.warnings.length, 0, `${fixture.name} Mediabunny DNx warning count`);
  console.log(`${fixture.name}: ${result.header.unsupportedReasons.join(" ")}`);
}

async function assertCodecSessionDecodesAllFrames(decoder, fixture) {
  const result = await decoder.decodeViaCodecSession(fixture.output);
  const errors = result.events.filter((event) => event.type === "error");
  if (errors.length > 0) {
    throw new Error(`${fixture.name} codec session emitted errors: ${errors.map((event) => event.message).join("; ")}`);
  }

  assertEqual(result.metadata?.frameCount, fixture.expected.frameCount, `${fixture.name} codec session metadata frame count`);
  assertEqual(result.frames.length, fixture.expected.frameCount, `${fixture.name} codec session decoded frame count`);
  assertEqual(result.doneFrames, fixture.expected.frameCount, `${fixture.name} codec session done frame count`);

  for (const [index, frame] of result.frames.entries()) {
    assertEqual(frame.index, index, `${fixture.name} codec session frame index ${index}`);
    assertEqual(frame.width, fixture.expected.width, `${fixture.name} codec session frame width ${index}`);
    assertEqual(frame.height, fixture.expected.height, `${fixture.name} codec session frame height ${index}`);
    assertEqual(frame.format, fixture.expected.pixelFormat, `${fixture.name} codec session frame format ${index}`);
  }

  if (fixture.expected.frameCount > 1) {
    const randomAccess = await decoder.decodeViaCodecSession(fixture.output, { startFrame: 1, maxFrames: 1 });
    assertEqual(randomAccess.frames.length, 1, `${fixture.name} random-access frame count`);
    assertEqual(randomAccess.frames[0]?.index, 1, `${fixture.name} random-access frame index`);
  }
}

async function assertMediabunnyExtensionDecodes(decoder, fixture, expectedFourCc, expectedFormat) {
  const result = await decoder.decodeViaMediabunnyExtension(fixture.output);
  assertEqual(result.codec, "dnx", `${fixture.name} Mediabunny codec`);
  assertEqual(result.codecParameterString, expectedFourCc, `${fixture.name} Mediabunny codec parameter`);
  assertEqual(result.canDecode, true, `${fixture.name} Mediabunny decodability`);
  assertEqual(result.hasOnlyKeyPackets, true, `${fixture.name} Mediabunny key-packet state`);
  assertEqual(result.format, expectedFormat, `${fixture.name} Mediabunny sample format`);
  assertEqual(result.width, fixture.expected.width, `${fixture.name} Mediabunny sample width`);
  assertEqual(result.height, fixture.expected.height, `${fixture.name} Mediabunny sample height`);
  if (fixture.expected.frameCount !== undefined) {
    assertEqual(result.frameCount, fixture.expected.frameCount, `${fixture.name} Mediabunny sample count`);
  }
  assertEqual(result.timestampsOrdered, true, `${fixture.name} Mediabunny timestamp order`);
  assertEqual(result.warnings.length, 0, `${fixture.name} Mediabunny DNx warning count`);
  console.log(`${fixture.name}: registerDnxDecoder VideoSampleSink decode passed`);
}

function runSyntheticHeaderTests(decoder) {
  const supported1237 = decoder.parseSyntheticHeader({
    cid: 1237,
    width: 1920,
    height: 1080,
    bitDepthIndicator: 1,
    macroblockHeight: 68,
    packetLength: 606208
  });
  assertEqual(supported1237?.supported, true, "CID 1237 should parse as supported header");
  assertEqual(supported1237?.pixelFormat, "yuv422p8", "CID 1237 pixel format");

  const supported1251 = decoder.parseSyntheticHeader({
    cid: 1251,
    width: 1280,
    height: 720,
    bitDepthIndicator: 1,
    macroblockHeight: 45,
    packetLength: 458752
  });
  assertEqual(supported1251?.supported, true, "CID 1251 should parse as supported header");
  assertEqual(supported1251?.pixelFormat, "yuv422p8", "CID 1251 pixel format");

  const tenBitHeader = decoder.parseSyntheticHeader({
    cid: 1250,
    width: 1280,
    height: 720,
    bitDepthIndicator: 2,
    macroblockHeight: 45,
    packetLength: 458752
  });
  assertEqual(tenBitHeader?.pixelFormat, "yuv422p10", "CID 1250 pixel format");

  const supported444 = decoder.parseSyntheticHeader({
    cid: 1270,
    width: 1920,
    height: 1080,
    bitDepthIndicator: 2,
    is444: true,
    macroblockHeight: 68,
    packetLength: 1835008
  });
  assertEqual(supported444?.supported, true, "10-bit DNxHR 444 should be supported");
  assertEqual(supported444?.pixelFormat, "gbrp10", "DNxHR 444 RGB pixel format");

  const supported12Bit = decoder.parseSyntheticHeader({
    cid: 1271,
    width: 1920,
    height: 1080,
    bitDepthIndicator: 3,
    macroblockHeight: 68,
    packetLength: 1835008
  });
  assertEqual(supported12Bit?.supported, true, "12-bit DNxHR HQX should be supported");
  assertEqual(supported12Bit?.pixelFormat, "yuv422p12", "12-bit DNxHR HQX pixel format");

  const interlaced = decoder.parseSyntheticHeader({
    cid: 1237,
    width: 1920,
    height: 1080,
    bitDepthIndicator: 1,
    interlaced: true,
    macroblockHeight: 68,
    packetLength: 606208
  });
  assertEqual(interlaced?.supported, false, "Interlaced DNxHD should be unsupported");
  console.log("synthetic header tests passed");
}

function runSyntheticMxfTests(decoder) {
  const editRate = decoder.parseSyntheticMxfEditRate(60, 1);
  assertEqual(editRate?.numerator, 60, "MXF edit-rate numerator");
  assertEqual(editRate?.denominator, 1, "MXF edit-rate denominator");
  assertEqual(editRate?.framesPerSecond, 60, "MXF edit-rate FPS");
  assertEqual(decoder.parseSyntheticMxfEditRate(0, 1), null, "invalid MXF edit rate");
  console.log("synthetic MXF timing tests passed");
}

async function runPrimaryPlaybackFixtureChecks(decoder) {
  for (const fixture of primaryPlaybackFixtures.filter((candidate) => existsSync(candidate.output))) {
    const prefix = await readPrefix(fixture.output, 8 * 1024 * 1024);
    const inspection = decoder.inspectDnxPrefix(prefix);
    assertEqual(inspection.editRate?.framesPerSecond, 60, `${fixture.name} edit rate`);
    assertEqual(inspection.header?.cid, 1274, `${fixture.name} CID`);
    assertEqual(inspection.header?.width, fixture.width, `${fixture.name} width`);
    assertEqual(inspection.header?.height, fixture.height, `${fixture.name} height`);
    assertEqual(inspection.header?.supported, fixture.supported, `${fixture.name} support state`);
    if (fixture.supported) {
      const decoded = await decoder.decodeDnxPrefixFirstFrameZig(prefix, zigDecoderPath);
      assertEqual(decoded.width, fixture.width, `${fixture.name} decoded width`);
      assertEqual(decoded.height, fixture.height, `${fixture.name} decoded height`);
      assertEqual(decoded.rowsDecoded, Math.ceil(fixture.height / 16), `${fixture.name} decoded rows`);
      console.log(
        `${fixture.name}: 60 FPS CID 1274 ${fixture.width}x${fixture.height} decoded in ${decoded.elapsedMs} ms`
      );
    }
  }
}

async function loadBundledDecoder() {
  const tmp = await mkdtemp(path.join(tmpdir(), "dnx-bundle-"));
  const frameModule = JSON.stringify(path.join(repoRoot, "src/dnxFrame.ts"));
  const scalarModule = JSON.stringify(path.join(repoRoot, "src/dnxScalarDecoder.ts"));
  const idctModule = JSON.stringify(path.join(repoRoot, "src/dnxIdctKernel.ts"));
  const zigModule = JSON.stringify(path.join(repoRoot, "src/dnxZigRowDecoder.ts"));
  const mxfModule = JSON.stringify(path.join(repoRoot, "src/dnxMxf.ts"));
  const codecModule = JSON.stringify(path.join(repoRoot, "src/dnxCodec.ts"));
  const mediabunnyModule = JSON.stringify(path.join(repoRoot, "src/dnxMediabunny.ts"));
  const randomAccessModule = JSON.stringify(path.join(repoRoot, "src/dnxRandomAccessDecoder.ts"));
  const entry = `
    import { readFile } from "node:fs/promises";
    import { performance } from "node:perf_hooks";
    import { BufferSource, Input, QuickTimeInputFormat, VideoSampleSink } from "mediabunny";
    import { findDnxFrameHeader, findDnxFramePackets, parseDnxFrameHeader } from ${frameModule};
    import { decodeDnxScalarFrame } from ${scalarModule};
    import { createDnxWasmIdctKernel } from ${idctModule};
    import { createDnxWasmRowDecoder } from ${zigModule};
    import { parseDnxMxfEditRate } from ${mxfModule};
    import { dnxCodec } from ${codecModule};
    import { registerDnxDecoder } from ${mediabunnyModule};
    import { DnxRandomAccessDecoder } from ${randomAccessModule};

    export function parseSyntheticHeader(options) {
      return parseDnxFrameHeader(makeSyntheticPacket(options));
    }

    export function parseSyntheticMxfEditRate(numerator, denominator) {
      const bytes = new Uint8Array(64);
      bytes.set([0x06, 0x0e, 0x2b, 0x34], 0);
      bytes.set([0x4b, 0x01, 0x00, 0x08], 16);
      const view = new DataView(bytes.buffer);
      view.setUint32(20, numerator);
      view.setUint32(24, denominator);
      return parseDnxMxfEditRate(bytes);
    }

    export function inspectDnxPrefix(bytes) {
      return {
        editRate: parseDnxMxfEditRate(bytes),
        header: findDnxFrameHeader(bytes)?.header ?? null
      };
    }

    export async function inspectFirstPacket(filePath) {
      const bytes = new Uint8Array(await readFile(filePath));
      const packets = findDnxFramePackets(bytes);
      return { frameCount: packets.length, header: packets[0]?.header ?? null };
    }

    export async function decodeFirstVisibleFrame(filePath) {
      return decodeFirstVisibleFrameWithKernel(filePath);
    }

    export async function decodeFirstVisibleFrameWasm(filePath, wasmPath) {
      const kernel = await createDnxWasmIdctKernel(await readFile(wasmPath));
      try {
        return await decodeFirstVisibleFrameWithKernel(filePath, kernel);
      } finally {
        kernel.destroy();
      }
    }

    export async function decodeFirstVisibleFrameZig(filePath, wasmPath) {
      const rowDecoder = await createDnxWasmRowDecoder(await readFile(wasmPath));
      try {
        return await decodeFirstVisibleFrameWithKernel(filePath, undefined, rowDecoder);
      } finally {
        rowDecoder.destroy();
      }
    }

    export async function decodeDnxPrefixFirstFrameZig(bytes, wasmPath) {
      const packets = findDnxFramePackets(bytes, { maxFrames: 1 });
      if (packets.length === 0) {
        throw new Error("No complete DNx packet found in prefix.");
      }
      const packet = packets[0];
      const rowDecoder = await createDnxWasmRowDecoder(await readFile(wasmPath));
      try {
        const start = performance.now();
        const decoded = decodeDnxScalarFrame(packet.bytes, packet.header, undefined, rowDecoder);
        return {
          width: packet.header.width,
          height: packet.header.height,
          rowsDecoded: decoded.rowsDecoded,
          elapsedMs: Math.round(performance.now() - start)
        };
      } finally {
        rowDecoder.destroy();
      }
    }

    export async function decodeAllFramesZig(filePath, wasmPath) {
      const bytes = new Uint8Array(await readFile(filePath));
      const packets = findDnxFramePackets(bytes);
      const rowDecoder = await createDnxWasmRowDecoder(await readFile(wasmPath));
      try {
        for (const packet of packets) {
          decodeDnxScalarFrame(packet.bytes, packet.header, undefined, rowDecoder);
        }
        return packets.length;
      } finally {
        rowDecoder.destroy();
      }
    }

    async function decodeFirstVisibleFrameWithKernel(filePath, idctKernel, rowDecoder) {
      const bytes = new Uint8Array(await readFile(filePath));
      const packets = findDnxFramePackets(bytes);
      if (packets.length === 0) {
        throw new Error("No DNx packets found in " + filePath);
      }
      const packet = packets[0];
      const start = performance.now();
      const decoded = decodeDnxScalarFrame(packet.bytes, packet.header, idctKernel, rowDecoder);
      const elapsedMs = Math.round(performance.now() - start);
      const [y, cb, cr] = decoded.layout.planes;
      const width = packet.header.width;
      const height = packet.header.height;
      const bytesPerSample = decoded.layout.bytesPerSample;
      const chromaWidth = packet.header.is444 ? width : width / 2;
      const visibleBytes = new Uint8Array(width * height * bytesPerSample + 2 * chromaWidth * height * bytesPerSample);
      let cursor = 0;

      for (let row = 0; row < height; row += 1) {
        const rowByteLength = width * bytesPerSample;
        visibleBytes.set(y.bytes.subarray(row * y.stride, row * y.stride + rowByteLength), cursor);
        cursor += rowByteLength;
      }
      for (const plane of [cb, cr]) {
        for (let row = 0; row < height; row += 1) {
          const rowByteLength = chromaWidth * bytesPerSample;
          visibleBytes.set(plane.bytes.subarray(row * plane.stride, row * plane.stride + rowByteLength), cursor);
          cursor += rowByteLength;
        }
      }

      return {
        header: packet.header,
        frameCount: packets.length,
        rowsDecoded: decoded.rowsDecoded,
        macroblocksDecoded: decoded.macroblocksDecoded,
        elapsedMs,
        idctMode: rowDecoder?.mode ?? idctKernel?.mode ?? "typescript-idct",
        bytesPerSample,
        visibleBytes
      };
    }

    export async function decodeViaCodecSession(filePath, options = {}) {
      const bytes = new Uint8Array(await readFile(filePath));
      const session = await dnxCodec.createSession({ preferWebGpu: false, ...options });
      const events = [];
      const frames = [];
      let metadata = null;
      let doneFrames = null;

      try {
        for await (const event of session.decode({ bytes, filename: filePath })) {
          events.push(event);
          if (event.type === "metadata") {
            metadata = event;
          } else if (event.type === "frame") {
            frames.push({
              index: event.frame.index,
              timestampUs: event.frame.timestampUs,
              durationUs: event.frame.durationUs,
              width: event.frame.width,
              height: event.frame.height,
              format: event.frame.format
            });
          } else if (event.type === "done") {
            doneFrames = event.framesDecoded;
          }
        }
      } finally {
        await session.close();
      }

      return { events, frames, metadata, doneFrames };
    }

    export async function decodeRandomAccessFrames(filePath, indices, options = {}) {
      const bytes = new Uint8Array(await readFile(filePath));
      const decoder = await DnxRandomAccessDecoder.create(bytes, { concurrency: 0, ...options });
      if (decoder instanceof Error) {
        throw decoder;
      }

      try {
        const frames = [];
        for (const index of indices) {
          const frame = await decoder.decode(index);
          if (frame instanceof Error) {
            throw frame;
          }
          frames.push({
            index: frame.index,
            timestampUs: frame.timestampUs,
            durationUs: frame.durationUs,
            width: frame.width,
            height: frame.height,
            format: frame.format
          });
        }
        return { frameCount: decoder.frameCount, frames };
      } finally {
        await decoder.close();
      }
    }

    export async function decodeViaMediabunnyExtension(filePath, decodeSamples = true) {
      registerDnxDecoder();
      registerDnxDecoder();

      const bytes = new Uint8Array(await readFile(filePath));
      const input = new Input({
        formats: [new QuickTimeInputFormat()],
        source: new BufferSource(bytes)
      });
      try {
        const warnings = [];
        const consoleWarn = console.warn;
        console.warn = (...args) => warnings.push(args.map(String).join(" "));
        let track;
        try {
          track = await input.getPrimaryVideoTrack();
        } finally {
          console.warn = consoleWarn;
        }
        if (!track) {
          throw new Error("Mediabunny did not find a video track in " + filePath);
        }

        const [codec, codecParameterString, canDecode, hasOnlyKeyPackets] = await Promise.all([
          track.getCodec(),
          track.getCodecParameterString(),
          track.canDecode(),
          track.hasOnlyKeyPackets()
        ]);
        if (!decodeSamples) {
          return { codec, codecParameterString, canDecode, hasOnlyKeyPackets, warnings };
        }
        const samples = [];
        for await (const sample of new VideoSampleSink(track).samples()) {
          try {
            samples.push({
              format: sample.format,
              width: sample.visibleRect.width,
              height: sample.visibleRect.height,
              timestamp: sample.timestamp,
              duration: sample.duration
            });
          } finally {
            sample.close();
          }
        }
        const firstSample = samples[0];
        if (!firstSample) {
          throw new Error("Mediabunny did not decode a DNx sample from " + filePath);
        }
        return {
          codec,
          codecParameterString,
          canDecode,
          hasOnlyKeyPackets,
          format: firstSample.format,
          width: firstSample.width,
          height: firstSample.height,
          timestamp: firstSample.timestamp,
          duration: firstSample.duration,
          frameCount: samples.length,
          timestampsOrdered: samples.every((sample, index) => index === 0 || sample.timestamp > samples[index - 1].timestamp),
          warnings
        };
      } finally {
        input.dispose();
      }
    }

    function makeSyntheticPacket(options) {
      const bytes = new Uint8Array(options.packetLength ?? 0x280);
      bytes[0] = 0x00;
      bytes[1] = 0x00;
      bytes[2] = 0x02;
      bytes[3] = 0x80;
      bytes[4] = options.is444 ? 0x02 : 0x01;
      if (options.interlaced) {
        bytes[5] |= 0x02;
      }
      writeU16BE(bytes, 0x18, options.height);
      writeU16BE(bytes, 0x1a, options.width);
      bytes[0x21] = options.bitDepthIndicator << 5;
      writeU32BE(bytes, 0x28, options.cid);
      if (options.is444) {
        bytes[0x2c] |= 0x40;
      }
      writeU16BE(bytes, 0x16c, options.macroblockHeight);
      return bytes;
    }

    function writeU16BE(bytes, offset, value) {
      bytes[offset] = (value >> 8) & 0xff;
      bytes[offset + 1] = value & 0xff;
    }

    function writeU32BE(bytes, offset, value) {
      bytes[offset] = (value >>> 24) & 0xff;
      bytes[offset + 1] = (value >>> 16) & 0xff;
      bytes[offset + 2] = (value >>> 8) & 0xff;
      bytes[offset + 3] = value & 0xff;
    }
  `;
  const bundledPath = path.join(tmp, "dnx-oracle-bundle.mjs");
  const result = await build({
    stdin: {
      contents: entry,
      resolveDir: repoRoot,
      sourcefile: "dnx-oracle-bundle.ts",
      loader: "ts"
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false
  });
  await writeFile(bundledPath, result.outputFiles[0].text);
  return import(pathToFileURL(bundledPath).href);
}

function diffSamples(actual, expected, bytesPerSample) {
  if (actual.length !== expected.length) {
    throw new Error(`Byte length mismatch ${actual.length} !== ${expected.length}.`);
  }

  let maxAbsDiff = 0;
  let countOver1 = 0;
  let countOver2 = 0;
  let countOver8 = 0;
  let sum = 0;
  const sampleCount = actual.length / bytesPerSample;
  for (let index = 0; index < actual.length; index += bytesPerSample) {
    const actualSample = readSample(actual, index, bytesPerSample);
    const expectedSample = readSample(expected, index, bytesPerSample);
    const diff = Math.abs(actualSample - expectedSample);
    maxAbsDiff = Math.max(maxAbsDiff, diff);
    if (diff > 1) countOver1 += 1;
    if (diff > 2) countOver2 += 1;
    if (diff > 8) countOver8 += 1;
    sum += diff;
  }

  return {
    decodedBytes: actual.length,
    decodedSamples: sampleCount,
    maxAbsDiff,
    meanAbsDiff: sum / sampleCount,
    countOver1,
    countOver2,
    countOver8
  };
}

function readSample(bytes, index, bytesPerSample) {
  if (bytesPerSample === 1) {
    return bytes[index];
  }

  return bytes[index] | (bytes[index + 1] << 8);
}

async function readPrefix(filePath, byteLength) {
  const handle = await open(filePath, "r");
  try {
    const bytes = new Uint8Array(byteLength);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--allow-missing":
        parsed.allowMissing = true;
        break;
      case "--generate":
        parsed.generate = true;
        break;
      case "--require-native":
        parsed.requireNative = true;
        break;
      case "--ffmpeg":
        parsed.ffmpeg = argv[++index];
        break;
      case "--fixture-dir":
        parsed.fixtureDir = argv[++index];
        break;
      case "--frames":
        parsed.frames = argv[++index];
        break;
      case "--source":
        parsed.source = path.resolve(repoRoot, argv[++index]);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function findExecutable(command) {
  const result = spawnSync("which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function firstExisting(paths) {
  return paths.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

function assertExecutable(file) {
  if (!file || !existsSync(file)) {
    throw new Error(`Executable not found: ${file}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}
