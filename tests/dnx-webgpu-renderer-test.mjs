#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const calls = {
  shader: "",
  textures: [],
  textureWrites: [],
  renderParams: [],
  draws: 0,
  submits: 0,
  unconfigured: false,
  deviceDestroyed: false
};
let resolveDeviceLost;

async function main() {
  const module = await loadRenderer();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: createFakeGpu() }
    });

    const canvas = {
      width: 0,
      height: 0,
      getContext(kind) {
        assert.equal(kind, "webgpu");
        return fakeContext;
      }
    };
    const deviceLosses = [];
    const renderer = await module.DnxWebGpuRenderer.create(canvas, {
      onDeviceLost(error) {
        deviceLosses.push(error);
      }
    });
    assert.ok(renderer);
    assert.equal(renderer.isDestroyed, false);
    assert.equal(renderer.isDeviceLost, false);

    const frame420 = makeFrame("yuv420p8", 8, 4, 2);
    const frame422 = makeFrame("yuv422p10", 8, 4);
    const frame444 = {
      ...makeFrame("yuv444p8", 8, 4),
      colorSpace: { matrix: "bt2020-ncl" }
    };
    const frameGbr = makeFrame("gbrp10", 8, 4);
    for (const format of [
      "yuv420p8", "yuv420p10", "yuv420p12", "yuv422p8", "yuv422p10", "yuv422p12",
      "yuv444p8", "yuv444p10", "yuv444p12", "gbrp10", "gbrp12"
    ]) {
      assert.equal(module.DnxWebGpuRenderer.supports(makeFrame(format, 8, 4)), true);
    }
    assert.equal(module.DnxWebGpuRenderer.supports({ ...frame420, format: "rgba8" }), false);
    assert.equal(
      module.DnxWebGpuRenderer.supports({ ...frame420, colorSpace: { matrix: "bt2020-cl" } }),
      false
    );
    assert.equal(
      module.DnxWebGpuRenderer.supports({
        ...frame420,
        planes: [{ ...frame420.planes[0], stride: 1 }, frame420.planes[1], frame420.planes[2]]
      }),
      false
    );

    renderer.render(frame420);
    renderer.render(frame422);
    renderer.render(frame444);
    renderer.render(frameGbr);
    assert.deepEqual(
      calls.textures.map((texture) => texture.descriptor.format),
      [
        "r8uint", "r8uint", "r8uint",
        "r16uint", "r16uint", "r16uint",
        "r8uint", "r8uint", "r8uint",
        "r16uint", "r16uint", "r16uint"
      ]
    );
    assert.deepEqual(
      calls.textureWrites.map((write) => [write.layout.bytesPerRow, write.size.width, write.size.height]),
      [
        [10, 8, 4],
        [5, 4, 2],
        [5, 4, 2],
        [16, 8, 4],
        [8, 4, 4],
        [8, 4, 4],
        [8, 8, 4],
        [8, 8, 4],
        [8, 8, 4],
        [16, 8, 4],
        [16, 8, 4],
        [16, 8, 4]
      ]
    );
    assert.deepEqual(calls.renderParams.map((params) => params[0]), [1, 0.25, 1, 0.25]);
    assert.deepEqual(calls.renderParams.map((params) => params.slice(8, 10)), [[2, 2], [2, 1], [1, 1], [1, 1]]);
    assert.equal(Math.abs(calls.renderParams[2][2] - 1.678674) < 1e-6, true);
    assert.equal(calls.renderParams[3][10], 1);
    assert.equal(calls.draws, 4);
    assert.equal(calls.submits, 4);
    assert.match(calls.shader, /texture_2d<u32>/);
    assert.match(calls.shader, /params\.chroma\.x/);
    assert.equal(canvas.width, 8);
    assert.equal(canvas.height, 4);
    assert.equal(calls.textures.slice(0, 3).every((texture) => texture.destroyed), true);

    resolveDeviceLost({ reason: "unknown", message: "simulated reset" });
    await Promise.resolve();
    assert.equal(renderer.isDeviceLost, true);
    assert.equal(deviceLosses.length, 1);
    assert.match(deviceLosses[0].message, /simulated reset/);
    assert.throws(() => renderer.render(frame420), /device is lost/);

    renderer.destroy();
    renderer.destroy();
    assert.equal(renderer.isDestroyed, true);
    assert.equal(calls.textures.every((texture) => texture.destroyed), true);
    assert.equal(calls.unconfigured, true);
    assert.equal(calls.deviceDestroyed, true);
    console.log("DNx WebGPU renderer contract passed.");
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      delete globalThis.navigator;
    }
  }
}

