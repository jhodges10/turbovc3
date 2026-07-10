#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const fixtureDirectory = path.resolve(process.argv[2] ?? "tests/fixtures");
const manifestPath = path.join(fixtureDirectory, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

for (const fixture of manifest.files) {
  const bytes = await readFile(path.join(fixtureDirectory, fixture.path));
  fixture.sha256 = createHash("sha256").update(bytes).digest("hex");
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
