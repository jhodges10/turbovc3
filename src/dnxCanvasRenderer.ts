import type { DecodeFrame, DecodePlane } from "./core/codec.js";

type DnxCanvasPixelFormat =
  | "yuv420p8"
  | "yuv420p10"
  | "yuv420p12"
  | "yuv422p8"
  | "yuv422p10"
  | "yuv422p12"
  | "yuv444p8"
  | "yuv444p10"
  | "yuv444p12"
  | "gbrp10"
  | "gbrp12";

export class DnxCanvasRenderer {
  private imageData: ImageData | null = null;
  private destroyed = false;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D
  ) {}

  static supports(frame: DecodeFrame): boolean {
    return supportedFrame(frame) !== null;
  }

  static create(canvas: HTMLCanvasElement): DnxCanvasRenderer | null {
    const context = canvas.getContext("2d", { alpha: false });
    return context ? new DnxCanvasRenderer(canvas, context) : null;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  render(frame: DecodeFrame): void {
    if (this.destroyed) {
      throw new Error("DNx canvas renderer is destroyed.");
    }
    const supported = supportedFrame(frame);
    if (!supported) {
      throw new Error(`DNx canvas renderer does not support ${frame.format} frame data.`);
    }
    if (!this.imageData || this.imageData.width !== frame.width || this.imageData.height !== frame.height) {
      this.imageData = this.context.createImageData(frame.width, frame.height);
    }
    this.canvas.width = frame.width;
    this.canvas.height = frame.height;
    convertToRgba(supported, this.imageData.data);
    this.context.putImageData(this.imageData, 0, 0);
  }

  destroy(): void {
    this.destroyed = true;
    this.imageData = null;
  }
}

interface SupportedFrame extends DecodeFrame {
  format: DnxCanvasPixelFormat;
  planes: readonly [DecodePlane, DecodePlane, DecodePlane, ...DecodePlane[]];
}

function supportedFrame(frame: DecodeFrame): SupportedFrame | null {
  if (
    !isPixelFormat(frame.format) ||
    !frame.planes ||
    frame.planes.length < 3 ||
    frame.colorSpace?.matrix === "bt2020-cl"
  ) {
    return null;
  }
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1) {
    return null;
  }
  const bytesPerSample = frame.format.endsWith("p8") ? 1 : 2;
  const chroma = chromaDimensions(frame.format, frame.width, frame.height);
  const dimensions = [
    { width: frame.width, height: frame.height },
    { width: chroma.width, height: chroma.height },
    { width: chroma.width, height: chroma.height }
  ];
  for (let index = 0; index < 3; index += 1) {
    const plane = frame.planes[index];
    const expected = dimensions[index];
    const rowBytes = expected.width * bytesPerSample;
    if (
      plane.width < expected.width ||
      plane.height < expected.height ||
      plane.stride < rowBytes ||
      plane.bytes.byteLength < plane.stride * (expected.height - 1) + rowBytes
    ) {
      return null;
    }
  }
  return frame as SupportedFrame;
}

function convertToRgba(frame: SupportedFrame, rgba: Uint8ClampedArray): void {
  const bytesPerSample = frame.format.endsWith("p8") ? 1 : 2;
  const sampleScale = frame.format.endsWith("p12") ? 1 / 16 : frame.format.endsWith("p10") ? 1 / 4 : 1;
  const chroma = chromaDimensions(frame.format, frame.width, frame.height);
  const isGbr = frame.format === "gbrp10" || frame.format === "gbrp12";
  const isBt2020 = frame.colorSpace?.matrix === "bt2020-ncl";
  const matrix = isBt2020
    ? { crToR: 1.678674, cbToG: -0.187326, crToG: -0.650424, cbToB: 2.141772 }
    : { crToR: 1.792741, cbToG: -0.213249, crToG: -0.532909, cbToB: 2.112402 };

  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const chromaX = Math.floor(x / chroma.xDivisor);
      const chromaY = Math.floor(y / chroma.yDivisor);
      const first = readSample(frame.planes[0], x, y, bytesPerSample) * sampleScale;
      const second = readSample(frame.planes[1], chromaX, chromaY, bytesPerSample) * sampleScale;
      const third = readSample(frame.planes[2], chromaX, chromaY, bytesPerSample) * sampleScale;
      let red: number;
      let green: number;
      let blue: number;
      if (isGbr) {
        green = first;
        blue = second;
        red = third;
      } else {
        const luma = 1.164383 * (first - 16);
        const cb = second - 128;
        const cr = third - 128;
        red = luma + matrix.crToR * cr;
        green = luma + matrix.cbToG * cb + matrix.crToG * cr;
        blue = luma + matrix.cbToB * cb;
      }
      const offset = (y * frame.width + x) * 4;
      rgba[offset] = clampByte(red);
      rgba[offset + 1] = clampByte(green);
      rgba[offset + 2] = clampByte(blue);
      rgba[offset + 3] = 255;
    }
  }
}

function readSample(plane: DecodePlane, x: number, y: number, bytesPerSample: 1 | 2): number {
  const offset = y * plane.stride + x * bytesPerSample;
  return bytesPerSample === 1
    ? plane.bytes[offset]
    : plane.bytes[offset] | (plane.bytes[offset + 1] << 8);
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

function chromaDimensions(
  format: DnxCanvasPixelFormat,
  width: number,
  height: number
): { width: number; height: number; xDivisor: number; yDivisor: number } {
  if (format.startsWith("yuv444") || format === "gbrp10" || format === "gbrp12") {
    return { width, height, xDivisor: 1, yDivisor: 1 };
  }
  const yDivisor = format.startsWith("yuv420") ? 2 : 1;
  return {
    width: Math.ceil(width / 2),
    height: Math.ceil(height / yDivisor),
    xDivisor: 2,
    yDivisor
  };
}

function isPixelFormat(format: DecodeFrame["format"]): format is DnxCanvasPixelFormat {
  return (
    format === "yuv420p8" || format === "yuv420p10" || format === "yuv420p12" ||
    format === "yuv422p8" || format === "yuv422p10" || format === "yuv422p12" ||
    format === "yuv444p8" || format === "yuv444p10" || format === "yuv444p12" ||
    format === "gbrp10" || format === "gbrp12"
  );
}
