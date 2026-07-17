#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "turbovc3-package-"));

try {
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporaryDirectory], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  if (packed.status !== 0) {
    throw new Error(packed.stderr || packed.stdout || "npm pack failed");
  }
  const packResult = JSON.parse(packed.stdout)[0];
  const tarball = path.join(temporaryDirectory, packResult.filename);
  const extract = spawnSync("tar", ["-xzf", tarball, "-C", temporaryDirectory], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr || "package extraction");

  const packageRoot = path.join(temporaryDirectory, "package");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "@jhodges10/turbovc3");
  assert.equal(manifest.publishConfig?.registry, "https://npm.pkg.github.com");
  for (const relativePath of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/mxf/index.js",
    "dist/mxf/index.d.ts",
    "dist/node.js",
    "dist/node.d.ts",
    "dist/workers/dnxPacketDecode.worker.js",
    "dist/workers/dnxSharedRowDecode.worker.js",
    "dist/workers/dnxNodePacketDecode.worker.js",
    "dist/workers/dnxNodeSharedRowDecode.worker.js"
  ]) {
    assert.equal(existsSync(path.join(packageRoot, relativePath)), true, `${relativePath} is packed`);
  }

  const wasmAssets = [
    "wasm/generated/dnx_idct_kernel.wasm",
    "wasm/generated/dnx_row_decoder.wasm"
  ];
  if (process.env.REQUIRE_WASM_ASSETS === "1") {
    for (const relativePath of wasmAssets) {
      assert.equal(existsSync(path.join(packageRoot, relativePath)), true, `${relativePath} is packed`);
    }
  }

  const consumerRoot = path.join(temporaryDirectory, "consumer");
  const scopeRoot = path.join(consumerRoot, "node_modules/@jhodges10");
  await mkdir(scopeRoot, { recursive: true });
  await symlink(packageRoot, path.join(scopeRoot, "turbovc3"), "dir");
  await mkdir(path.join(packageRoot, "node_modules"), { recursive: true });
  await symlink(path.join(repoRoot, "node_modules/mediabunny"), path.join(packageRoot, "node_modules/mediabunny"), "dir");
  const consumerScript = path.join(consumerRoot, "smoke.mjs");
  await writeFile(consumerScript, `
    import assert from "node:assert/strict";
    import * as root from "@jhodges10/turbovc3";
    import * as mxf from "@jhodges10/turbovc3/mxf";
    import { createNodeDecoder } from "@jhodges10/turbovc3/node";
    assert.equal(typeof root.registerDnxDecoder, "function");
    assert.equal(typeof root.Decoder, "function");
    assert.equal(typeof root.DnxBitReader, "undefined");
    assert.equal(typeof root.decodeDnxScalarFrame, "undefined");
    assert.equal(typeof mxf.MxfDemuxer, "function");
    const decoder = await root.Decoder.create({ dnxFourCc: "AVdn", useSharedMemory: false, concurrency: 0 });
    assert.equal(decoder instanceof Error, false);
    assert.equal(decoder.idctMode, "typescript-idct");
    await decoder[Symbol.asyncDispose]();
    const nodeDecoder = await createNodeDecoder({
      dnxFourCc: "AVdh",
      useSharedMemory: false,
      concurrency: 2
    });
    assert.equal(nodeDecoder instanceof Error, false);
    assert.equal(nodeDecoder.idctMode.startsWith("worker-pool/"), true);
    await nodeDecoder.close();
  `);
  const consumer = spawnSync(process.execPath, [consumerScript], { cwd: consumerRoot, encoding: "utf8" });
  assert.equal(consumer.status, 0, consumer.stderr || consumer.stdout || "consumer import smoke test");

  console.log(`Verified packed ${manifest.name}@${manifest.version}${process.env.REQUIRE_WASM_ASSETS === "1" ? " with WASM assets" : " with fallback imports"}.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
