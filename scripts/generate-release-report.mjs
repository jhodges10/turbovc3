#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: repoRoot,
  encoding: "utf8"
});
if (packed.status !== 0) {
  throw new Error(packed.stderr || packed.stdout || `npm pack exited ${packed.status}`);
}
const packResult = JSON.parse(packed.stdout)[0];
const apiReports = {};
for (const name of ["turbovc3.api.md", "turbovc3-mxf.api.md", "turbovc3-node.api.md"]) {
  const bytes = await readFile(path.join(repoRoot, "etc", name));
  apiReports[name] = { bytes: bytes.byteLength, sha256: sha256(bytes) };
}
const tarballPath = argument("--tarball");
const tarball = tarballPath
  ? await fileIdentity(path.resolve(repoRoot, tarballPath))
  : null;
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  gitSha: process.env.GITHUB_SHA ?? null,
  package: {
    name: manifest.name,
    version: manifest.version,
    distTag: manifest.version.includes("-") ? "next" : "latest",
    registry: manifest.publishConfig?.registry ?? null,
    engines: manifest.engines ?? {},
    peerDependencies: manifest.peerDependencies ?? {},
    exports: manifest.exports,
    packedBytes: packResult.size,
    unpackedBytes: packResult.unpackedSize,
    files: packResult.files.map(({ path: filePath, size }) => ({ path: filePath, size }))
  },
  apiReports,
  tarball
};
const json = `${JSON.stringify(report, null, 2)}\n`;
const output = argument("--output");
if (output) {
  await writeFile(path.resolve(repoRoot, output), json);
} else {
  process.stdout.write(json);
}

async function fileIdentity(filePath) {
  const bytes = await readFile(filePath);
  return { name: path.basename(filePath), bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}
