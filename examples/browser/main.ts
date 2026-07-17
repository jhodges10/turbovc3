import {
  DnxAudioPlayback,
  DnxCanvasRenderer,
  DnxRandomAccessDecoder,
  type DecodeFrame
} from "../../src/index.js";

const fileInput = element<HTMLInputElement>("file");
const canvas = element<HTMLCanvasElement>("video");
const playButton = element<HTMLButtonElement>("play");
const pauseButton = element<HTMLButtonElement>("pause");
const seekInput = element<HTMLInputElement>("seek");
const position = element<HTMLOutputElement>("position");
const status = element<HTMLElement>("status");
const diagnostics = element<HTMLElement>("diagnostics");
const renderer = DnxCanvasRenderer.create(canvas) ?? unavailable("Canvas2D is unavailable.");

let decoder: DnxRandomAccessDecoder | null = null;
let audio: DnxAudioPlayback | null = null;
let frameRate = 30;
let currentFrame = 0;
let playing = false;
let silentClockStart = 0;
let silentClockOffset = 0;
let renderPending = false;

fileInput.addEventListener("change", () => void openSelectedFile());
playButton.addEventListener("click", () => void play());
pauseButton.addEventListener("click", pause);
seekInput.addEventListener("input", () => void seek(Number(seekInput.value)));
window.addEventListener("pagehide", () => void closeMedia());

async function openSelectedFile(): Promise<void> {
  const file = fileInput.files?.[0];
  if (!file) return;
  await closeMedia();
  setEnabled(false);
  status.textContent = `Indexing ${file.name}…`;
  const opened = await DnxRandomAccessDecoder.create(file, {
    concurrency: 0,
    packetCacheSize: 8,
    prefetchFrames: 2,
    onIndexProgress: ({ offset, totalBytes }) => {
      status.textContent = `Indexing ${file.name}: ${percent(offset, totalBytes)}%`;
    }
  });
  if (opened instanceof Error) {
    status.textContent = opened.message;
    return;
  }
  decoder = opened;
  frameRate = opened.editRate
    ? opened.editRate.numerator / opened.editRate.denominator
    : 30;
  try {
    audio = await DnxAudioPlayback.createFromMxf(file, {
      onError: (error) => { status.textContent = `Audio: ${error.message}`; }
    });
  } catch (error) {
    audio = null;
    status.textContent = `Video ready; audio unsupported: ${toError(error).message}`;
  }
  seekInput.max = String(opened.frameCount - 1);
  setEnabled(true);
  await renderFrame(0);
  status.textContent = `${file.name} ready (${opened.frameCount} frames).`;
}

async function renderFrame(index: number): Promise<void> {
  if (!decoder) return;
  const frame = await decoder.seek(index);
  if (frame instanceof Error) {
    if (frame.name !== "AbortError") status.textContent = frame.message;
    return;
  }
  renderer.render(frame);
  currentFrame = index;
  seekInput.value = String(index);
  position.value = `${index + 1} / ${decoder.frameCount}`;
  diagnostics.textContent = JSON.stringify(frameDiagnostics(frame), null, 2);
}

async function play(): Promise<void> {
  if (!decoder || playing) return;
  playing = true;
  silentClockOffset = currentFrame / frameRate;
  silentClockStart = performance.now() / 1000;
  if (audio) await audio.start(silentClockOffset);
  requestAnimationFrame(tick);
}

function pause(): void {
  if (!playing) return;
  silentClockOffset = mediaTime();
  playing = false;
  audio?.pause();
}

async function seek(index: number): Promise<void> {
  if (!decoder) return;
  const time = index / frameRate;
  silentClockOffset = time;
  silentClockStart = performance.now() / 1000;
  if (audio) await audio.seek(time);
  await renderFrame(index);
}

function tick(): void {
  if (!playing || !decoder) return;
  const target = Math.min(decoder.frameCount - 1, Math.floor(mediaTime() * frameRate));
  if (target !== currentFrame && !renderPending) {
    renderPending = true;
    void renderFrame(target).finally(() => { renderPending = false; });
  }
  if (target >= decoder.frameCount - 1) {
    pause();
    return;
  }
  requestAnimationFrame(tick);
}

function mediaTime(): number {
  return audio?.currentTime ?? silentClockOffset + performance.now() / 1000 - silentClockStart;
}

async function closeMedia(): Promise<void> {
  playing = false;
  const closing = [decoder?.close(), audio?.close()].filter((value): value is Promise<void> => Boolean(value));
  decoder = null;
  audio = null;
  await Promise.allSettled(closing);
}

function frameDiagnostics(frame: DecodeFrame): Record<string, unknown> {
  return {
    frame: frame.index,
    timestampUs: frame.timestampUs,
    dimensions: `${frame.width}×${frame.height}`,
    format: frame.format,
    scanType: frame.scanType,
    backend: frame.metadata?.idctMode,
    sourceBytesRead: decoder?.sourceBytesRead,
    cachedPackets: decoder?.cachedPacketCount,
    audio: audio?.track ?? null
  };
}

function setEnabled(enabled: boolean): void {
  playButton.disabled = !enabled;
  pauseButton.disabled = !enabled;
  seekInput.disabled = !enabled;
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing example element #${id}.`);
  return value as T;
}

function percent(value: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round(value / total * 100)) : 0;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function unavailable(message: string): never {
  throw new Error(message);
}
