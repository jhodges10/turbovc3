import type { DecodeFrame, DecodePlane } from "./core/codec.js";

const TEXTURE_USAGE_COPY_DST_AND_BINDING = 0x02 | 0x04;
const BUFFER_USAGE_COPY_DST_AND_UNIFORM = 0x08 | 0x40;

type DnxWebGpuPixelFormat =
  | "yuv420p8"
  | "yuv420p10"
  | "yuv422p8"
  | "yuv422p10"
  | "yuv422p12"
  | "yuv444p8"
  | "yuv444p10"
  | "yuv444p12"
  | "gbrp10"
  | "gbrp12";

interface NavigatorWithGpu extends Navigator {
  gpu?: GpuApi;
}

interface GpuApi {
  getPreferredCanvasFormat(): string;
  requestAdapter(options?: unknown): Promise<GpuAdapter | null>;
}

interface GpuAdapter {
  requestDevice(): Promise<GpuDevice>;
}

interface GpuDevice {
  queue: GpuQueue;
  createBindGroup(descriptor: unknown): GpuBindGroup;
  createBuffer(descriptor: unknown): GpuBuffer;
  createCommandEncoder(): GpuCommandEncoder;
  createRenderPipeline(descriptor: unknown): GpuRenderPipeline;
  createShaderModule(descriptor: unknown): unknown;
  createTexture(descriptor: unknown): GpuTexture;
  destroy(): void;
}

interface GpuQueue {
  submit(commandBuffers: readonly unknown[]): void;
  writeBuffer(buffer: GpuBuffer, bufferOffset: number, data: ArrayBufferView): void;
  writeTexture(destination: unknown, data: ArrayBufferView, layout: unknown, size: unknown): void;
}

interface GpuCanvasContext {
  configure(descriptor: unknown): void;
  getCurrentTexture(): GpuTexture;
  unconfigure(): void;
}

interface GpuTexture {
  createView(): unknown;
  destroy(): void;
}

interface GpuBuffer {
  destroy(): void;
}

interface GpuBindGroup {}

interface GpuRenderPipeline {
  getBindGroupLayout(index: number): unknown;
}

interface GpuCommandEncoder {
  beginRenderPass(descriptor: unknown): GpuRenderPassEncoder;
  finish(): unknown;
}

interface GpuRenderPassEncoder {
  draw(vertexCount: number): void;
  end(): void;
  setBindGroup(index: number, bindGroup: GpuBindGroup): void;
  setPipeline(pipeline: GpuRenderPipeline): void;
}

interface TextureSet {
  width: number;
  height: number;
  format: DnxWebGpuPixelFormat;
  y: GpuTexture;
  cb: GpuTexture;
  cr: GpuTexture;
  bindGroup: GpuBindGroup;
}

