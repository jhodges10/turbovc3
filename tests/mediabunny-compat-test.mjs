#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const module = await loadModule();
const originalGetCodec = module.InputVideoTrack.prototype.getCodec;
try {
  module.InputVideoTrack.prototype.getCodec = undefined;
  assert.throws(
    () => module.registerDnxDecoder(),
    /Incompatible Mediabunny API: missing getCodec.*supports Mediabunny \^1\.50\.8/
  );
} finally {
  module.InputVideoTrack.prototype.getCodec = originalGetCodec;
}

module.registerDnxDecoder();
module.registerDnxDecoder();
const bytes = new Uint8Array(
  await readFile(path.join(repoRoot, "tests/fixtures/oracle_dnxhr_lb_1080p30_8bit_cid1274.mov"))
);
const input = new module.Input({
  formats: [new module.QuickTimeInputFormat()],
  source: new module.BufferSource(bytes)
});
try {
  const track = await input.getPrimaryVideoTrack();
  assert.ok(track);
  assert.equal(await track.getCodec(), "dnx");
  assert.equal(await track.getCodecParameterString(), "AVdh");
  assert.equal(await track.canDecode(), true);
  let sample = null;
  for await (const candidate of new module.VideoSampleSink(track).samples()) {
    sample = candidate;
    break;
  }
  assert.ok(sample);
  try {
    assert.equal(sample.format, "I422");
    assert.equal(sample.visibleRect.width, 1920);
    assert.equal(sample.visibleRect.height, 1080);
  } finally {
    sample.close();
  }
} finally {
  input.dispose();
}

console.log("Mediabunny compatibility preflight and DNx decode passed.");

async function loadModule() {
  const entry = JSON.stringify(path.join(repoRoot, "src/dnxMediabunny.ts"));
  const result = await build({
    stdin: {
      contents: `
        export { registerDnxDecoder } from ${entry};
        export { BufferSource, Input, InputVideoTrack, QuickTimeInputFormat, VideoSampleSink } from "mediabunny";
      `,
      resolveDir: repoRoot,
      sourcefile: "mediabunny-compat-test-entry.ts"
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
