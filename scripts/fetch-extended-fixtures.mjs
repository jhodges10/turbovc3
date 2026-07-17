#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = [
  {
    name: "FFmpeg FATE DNxHR HQX 12-bit",
    url: "https://fate-suite.ffmpeg.org/dnxhd/dnxhr_cid1271_12bit.mov",
    output: path.join(repoRoot, "samples/oracle_fate_dnxhr_cid1271_12bit.mov"),
    bytes: 918_983,
    sha256: "8126766c535b24b49c0502757f9f19c862a19534217889be1feba3c65317d84f"
  },
  {
    name: "FFmpeg FATE DNxHD CID 1260 MBAFF",
    url: "https://fate-suite.ffmpeg.org/dnxhd/dnxhd100_cid1260.mov",
    output: path.join(repoRoot, "samples/oracle_fate_dnxhd100_cid1260.mov"),
    bytes: 418_763,
    sha256: "e0f38194b223b85264c2bfb95ab72cb839229803bce11a59f37166e63b5c3a9a"
  }
];

for (const fixture of fixtures) {
  await mkdir(path.dirname(fixture.output), { recursive: true });
  let bytes;
  try {
    bytes = await readFile(fixture.output);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const response = await fetch(fixture.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`${fixture.name} download failed with HTTP ${response.status}.`);
    bytes = new Uint8Array(await response.arrayBuffer());
    verify(fixture, bytes);
    await writeFile(fixture.output, bytes);
  }
  verify(fixture, bytes);
  console.log(`Verified ${fixture.name} at ${path.relative(repoRoot, fixture.output)}.`);
}

function verify(fixture, value) {
  const digest = createHash("sha256").update(value).digest("hex");
  if (value.byteLength !== fixture.bytes || digest !== fixture.sha256) {
    throw new Error(
      `${fixture.name} integrity mismatch: expected ${fixture.bytes} bytes/${fixture.sha256}, ` +
      `received ${value.byteLength} bytes/${digest}.`
    );
  }
}
