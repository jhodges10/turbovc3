#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = {
  name: "FFmpeg FATE DNxHR HQX 12-bit",
  url: "https://fate-suite.ffmpeg.org/dnxhd/dnxhr_cid1271_12bit.mov",
  output: path.join(repoRoot, "samples/oracle_fate_dnxhr_cid1271_12bit.mov"),
  bytes: 918_983,
  sha256: "8126766c535b24b49c0502757f9f19c862a19534217889be1feba3c65317d84f"
};

await mkdir(path.dirname(fixture.output), { recursive: true });
let bytes;
try {
  bytes = await readFile(fixture.output);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  const response = await fetch(fixture.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${fixture.name} download failed with HTTP ${response.status}.`);
  bytes = new Uint8Array(await response.arrayBuffer());
  verify(bytes);
  await writeFile(fixture.output, bytes);
}
verify(bytes);
console.log(`Verified ${fixture.name} at ${path.relative(repoRoot, fixture.output)}.`);

function verify(value) {
  const digest = createHash("sha256").update(value).digest("hex");
  if (value.byteLength !== fixture.bytes || digest !== fixture.sha256) {
    throw new Error(
      `${fixture.name} integrity mismatch: expected ${fixture.bytes} bytes/${fixture.sha256}, ` +
      `received ${value.byteLength} bytes/${digest}.`
    );
  }
}
