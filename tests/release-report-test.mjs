#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = spawnSync(process.execPath, ["scripts/generate-release-report.mjs"], {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 120_000
});
assert.equal(run.status, 0, run.stderr || run.stdout);
const report = JSON.parse(run.stdout);
assert.equal(report.schemaVersion, 1);
assert.equal(report.package.name, "@jhodges10/turbovc3");
assert.equal(report.package.registry, "https://npm.pkg.github.com");
assert.equal(report.package.distTag, report.package.version.includes("-") ? "next" : "latest");
assert.equal(report.package.files.some((file) => file.path === "dist/index.js"), true);
assert.equal(report.package.files.some((file) => file.path === "docs/compatibility.md"), true);
assert.deepEqual(Object.keys(report.apiReports).sort(), [
  "turbovc3-mxf.api.md",
  "turbovc3-node.api.md",
  "turbovc3.api.md"
]);
assert.equal(Object.values(report.apiReports).every((value) => /^[a-f0-9]{64}$/.test(value.sha256)), true);
assert.equal(report.tarball, null);
console.log("Release package/API report contract passed.");
