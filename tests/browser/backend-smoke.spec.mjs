import { expect, test } from "@playwright/test";

const fixtureUrl = "/tests/fixtures/dnxhr-lb-op1a-pcm.mxf";

test("synchronous Zig/WASM frame backend decodes", async ({ page }) => {
  await page.goto("/");
  const result = await decodeFixture(page, { concurrency: 0, useSharedMemory: false });
  expect(result.mode).toBe("zig-wasm-frame");
  expect(result).toMatchObject({ width: 1280, height: 720, pixelFormat: "yuv422p8" });
});

test("packet workers start and decode", async ({ page }) => {
  await page.goto("/");
  const result = await decodeFixture(page, { concurrency: 2, useSharedMemory: false });
  expect(result.mode).toBe("worker-pool/zig-wasm-frame");
  expect(result.filled).toBe(true);
});

test("cross-origin-isolated shared-row workers start and decode", async ({ page }) => {
  await page.goto("/");
  const result = await decodeFixture(page, { concurrency: 2, useSharedMemory: true });
  expect(result.crossOriginIsolated).toBe(true);
  expect(result.canUseSharedMemory).toBe(true);
  expect(result.mode).toBe("shared-row-workers/zig-wasm-row");
  expect(result.filled).toBe(true);
});

test("missing native assets fall back to TypeScript", async ({ page }) => {
  await page.route("**/wasm/generated/*.wasm", (route) => route.fulfill({ status: 404 }));
  await page.goto("/");
  const result = await decodeFixture(page, { concurrency: 0, useSharedMemory: false });
  expect(result.mode).toBe("typescript-idct");
  expect(result.filled).toBe(true);
});

async function decodeFixture(page, options) {
  return page.evaluate(async ({ fixtureUrl: url, decoderOptions }) => {
    const [{ Decoder, Frame }, { demuxDnxMxf }] = await Promise.all([
      import("/dist/dnxDecoder.js"),
      import("/dist/dnxMxf.js")
    ]);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Fixture request failed with HTTP ${response.status}.`);
    }
    const demuxed = await demuxDnxMxf(new Uint8Array(await response.arrayBuffer()));
    if (!demuxed) {
      throw new Error("Committed MXF fixture did not contain DNx essence.");
    }
    const packet = await demuxed.demuxer.readPacket(demuxed.packets[0]);
    const decoder = await Decoder.create({ dnxFourCc: "AVdh", ...decoderOptions });
    if (decoder instanceof Error) {
      throw decoder;
    }
    try {
      const frame = new Frame();
      const decoded = await decoder.decode(packet, frame);
      if (decoded instanceof Error) {
        throw decoded;
      }
      return {
        mode: decoder.idctMode,
        filled: frame.isFilled,
        width: frame.visibleWidth,
        height: frame.visibleHeight,
        pixelFormat: frame.pixelFormat,
        crossOriginIsolated: globalThis.crossOriginIsolated,
        canUseSharedMemory: Decoder.canUseSharedMemory()
      };
    } finally {
      await decoder.close();
    }
  }, { fixtureUrl, decoderOptions: options });
}
