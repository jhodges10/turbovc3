#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const module = await loadModule();
const writes = [];
const context = {
  createImageData(width, height) {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
  },
  putImageData(imageData, x, y) {
    writes.push({ imageData, x, y });
  }
};
const canvas = {
  width: 0,
  height: 0,
  getContext(kind) {
    assert.equal(kind, "2d");
    return context;
  }
};
const renderer = module.DnxCanvasRenderer.create(canvas);
assert.ok(renderer);
assert.equal(renderer.isDestroyed, false);

renderer.render(makeYuvFrame("yuv444p8", 2, 1, [16, 235], [128, 128], [128, 128]));
assert.deepEqual(Array.from(writes.at(-1).imageData.data), [0, 0, 0, 255, 255, 255, 255, 255]);

renderer.render(makeYuvFrame("yuv422p10", 2, 1, [252, 252], [408], [960]));
assert.deepEqual(Array.from(writes.at(-1).imageData.data.slice(0, 4)), [255, 1, 0, 255]);

renderer.render(makeYuvFrame("yuv420p12", 2, 2, [256, 3760, 256, 3760], [2048], [2048]));
assert.deepEqual(
  Array.from(writes.at(-1).imageData.data),
  [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]
);

renderer.render(makeYuvFrame("gbrp10", 1, 1, [80], [120], [160]));
assert.deepEqual(Array.from(writes.at(-1).imageData.data), [40, 20, 30, 255]);
assert.equal(canvas.width, 1);
assert.equal(canvas.height, 1);
assert.equal(module.DnxCanvasRenderer.supports(makeYuvFrame("yuv422p8", 2, 1, [16, 16], [128], [128])), true);
assert.equal(
  module.DnxCanvasRenderer.supports({
    ...makeYuvFrame("yuv422p8", 2, 1, [16, 16], [128], [128]),
    colorSpace: { matrix: "bt2020-cl" }
  }),
  false
);
assert.equal(module.DnxCanvasRenderer.supports({ index: 0, timestampUs: 0, width: 1, height: 1, format: "rgba8" }), false);
assert.throws(() => renderer.render({ index: 0, timestampUs: 0, width: 1, height: 1, format: "rgba8" }), /does not support/);
renderer.destroy();
renderer.destroy();
assert.equal(renderer.isDestroyed, true);
assert.throws(
  () => renderer.render(makeYuvFrame("yuv444p8", 1, 1, [16], [128], [128])),
  /destroyed/
);
console.log("DNx Canvas2D renderer pixel contract passed.");

function makeYuvFrame(format, width, height, first, second, third) {
  const bytesPerSample = format.endsWith("p8") ? 1 : 2;
  const is444 = format.startsWith("yuv444") || format.startsWith("gbr");
  const is420 = format.startsWith("yuv420");
  const chromaWidth = is444 ? width : Math.ceil(width / 2);
  const chromaHeight = is420 ? Math.ceil(height / 2) : height;
  return {
    index: 0,
    timestampUs: 0,
    width,
    height,
    format,
    planes: [
      makePlane("Y", width, height, bytesPerSample, first),
      makePlane("Cb", chromaWidth, chromaHeight, bytesPerSample, second),
      makePlane("Cr", chromaWidth, chromaHeight, bytesPerSample, third)
    ]
  };
}

function makePlane(label, width, height, bytesPerSample, samples) {
  const bytes = new Uint8Array(width * height * bytesPerSample);
  samples.forEach((sample, index) => {
    bytes[index * bytesPerSample] = sample & 0xff;
    if (bytesPerSample === 2) bytes[index * bytesPerSample + 1] = sample >> 8;
  });
  return { label, width, height, stride: width * bytesPerSample, bytes };
}

async function loadModule() {
  const result = await build({
    entryPoints: [path.join(repoRoot, "src/dnxCanvasRenderer.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
