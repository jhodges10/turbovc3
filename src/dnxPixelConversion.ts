import type { DecodePlane } from "./core/codec.js";
import type { DnxPixelFormat } from "./dnxDecoder.js";
import type { DnxFrameLayout } from "./dnxReconstruction.js";

export type DnxConvertiblePixelFormat =
  | "yuv420p8"
  | "yuv420p10"
  | "yuv422p8"
  | "yuv422p10"
  | "yuv422p12"
  | "yuv444p8"
  | "yuv444p10"
  | "yuv444p12";

export function selectDnxOutputFormat(
  source: DnxPixelFormat,
  allowed: readonly DnxPixelFormat[]
): DnxPixelFormat | null {
  if (allowed.includes(source)) {
    return source;
  }
  if (source === "gbrp10" || source === "gbrp12") {
    const target = source === "gbrp10" ? "yuv444p10" : "yuv444p12";
    return allowed.includes(target) ? target : null;
  }
  const bitDepth = bitDepthForFormat(source);
  if (!bitDepth || (source !== "yuv422p8" && source !== "yuv422p10" && source !== "yuv422p12")) {
    return null;
  }
  return allowed.find((format) => bitDepthForFormat(format) === bitDepth && isPlanarYuv(format)) ?? null;
}

export function convertDnxFrameLayout(
  source: DnxFrameLayout,
  sourceFormat: DnxPixelFormat,
  targetFormat: DnxPixelFormat,
  colorMatrix: "bt709" | "bt2020-ncl" | "bt2020-cl" | "unspecified" = "bt709"
): DnxFrameLayout {
  if (sourceFormat === targetFormat) {
    return source;
  }
  if (
    (sourceFormat === "gbrp10" && targetFormat === "yuv444p10") ||
    (sourceFormat === "gbrp12" && targetFormat === "yuv444p12")
  ) {
    return convertGbrToYuv444(source, sourceFormat === "gbrp10" ? 10 : 12, colorMatrix);
  }
  if (
    (sourceFormat !== "yuv422p8" && sourceFormat !== "yuv422p10" && sourceFormat !== "yuv422p12") ||
    !isPlanarYuv(targetFormat) ||
    bitDepthForFormat(sourceFormat) !== bitDepthForFormat(targetFormat)
  ) {
    throw new Error(`DNx output conversion from ${sourceFormat} to ${targetFormat} is unsupported.`);
  }

  const chromaMode = chromaModeForFormat(targetFormat);
  const bytesPerSample = source.bytesPerSample;
  const chromaWidth = chromaMode === 444 ? source.codedWidth : source.codedWidth / 2;
  const chromaHeight = chromaMode === 420 ? Math.ceil(source.codedHeight / 2) : source.codedHeight;
  const yByteLength = source.codedWidth * source.codedHeight * bytesPerSample;
  const chromaByteLength = chromaWidth * chromaHeight * bytesPerSample;
  const bytes = new Uint8Array(yByteLength + 2 * chromaByteLength);
  const y = createPlane("Y", source.codedWidth, source.codedHeight, bytesPerSample, bytes, 0);
  const cb = createPlane("Cb", chromaWidth, chromaHeight, bytesPerSample, bytes, yByteLength);
  const cr = createPlane("Cr", chromaWidth, chromaHeight, bytesPerSample, bytes, yByteLength + chromaByteLength);

  copyPlane(source.planes[0], y, bytesPerSample);
  for (const [sourcePlane, targetPlane] of [[source.planes[1], cb], [source.planes[2], cr]] as const) {
    if (chromaMode === 420) {
      downsample422To420(sourcePlane, targetPlane, bytesPerSample);
    } else {
      upsample422To444(sourcePlane, targetPlane, bytesPerSample);
    }
  }

  return {
    codedWidth: source.codedWidth,
    codedHeight: source.codedHeight,
    visibleWidth: source.visibleWidth,
    visibleHeight: source.visibleHeight,
    chromaWidth,
    chromaHeight,
    bytesPerSample,
    planes: [y, cb, cr]
  };
}

