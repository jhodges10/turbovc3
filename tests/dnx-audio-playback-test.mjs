#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const module = await loadModule();
const started = [];
const context = {
  state: "running",
  currentTime: 10,
  destination: {},
  closeCalls: 0,
  createBuffer(channels, length, sampleRate) {
    const channelData = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData(channel) {
        return channelData[channel];
      }
    };
  },
  createBufferSource() {
    return {
      buffer: null,
      onended: null,
      connect() {},
      disconnect() {},
      start(when, offset) {
        started.push({ source: this, when, offset });
      },
      stop() {}
    };
  },
  async resume() {
    this.state = "running";
  },
  async close() {
    this.closeCalls += 1;
  }
};

const bytes = new Uint8Array(await readFile(path.join(repoRoot, "tests/fixtures/dnxhr-lb-op1a-pcm.mxf")));
const playback = await module.DnxAudioPlayback.createFromMxf(bytes, {
  audioContext: context,
  scheduleLeadTime: 0.05
});
assert.ok(playback);
assert.deepEqual(playback.track, {
  codec: "pcm_s16le",
  sampleRate: 48000,
  numberOfChannels: 2,
  duration: 1 / 30
});
assert.equal(playback.currentTime, 0);
assert.equal(playback.clockAuthority, "audio-context");
assert.equal(playback.isEnded, false);
await playback.start(0);
await waitFor(() => started.length === 1);
assert.equal(playback.isPlaying, true);
assert.equal(playback.isClockRunning, true);
assert.equal(started[0].when, 10.05);
assert.equal(started[0].offset, 0);
assert.equal(started[0].source.buffer.numberOfChannels, 2);
assert.equal(started[0].source.buffer.length, 1600);
assert.equal(started[0].source.buffer.getChannelData(0)[0], 0);
assert.equal(started[0].source.buffer.getChannelData(1)[0], 0);
assert.equal(
  Math.abs(started[0].source.buffer.getChannelData(0)[1] - 378 / 32768) < 1e-8,
  true
);
context.currentTime = 10.06;
assert.equal(Math.abs(playback.currentTime - 0.01) < 1e-9, true);
assert.equal(await playback.recoverFromUnderrun(), false, "scheduled audio is not an underrun");
started[0].source.onended();
assert.equal(await playback.recoverFromUnderrun(), true);
await waitFor(() => started.length === 2);
playback.pause();
assert.equal(playback.isPlaying, false);
assert.equal(Math.abs(playback.currentTime - 0.01) < 1e-9, true);
await playback.seek(0.02);
assert.equal(playback.currentTime, 0.02);
context.currentTime = 11;
await playback.start(playback.track.duration);
assert.equal(playback.isEnded, true);
assert.equal(playback.isPlaying, false);
await playback.close();
assert.equal(context.closeCalls, 0, "caller-owned AudioContext remains open");
await assert.rejects(playback.start(), /closed/);

const mono24Bytes = new Uint8Array(
  await readFile(path.join(repoRoot, "tests/fixtures/dnxhr-lb-op1a-pcm24-mono-24fps-tc.mxf"))
);
const mono24Playback = await module.DnxAudioPlayback.createFromMxf(mono24Bytes, {
  audioContext: context,
  scheduleLeadTime: 0.05
});
assert.ok(mono24Playback);
assert.deepEqual(mono24Playback.track, {
  codec: "pcm_s24le",
  sampleRate: 48000,
  numberOfChannels: 1,
  duration: 1 / 24
});
const mono24StartIndex = started.length;
context.currentTime = 20;
await mono24Playback.start(0);
await waitFor(() => started.length === mono24StartIndex + 1);
assert.equal(started[mono24StartIndex].source.buffer.numberOfChannels, 1);
assert.equal(started[mono24StartIndex].source.buffer.length, 2000);
assert.equal(started[mono24StartIndex].source.buffer.getChannelData(0)[0], 0);
assert.equal(Math.abs(started[mono24StartIndex].source.buffer.getChannelData(0)[1]) > 0, true);
await mono24Playback.close();

const noAudio = await module.DnxAudioPlayback.createFromMxf(
  new Uint8Array(await readFile(path.join(repoRoot, "tests/fixtures/dnxhr-lb-opatom.mxf"))),
  { audioContext: context }
);
assert.equal(noAudio, null);
console.log("DNx MXF PCM audio playback contract passed.");

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for scheduled MXF PCM audio.");
}

async function loadModule() {
  const result = await build({
    entryPoints: [path.join(repoRoot, "src/dnxAudioPlayback.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    write: false
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
