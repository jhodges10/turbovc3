#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(directory, "../..");
const buildDirectory = path.join(repoRoot, ".example-build");
await rm(buildDirectory, { recursive: true, force: true });
await build({
  entryPoints: [path.join(directory, "main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outfile: path.join(buildDirectory, "main.js"),
  sourcemap: true
});

if (process.argv.includes("--build-only")) {
  console.log("Browser example bundled successfully.");
  process.exit(0);
}

const routes = new Map([
  ["/", { file: path.join(directory, "index.html"), type: "text/html; charset=utf-8" }],
  ["/main.js", { file: path.join(buildDirectory, "main.js"), type: "text/javascript; charset=utf-8" }],
  ["/main.js.map", { file: path.join(buildDirectory, "main.js.map"), type: "application/json" }]
]);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const route = routes.get(pathname);
    const wasmMatch = /^\/wasm\/generated\/([a-z0-9_]+\.wasm)$/.exec(pathname);
    const file = route?.file ?? (wasmMatch ? path.join(repoRoot, "wasm/generated", wasmMatch[1]) : null);
    if (!file) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.setHeader("Content-Type", route?.type ?? "application/wasm");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.end(await readFile(file));
  } catch (error) {
    response.writeHead(500).end(error instanceof Error ? error.message : String(error));
  }
});
server.listen(4174, "127.0.0.1", () => {
  console.log("turbovc3 example: http://127.0.0.1:4174");
});
