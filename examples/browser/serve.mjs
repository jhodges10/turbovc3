#!/usr/bin/env node
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(directory, "../..");
const buildDirectory = path.join(repoRoot, ".example-build");
await rm(buildDirectory, { recursive: true, force: true });
await build({
  entryPoints: {
    main: path.join(directory, "main.ts"),
    "workers/dnxPacketDecode.worker": path.join(repoRoot, "src/workers/dnxPacketDecode.worker.ts"),
    "workers/dnxSharedRowDecode.worker": path.join(repoRoot, "src/workers/dnxSharedRowDecode.worker.ts")
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  outdir: buildDirectory,
  sourcemap: true
});

if (process.argv.includes("--build-only")) {
  console.log("Browser example bundled successfully.");
  process.exit(0);
}

const routes = new Map([
  ["/", { file: path.join(directory, "index.html"), type: "text/html; charset=utf-8" }],
  ["/main.js", { file: path.join(buildDirectory, "main.js"), type: "text/javascript; charset=utf-8" }],
  ["/main.js.map", { file: path.join(buildDirectory, "main.js.map"), type: "application/json" }],
  ["/workers/dnxPacketDecode.worker.js", {
    file: path.join(buildDirectory, "workers/dnxPacketDecode.worker.js"),
    type: "text/javascript; charset=utf-8"
  }],
  ["/workers/dnxSharedRowDecode.worker.js", {
    file: path.join(buildDirectory, "workers/dnxSharedRowDecode.worker.js"),
    type: "text/javascript; charset=utf-8"
  }]
]);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const route = routes.get(pathname);
    const wasmMatch = /^\/wasm\/generated\/([a-z0-9_]+\.wasm)$/.exec(pathname);
    const sampleMatch = /^\/samples\/(beach_(?:rec709|rec2020)_dnxhr_(?:lb|sq|hq|hqx|444)_(?:1080|2160)p2398_5s\.mxf)$/.exec(pathname);
    const sampleFile = sampleMatch ? path.join(repoRoot, "samples/dnxhr", sampleMatch[1]) : null;
    const file = route?.file ?? (wasmMatch ? path.join(repoRoot, "wasm/generated", wasmMatch[1]) : sampleFile);
    if (!file) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    if (sampleFile) {
      await serveSample(request, response, sampleFile);
      return;
    }
    response.setHeader("Content-Type", route?.type ?? "application/wasm");
    response.end(await readFile(file));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && error.code === "ENOENT" ? 404 : 500;
    response.writeHead(code).end(code === 404 ? "Sample not generated" : error instanceof Error ? error.message : String(error));
  }
});
server.listen(4174, "127.0.0.1", () => {
  console.log("turbovc3 example: http://127.0.0.1:4174");
});

async function serveSample(request, response, file) {
  const info = await stat(file);
  const range = request.headers.range;
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", "application/mxf");
  if (request.method === "HEAD") {
    response.writeHead(200, { "Content-Length": info.size }).end();
    return;
  }
  if (!range) {
    response.writeHead(200, { "Content-Length": info.size });
    createReadStream(file).pipe(response);
    return;
  }
  const match = /^bytes=(\d+)-(\d+)$/.exec(range);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end();
    return;
  }
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), info.size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
    response.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end();
    return;
  }
  response.writeHead(206, {
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${info.size}`
  });
  createReadStream(file, { start, end }).pipe(response);
}