function convertGbrToYuv444(
  source: DnxFrameLayout,
  bitDepth: 10 | 12,
  colorMatrix: "bt709" | "bt2020-ncl" | "bt2020-cl" | "unspecified"
): DnxFrameLayout {
  const byteLength = source.codedWidth * source.codedHeight * 2;
  const bytes = new Uint8Array(byteLength * 3);
  const y = createPlane("Y", source.codedWidth, source.codedHeight, 2, bytes, 0);
  const cb = createPlane("Cb", source.codedWidth, source.codedHeight, 2, bytes, byteLength);
  const cr = createPlane("Cr", source.codedWidth, source.codedHeight, 2, bytes, byteLength * 2);
  const [gPlane, bPlane, rPlane] = source.planes;
  const isBt2020 = colorMatrix === "bt2020-ncl" || colorMatrix === "bt2020-cl";
  const kr = isBt2020 ? 0.2627 : 0.2126;
  const kb = isBt2020 ? 0.0593 : 0.0722;
  const kg = 1 - kr - kb;
  const maximum = (1 << bitDepth) - 1;
  const shift = bitDepth - 8;
  const lumaOffset = 16 << shift;
  const lumaRange = 219 << shift;
  const chromaNeutral = 128 << shift;
  const chromaRange = 224 << shift;

  for (let row = 0; row < source.codedHeight; row += 1) {
    for (let column = 0; column < source.codedWidth; column += 1) {
      const g = readSample(gPlane, column, row, 2) / maximum;
      const b = readSample(bPlane, column, row, 2) / maximum;
      const r = readSample(rPlane, column, row, 2) / maximum;
      const luma = kr * r + kg * g + kb * b;
      const blueDifference = (b - luma) / (2 * (1 - kb));
      const redDifference = (r - luma) / (2 * (1 - kr));
      writeSample(y, column, row, 2, clampSample(Math.round(lumaOffset + lumaRange * luma), maximum));
      writeSample(cb, column, row, 2, clampSample(Math.round(chromaNeutral + chromaRange * blueDifference), maximum));
      writeSample(cr, column, row, 2, clampSample(Math.round(chromaNeutral + chromaRange * redDifference), maximum));
    }
  }

  return {
    codedWidth: source.codedWidth,
    codedHeight: source.codedHeight,
    visibleWidth: source.visibleWidth,
    visibleHeight: source.visibleHeight,
    chromaWidth: source.codedWidth,
    chromaHeight: source.codedHeight,
    bytesPerSample: 2,
    planes: [y, cb, cr]
  };
}

function clampSample(value: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, value));
}

function createPlane(
  label: string,
  width: number,
  height: number,
  bytesPerSample: 1 | 2,
  bytes: Uint8Array,
  byteOffset: number
): DecodePlane {
  const stride = width * bytesPerSample;
  return {
    label,
    width,
    height,
    stride,
    bytes: bytes.subarray(byteOffset, byteOffset + stride * height)
  };
}

function copyPlane(source: DecodePlane, target: DecodePlane, bytesPerSample: 1 | 2): void {
  const rowBytes = target.width * bytesPerSample;
  for (let row = 0; row < target.height; row += 1) {
    target.bytes.set(source.bytes.subarray(row * source.stride, row * source.stride + rowBytes), row * target.stride);
  }
}

function downsample422To420(
  source: DecodePlane,
  target: DecodePlane,
  bytesPerSample: 1 | 2
): void {
  for (let y = 0; y < target.height; y += 1) {
    const top = Math.min(source.height - 1, y * 2);
    const bottom = Math.min(source.height - 1, top + 1);
    for (let x = 0; x < target.width; x += 1) {
      const first = readSample(source, x, top, bytesPerSample);
      const second = readSample(source, x, bottom, bytesPerSample);
      writeSample(target, x, y, bytesPerSample, (first + second + 1) >> 1);
    }
  }
}

function upsample422To444(
  source: DecodePlane,
  target: DecodePlane,
  bytesPerSample: 1 | 2
): void {
  for (let y = 0; y < target.height; y += 1) {
    for (let x = 0; x < target.width; x += 1) {
      writeSample(target, x, y, bytesPerSample, readSample(source, Math.floor(x / 2), y, bytesPerSample));
    }
  }
}

function readSample(plane: DecodePlane, x: number, y: number, bytesPerSample: 1 | 2): number {
  const offset = y * plane.stride + x * bytesPerSample;
  return bytesPerSample === 1 ? plane.bytes[offset] : plane.bytes[offset] | (plane.bytes[offset + 1] << 8);
}

function writeSample(
  plane: DecodePlane,
  x: number,
  y: number,
  bytesPerSample: 1 | 2,
  sample: number
): void {
  const offset = y * plane.stride + x * bytesPerSample;
  plane.bytes[offset] = sample & 0xff;
  if (bytesPerSample === 2) {
    plane.bytes[offset + 1] = sample >> 8;
  }
}

function bitDepthForFormat(format: DnxPixelFormat): 8 | 10 | 12 | null {
  if (format === "yuv420p8" || format === "yuv422p8" || format === "yuv444p8") {
    return 8;
  }
  if (format === "yuv420p10" || format === "yuv422p10" || format === "yuv444p10") {
    return 10;
  }
  if (format === "yuv422p12" || format === "yuv444p12") {
    return 12;
  }
  return null;
}

function chromaModeForFormat(format: DnxConvertiblePixelFormat): 420 | 422 | 444 {
  if (format.startsWith("yuv420")) {
    return 420;
  }
  if (format.startsWith("yuv444")) {
    return 444;
  }
  return 422;
}

function isPlanarYuv(format: DnxPixelFormat): format is DnxConvertiblePixelFormat {
  return (
    format === "yuv420p8" ||
    format === "yuv420p10" ||
    format === "yuv422p8" ||
    format === "yuv422p10" ||
    format === "yuv422p12" ||
    format === "yuv444p8" ||
    format === "yuv444p10" ||
    format === "yuv444p12"
  );
}