export class DnxWebGpuRenderer {
  private textures: TextureSet | null = null;
  private destroyed = false;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly context: GpuCanvasContext,
    private readonly device: GpuDevice,
    private readonly pipeline: GpuRenderPipeline,
    private readonly paramsBuffer: GpuBuffer
  ) {}

  static supports(frame: DecodeFrame): boolean {
    return isSupportedFrame(frame);
  }

  static async create(canvas: HTMLCanvasElement): Promise<DnxWebGpuRenderer | null> {
    if (typeof navigator === "undefined") {
      return null;
    }

    const gpu = (navigator as NavigatorWithGpu).gpu;
    if (!gpu) {
      return null;
    }

    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      return null;
    }

    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu") as unknown as GpuCanvasContext | null;
    if (!context) {
      device.destroy();
      return null;
    }

    const presentationFormat = gpu.getPreferredCanvasFormat();
    context.configure({
      device,
      format: presentationFormat,
      alphaMode: "opaque"
    });

    const shader = device.createShaderModule({ code: DNX_YUV_SHADER });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shader,
        entryPoint: "vertexMain"
      },
      fragment: {
        module: shader,
        entryPoint: "fragmentMain",
        targets: [{ format: presentationFormat }]
      },
      primitive: {
        topology: "triangle-list"
      }
    });
    const paramsBuffer = device.createBuffer({
      size: 48,
      usage: BUFFER_USAGE_COPY_DST_AND_UNIFORM
    });

    return new DnxWebGpuRenderer(canvas, context, device, pipeline, paramsBuffer);
  }

  render(frame: DecodeFrame): void {
    if (this.destroyed) {
      throw new Error("DNx WebGPU renderer is destroyed.");
    }
    if (!isSupportedFrame(frame)) {
      throw new Error(`DNx WebGPU renderer does not support ${frame.format} frame data.`);
    }

    const [yPlane, cbPlane, crPlane] = frame.planes;
    const textures = this.ensureTextures(frame.width, frame.height, frame.format);
    const { width: chromaWidth, height: chromaHeight } = chromaDimensions(frame.format, frame.width, frame.height);
    this.canvas.width = frame.width;
    this.canvas.height = frame.height;

    this.uploadPlane(textures.y, yPlane, frame.width, frame.height);
    this.uploadPlane(textures.cb, cbPlane, chromaWidth, chromaHeight);
    this.uploadPlane(textures.cr, crPlane, chromaWidth, chromaHeight);

    this.device.queue.writeBuffer(this.paramsBuffer, 0, renderParams(frame));

    const commandEncoder = this.device.createCommandEncoder();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, textures.bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    this.destroyTextures();
    this.paramsBuffer.destroy();
    this.context.unconfigure();
    this.device.destroy();
  }

  private ensureTextures(width: number, height: number, format: DnxWebGpuPixelFormat): TextureSet {
    if (
      this.textures &&
      this.textures.width === width &&
      this.textures.height === height &&
      this.textures.format === format
    ) {
      return this.textures;
    }

    this.destroyTextures();
    const textureFormat = format.endsWith("p8") ? "r8uint" : "r16uint";
    const chroma = chromaDimensions(format, width, height);
    const y = this.createPlaneTexture(width, height, textureFormat);
    const cb = this.createPlaneTexture(chroma.width, chroma.height, textureFormat);
    const cr = this.createPlaneTexture(chroma.width, chroma.height, textureFormat);
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: y.createView() },
        { binding: 1, resource: cb.createView() },
        { binding: 2, resource: cr.createView() },
        { binding: 3, resource: { buffer: this.paramsBuffer } }
      ]
    });

    this.textures = { width, height, format, y, cb, cr, bindGroup };
    return this.textures;
  }

  private createPlaneTexture(width: number, height: number, format: string): GpuTexture {
    return this.device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format,
      usage: TEXTURE_USAGE_COPY_DST_AND_BINDING
    });
  }

  private uploadPlane(texture: GpuTexture, plane: DecodePlane, width: number, height: number): void {
    this.device.queue.writeTexture(
      { texture },
      plane.bytes,
      {
        bytesPerRow: plane.stride,
        rowsPerImage: plane.height
      },
      {
        width,
        height,
        depthOrArrayLayers: 1
      }
    );
  }

  private destroyTextures(): void {
    this.textures?.y.destroy();
    this.textures?.cb.destroy();
    this.textures?.cr.destroy();
    this.textures = null;
  }
}

function isSupportedFrame(
  frame: DecodeFrame
): frame is DecodeFrame & {
  format: DnxWebGpuPixelFormat;
  planes: readonly [DecodePlane, DecodePlane, DecodePlane, ...DecodePlane[]];
} {
  if (!isDnxWebGpuPixelFormat(frame.format) || !frame.planes || frame.planes.length < 3) {
    return false;
  }

  const bytesPerSample = frame.format.endsWith("p8") ? 1 : 2;
  const [y, cb, cr] = frame.planes;
  const chroma = chromaDimensions(frame.format, frame.width, frame.height);
  return (
    y.width >= frame.width &&
    y.height >= frame.height &&
    y.stride >= frame.width * bytesPerSample &&
    cb.width >= chroma.width &&
    cb.height >= chroma.height &&
    cb.stride >= chroma.width * bytesPerSample &&
    cr.width >= chroma.width &&
    cr.height >= chroma.height &&
    cr.stride >= chroma.width * bytesPerSample
  );
}

