#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const module = await loadConversionModule();

for (const bytesPerSample of [1, 2]) {
  const suffix = bytesPerSample === 1 ? "8" : "10";
  const sourceFormat = `yuv422p${suffix}`;
  const source = makeLayout(bytesPerSample);

  const yuv420 = module.convertDnxFrameLayout(source, sourceFormat, `yuv420p${suffix}`);
  assert.equal(yuv420.chromaWidth, 2);
  assert.equal(yuv420.chromaHeight, 2);
  assert.deepEqual(readPlane(yuv420.planes[0], bytesPerSample), readPlane(source.planes[0], bytesPerSample));
  assert.deepEqual(readPlane(yuv420.planes[1], bytesPerSample), [20, 30, 60, 70]);
  assert.deepEqual(readPlane(yuv420.planes[2], bytesPerSample), [120, 130, 160, 170]);

  const yuv444 = module.convertDnxFrameLayout(source, sourceFormat, `yuv444p${suffix}`);
  assert.equal(yuv444.chromaWidth, 4);
  assert.equal(yuv444.chromaHeight, 4);
  assert.deepEqual(
    readPlane(yuv444.planes[1], bytesPerSample),
    [10, 10, 20, 20, 30, 30, 40, 40, 50, 50, 60, 60, 70, 70, 80, 80]
  );
}

assert.equal(module.selectDnxOutputFormat("yuv422p8", ["yuv444p8", "yuv420p8"]), "yuv444p8");
assert.equal(module.selectDnxOutputFormat("yuv422p10", ["yuv420p8", "yuv420p10"]), "yuv420p10");
assert.equal(module.selectDnxOutputFormat("yuv422p10", ["yuv420p8"]), null);
assert.equal(module.selectDnxOutputFormat("gbrp10", ["yuv444p10"]), "yuv444p10");
assert.equal(module.selectDnxOutputFormat("yuv422p12", ["yuv444p12"]), "yuv444p12");
assert.equal(module.selectDnxOutputFormat("gbrp12", ["yuv444p12"]), "yuv444p12");

for (const [rgb, expected] of [
  [[0, 0, 0], [64, 512, 512]],
  [[1023, 1023, 1023], [940, 512, 512]],
  [[1023, 0, 0], [250, 409, 960]]
]) {
  const [r, g, b] = rgb;
  const converted = module.convertDnxFrameLayout(makeGbrLayout(g, b, r), "gbrp10", "yuv444p10", "bt709");
  assert.deepEqual(converted.planes.map((plane) => readPlane(plane, 2)[0]), expected);
}

for (const [rgb, expected] of [
  [[0, 0, 0], [256, 2048, 2048]],
  [[4095, 4095, 4095], [3760, 2048, 2048]],
  [[4095, 0, 0], [1001, 1637, 3840]]
]) {
  const [r, g, b] = rgb;
  const converted = module.convertDnxFrameLayout(makeGbrLayout(g, b, r), "gbrp12", "yuv444p12", "bt709");
  assert.deepEqual(converted.planes.map((plane) => readPlane(plane, 2)[0]), expected);
}
console.log("DNx planar output conversion passed.");

async function loadConversionModule() {
  const result = await build({
    entryPoints: [path.join(packageRoot, "src/dnxPixelConversion.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function makeLayout(bytesPerSample) {
  const values = [
    Array.from({ length: 16 }, (_, index) => index),
    [10, 20, 30, 40, 50, 60, 70, 80],
    [110, 120, 130, 140, 150, 160, 170, 180]
  ];
  const widths = [4, 2, 2];
  const labels = ["Y", "Cb", "Cr"];
  const byteLengths = values.map((plane) => plane.length * bytesPerSample);
  const bytes = new Uint8Array(byteLengths.reduce((sum, length) => sum + length, 0));
  let byteOffset = 0;
  const planes = values.map((samples, index) => {
    const planeBytes = bytes.subarray(byteOffset, byteOffset + byteLengths[index]);
    const plane = {
      label: labels[index],
      width: widths[index],
      height: 4,
      stride: widths[index] * bytesPerSample,
      bytes: planeBytes
    };
    samples.forEach((sample, sampleIndex) => writeSample(planeBytes, sampleIndex, bytesPerSample, sample));
    byteOffset += byteLengths[index];
    return plane;
  });
  return {
    codedWidth: 4,
    codedHeight: 4,
    visibleWidth: 4,
    visibleHeight: 4,
    chromaWidth: 2,
    chromaHeight: 4,
    bytesPerSample,
    planes
  };
}

function makeGbrLayout(g, b, r) {
  const bytes = new Uint8Array(6);
  const planes = [g, b, r].map((sample, index) => {
    const planeBytes = bytes.subarray(index * 2, index * 2 + 2);
    writeSample(planeBytes, 0, 2, sample);
    return { label: ["G", "B", "R"][index], width: 1, height: 1, stride: 2, bytes: planeBytes };
  });
  return {
    codedWidth: 1,
    codedHeight: 1,
    visibleWidth: 1,
    visibleHeight: 1,
    chromaWidth: 1,
    chromaHeight: 1,
    bytesPerSample: 2,
    planes
  };
}

function readPlane(plane, bytesPerSample) {
  return Array.from({ length: plane.width * plane.height }, (_, index) => {
    const offset = index * bytesPerSample;
    return bytesPerSample === 1 ? plane.bytes[offset] : plane.bytes[offset] | (plane.bytes[offset + 1] << 8);
  });
}

function writeSample(bytes, index, bytesPerSample, sample) {
  const offset = index * bytesPerSample;
  bytes[offset] = sample & 0xff;
  if (bytesPerSample === 2) {
    bytes[offset + 1] = sample >> 8;
  }
}
