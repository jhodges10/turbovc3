#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const module = await loadModule();

for (const [suffix, bytesPerSample] of [["8", 1], ["10", 2], ["12", 2]]) {
  const source = makePadded422Layout(bytesPerSample, suffix);
  const yuv420 = module.convertDnxFrameLayout(source, `yuv422p${suffix}`, `yuv420p${suffix}`);
  assertLayout(yuv420, [16, 8, 8], [16, 8, 8], bytesPerSample);
  assert.equal(readSample(yuv420.planes[0], 15, 15, bytesPerSample), sampleValue(0, 15, 15, suffix));
  assert.equal(
    readSample(yuv420.planes[1], 7, 7, bytesPerSample),
    (sampleValue(1, 7, 14, suffix) + sampleValue(1, 7, 15, suffix) + 1) >> 1
  );

  const yuv444 = module.convertDnxFrameLayout(source, `yuv422p${suffix}`, `yuv444p${suffix}`);
  assertLayout(yuv444, [16, 16, 16], [16, 16, 16], bytesPerSample);
  assert.equal(readSample(yuv444.planes[1], 14, 15, bytesPerSample), sampleValue(1, 7, 15, suffix));
  assert.equal(readSample(yuv444.planes[1], 15, 15, bytesPerSample), sampleValue(1, 7, 15, suffix));

  assertPaddedFrameCopy(module, yuv420);
  assertPaddedFrameCopy(module, yuv444);
}

console.log("DNx odd-visible, coded-edge, and plane-stride contracts passed.");

function makePadded422Layout(bytesPerSample, suffix) {
  const codedWidth = 16;
  const codedHeight = 16;
  const widths = [codedWidth, codedWidth / 2, codedWidth / 2];
  const labels = ["Y", "Cb", "Cr"];
  const planes = widths.map((width, planeIndex) => {
    const stride = width * bytesPerSample + 6;
    const bytes = new Uint8Array(stride * codedHeight).fill(0xee);
    const plane = { label: labels[planeIndex], width, height: codedHeight, stride, bytes };
    for (let y = 0; y < codedHeight; y += 1) {
      for (let x = 0; x < width; x += 1) {
        writeSample(plane, x, y, bytesPerSample, sampleValue(planeIndex, x, y, suffix));
      }
    }
    return plane;
  });
  return {
    codedWidth,
    codedHeight,
    visibleWidth: 5,
    visibleHeight: 3,
    chromaWidth: 8,
    chromaHeight: 16,
    bytesPerSample,
    planes
  };
}

function assertLayout(layout, widths, heights, bytesPerSample) {
  assert.equal(layout.visibleWidth, 5);
  assert.equal(layout.visibleHeight, 3);
  assert.deepEqual(layout.planes.map((plane) => plane.width), widths);
  assert.deepEqual(layout.planes.map((plane) => plane.height), heights);
  assert.deepEqual(layout.planes.map((plane) => plane.stride), widths.map((width) => width * bytesPerSample));
}

function assertPaddedFrameCopy(module, layout) {
  const frame = new module.Frame();
  frame.layout = layout;
  frame.frameData = layout.planes[0].bytes;
  const requested = [];
  let offset = 11;
  for (const plane of layout.planes) {
    requested.push({ offset, stride: plane.width * layout.bytesPerSample + 5 });
    offset += requested.at(-1).stride * plane.height + 7;
  }
  const destination = new Uint8Array(frame.allocationSize(requested)).fill(0xa5);
  const resolved = frame.copyTo(destination, requested);
  for (let planeIndex = 0; planeIndex < layout.planes.length; planeIndex += 1) {
    const source = layout.planes[planeIndex];
    const target = resolved[planeIndex];
    for (let row = 0; row < source.height; row += 1) {
      const sourceStart = row * source.stride;
      const targetStart = target.offset + row * target.stride;
      assert.deepEqual(
        destination.subarray(targetStart, targetStart + target.rowBytes),
        source.bytes.subarray(sourceStart, sourceStart + target.rowBytes)
      );
      if (row + 1 < source.height) {
        assert.deepEqual(
          destination.subarray(targetStart + target.rowBytes, targetStart + target.stride),
          new Uint8Array(target.stride - target.rowBytes).fill(0xa5)
        );
      }
    }
  }
}

function sampleValue(plane, x, y, suffix) {
  const maximum = suffix === "8" ? 255 : suffix === "10" ? 1023 : 4095;
  return (plane * 701 + y * 29 + x * 7) & maximum;
}

function readSample(plane, x, y, bytesPerSample) {
  const offset = y * plane.stride + x * bytesPerSample;
  return bytesPerSample === 1 ? plane.bytes[offset] : plane.bytes[offset] | (plane.bytes[offset + 1] << 8);
}

function writeSample(plane, x, y, bytesPerSample, value) {
  const offset = y * plane.stride + x * bytesPerSample;
  plane.bytes[offset] = value & 0xff;
  if (bytesPerSample === 2) plane.bytes[offset + 1] = value >> 8;
}

async function loadModule() {
  const result = await build({
    stdin: {
      contents: `
        export { Frame } from ${JSON.stringify(path.join(repoRoot, "src/dnxDecoder.ts"))};
        export { convertDnxFrameLayout } from ${JSON.stringify(path.join(repoRoot, "src/dnxPixelConversion.ts"))};
      `,
      resolveDir: repoRoot,
      sourcefile: "dnx-edge-layout-entry.ts"
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