async function loadRenderer() {
  const result = await build({
    entryPoints: [path.join(packageRoot, "src/dnxWebGpuRenderer.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

function createFakeGpu() {
  return {
    getPreferredCanvasFormat() {
      return "bgra8unorm";
    },
    async requestAdapter() {
      return {
        async requestDevice() {
          return fakeDevice;
        }
      };
    }
  };
}

const fakeQueue = {
  submit() {
    calls.submits += 1;
  },
  writeBuffer(_buffer, _offset, data) {
    calls.renderParams.push(Array.from(new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4)));
  },
  writeTexture(_destination, _data, layout, size) {
    calls.textureWrites.push({ layout, size });
  }
};

const fakeDevice = {
  lost: new Promise((resolve) => {
    resolveDeviceLost = resolve;
  }),
  queue: fakeQueue,
  createBindGroup(descriptor) {
    return { descriptor };
  },
  createBuffer() {
    return { destroy() {} };
  },
  createCommandEncoder() {
    return {
      beginRenderPass() {
        return {
          draw(vertexCount) {
            assert.equal(vertexCount, 3);
            calls.draws += 1;
          },
          end() {},
          setBindGroup() {},
          setPipeline() {}
        };
      },
      finish() {
        return {};
      }
    };
  },
  createRenderPipeline() {
    return {
      getBindGroupLayout() {
        return {};
      }
    };
  },
  createShaderModule({ code }) {
    calls.shader = code;
    return {};
  },
  createTexture(descriptor) {
    const texture = {
      descriptor,
      destroyed: false,
      createView() {
        return { texture };
      },
      destroy() {
        texture.destroyed = true;
      }
    };
    calls.textures.push(texture);
    return texture;
  },
  destroy() {
    calls.deviceDestroyed = true;
  }
};

const fakeContext = {
  configure() {},
  getCurrentTexture() {
    return {
      createView() {
        return {};
      },
      destroy() {}
    };
  },
  unconfigure() {
    calls.unconfigured = true;
  }
};

function makeFrame(format, width, height, paddingSamples = 0) {
  const bytesPerSample = format.endsWith("p8") ? 1 : 2;
  const is444 = format.startsWith("yuv444") || format === "gbrp10" || format === "gbrp12";
  const is420 = format.startsWith("yuv420");
  const chromaWidth = is444 ? width : Math.ceil(width / 2);
  const chromaHeight = is420 ? Math.ceil(height / 2) : height;
  const lumaPlaneWidth = width + paddingSamples;
  const chromaPlaneWidth = chromaWidth + (is444 ? paddingSamples : Math.ceil(paddingSamples / 2));
  return {
    index: 0,
    timestampUs: 0,
    width,
    height,
    format,
    planes: [
      makePlane("Y", lumaPlaneWidth, height, lumaPlaneWidth * bytesPerSample),
      makePlane("Cb", chromaPlaneWidth, chromaHeight, chromaPlaneWidth * bytesPerSample),
      makePlane("Cr", chromaPlaneWidth, chromaHeight, chromaPlaneWidth * bytesPerSample)
    ]
  };
}

function makePlane(label, width, height, stride) {
  return {
    label,
    width,
    height,
    stride,
    bytes: new Uint8Array(stride * height)
  };
}

await main();