function isDnxWebGpuPixelFormat(format: DecodeFrame["format"]): format is DnxWebGpuPixelFormat {
  return (
    format === "yuv420p8" ||
    format === "yuv420p10" ||
    format === "yuv422p8" ||
    format === "yuv422p10" ||
    format === "yuv422p12" ||
    format === "yuv444p8" ||
    format === "yuv444p10" ||
    format === "yuv444p12" ||
    format === "gbrp10" ||
    format === "gbrp12"
  );
}

function chromaDimensions(
  format: DnxWebGpuPixelFormat,
  width: number,
  height: number
): { width: number; height: number; xDivisor: number; yDivisor: number } {
  if (format.startsWith("yuv444") || format === "gbrp10" || format === "gbrp12") {
    return { width, height, xDivisor: 1, yDivisor: 1 };
  }
  return {
    width: Math.ceil(width / 2),
    height: format.startsWith("yuv420") ? Math.ceil(height / 2) : height,
    xDivisor: 2,
    yDivisor: format.startsWith("yuv420") ? 2 : 1
  };
}

function renderParams(frame: DecodeFrame & { format: DnxWebGpuPixelFormat }): Float32Array {
  const sampleScale = frame.format.endsWith("p12") ? 1 / 16 : frame.format.endsWith("p10") ? 1 / 4 : 1;
  const chroma = chromaDimensions(frame.format, frame.width, frame.height);
  const isBt2020 = frame.colorSpace?.matrix === "bt2020-ncl" || frame.colorSpace?.matrix === "bt2020-cl";
  const matrix = isBt2020
    ? { crToR: 1.678674, cbToG: -0.187326, crToG: -0.650424, cbToB: 2.141772 }
    : { crToR: 1.792741, cbToG: -0.213249, crToG: -0.532909, cbToB: 2.112402 };

  return new Float32Array([
    sampleScale,
    1.164383,
    matrix.crToR,
    matrix.cbToG,
    matrix.crToG,
    matrix.cbToB,
    16,
    128,
    chroma.xDivisor,
    chroma.yDivisor,
    frame.format === "gbrp10" || frame.format === "gbrp12" ? 1 : 0,
    0
  ]);
}

const DNX_YUV_SHADER = /* wgsl */ `
struct Params {
  conversion0: vec4<f32>,
  conversion1: vec4<f32>,
  chroma: vec4<f32>,
}

@group(0) @binding(0) var yTexture: texture_2d<u32>;
@group(0) @binding(1) var cbTexture: texture_2d<u32>;
@group(0) @binding(2) var crTexture: texture_2d<u32>;
@group(0) @binding(3) var<uniform> params: Params;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0)
  );
  return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(i32(position.x), i32(position.y));
  let chromaPixel = vec2<i32>(
    pixel.x / i32(params.chroma.x),
    pixel.y / i32(params.chroma.y)
  );
  let y = f32(textureLoad(yTexture, pixel, 0).r) * params.conversion0.x;
  let cb = f32(textureLoad(cbTexture, chromaPixel, 0).r) * params.conversion0.x - params.conversion1.w;
  let cr = f32(textureLoad(crTexture, chromaPixel, 0).r) * params.conversion0.x - params.conversion1.w;
  if (params.chroma.z > 0.5) {
    let g = y;
    let b = cb + params.conversion1.w;
    let r = cr + params.conversion1.w;
    return vec4<f32>(clamp(vec3<f32>(r, g, b) / 255.0, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
  }
  let luma = params.conversion0.y * (y - params.conversion1.z);
  let rgb = vec3<f32>(
    luma + params.conversion0.z * cr,
    luma + params.conversion0.w * cb + params.conversion1.x * cr,
    luma + params.conversion1.y * cb
  );
  return vec4<f32>(clamp(rgb / 255.0, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
`;
