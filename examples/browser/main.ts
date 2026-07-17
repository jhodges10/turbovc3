import {
  DnxCanvasRenderer,
  DnxRandomAccessDecoder,
  DnxWebGpuRenderer,
  type DecodeFrame
} from "../../src/index.js";
import type { MxfSource, MxfSourceInput } from "../../src/mxf/index.js";

interface Sample {
  profile: string;
  name: string;
  detail: string;
}

const samples: readonly Sample[] = [
  { profile: "dnxhr_lb", name: "DNxHR LB", detail: "8-bit 4:2:2 · lightweight" },
  { profile: "dnxhr_sq", name: "DNxHR SQ", detail: "8-bit 4:2:2 · standard quality" },
  { profile: "dnxhr_hq", name: "DNxHR HQ", detail: "8-bit 4:2:2 · high quality" },
  { profile: "dnxhr_hqx", name: "DNxHR HQX", detail: "10-bit 4:2:2 · high quality" },
  { profile: "dnxhr_444", name: "DNxHR 444", detail: "10-bit RGB 4:4:4 · finishing" }
];

type ColorSet = "sdr" | "hdr";
type ResolutionSet = "1080" | "2160";

function start(): void {
  let selectedColor: ColorSet = "sdr";
  let selectedResolution: ResolutionSet = "1080";
  let selectedSample = samples[0];
  let variantGeneration = 0;
  let metadataGeneration = 0;
  let sampleGeneration = 0;
  const flavorList = required("flavor-list");
  const flavorRows = new Map<string, HTMLButtonElement>();
  const player = new GalleryPlayer(
    selectedSample,
    true,
    () => sampleUrl(selectedSample.profile, selectedColor, selectedResolution)
  );
  required("selected-viewer").append(player.element);

  for (const sample of samples) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "flavor-row";
    row.dataset.profile = sample.profile;
    row.setAttribute("aria-current", String(sample === selectedSample));
    row.innerHTML = `<span class="flavor-name">${sample.name}</span><span class="flavor-detail">${sample.detail}</span><span class="flavor-stats" data-role="media-stats">Loading…</span>`;
    row.addEventListener("click", () => {
      if (sample === selectedSample) return;
      const generation = ++sampleGeneration;
      selectedSample = sample;
      for (const [profile, candidate] of flavorRows) {
        candidate.setAttribute("aria-current", String(profile === selectedSample.profile));
      }
      void player.selectSample(sample).then(() => {
        if (generation !== sampleGeneration) return;
        return player.load();
      });
    });
    flavorRows.set(sample.profile, row);
    flavorList.append(row);
  }

  const updateMediaStats = (): void => {
    const generation = ++metadataGeneration;
    for (const row of flavorRows.values()) find<HTMLElement>(row, "[data-role='media-stats']").textContent = "Loading…";
    for (const sample of samples) {
      const url = sampleUrl(sample.profile, selectedColor, selectedResolution);
      void sampleMediaStats(url).then((stats) => {
        if (generation !== metadataGeneration) return;
        const output = find<HTMLElement>(flavorRows.get(sample.profile)!, "[data-role='media-stats']");
        output.textContent = `${formatFileSize(stats.size)}\n${stats.bitrateMbps.toFixed(1)} Mb/s`;
      }).catch(() => {
        if (generation !== metadataGeneration) return;
        find<HTMLElement>(flavorRows.get(sample.profile)!, "[data-role='media-stats']").textContent = "Unavailable";
      });
    }
  };

  const filterButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-filter]")];
  for (const button of filterButtons) {
    button.addEventListener("click", () => {
      const color = button.dataset.color as ColorSet | undefined;
      const resolution = button.dataset.resolution as ResolutionSet | undefined;
      if ((!color || color === selectedColor) && (!resolution || resolution === selectedResolution)) return;
      if (color) selectedColor = color;
      if (resolution) selectedResolution = resolution;
      const generation = ++variantGeneration;
      updateVariantUi(selectedColor, selectedResolution, filterButtons);
      updateMediaStats();
      void player.unload().then(() => {
        if (generation !== variantGeneration) return;
        return player.load();
      });
    });
  }
  updateVariantUi(selectedColor, selectedResolution, filterButtons);
  updateMediaStats();
  void player.load();

  const customPlayer = new GalleryPlayer({
    profile: "custom",
    name: "Local MXF",
    detail: "Choose an OP1a or OPAtom DNx file"
  }, false);
  required("custom-viewer").append(customPlayer.element);
  const fileInput = required<HTMLInputElement>("file");
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void customPlayer.load(file, file.name);
  });

  window.addEventListener("pagehide", () => {
    void Promise.allSettled([player.unload(), customPlayer.unload()]);
  });
}

class GalleryPlayer {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly playbackButton: HTMLButtonElement;
  private readonly seekInput: HTMLInputElement;
  private readonly position: HTMLOutputElement;
  private readonly status: HTMLElement;
  private readonly diagnostics: HTMLElement;
  private renderer: DnxCanvasRenderer | DnxWebGpuRenderer | null = null;
  private rendererMode = "uninitialized";
  private decoder: DnxRandomAccessDecoder | null = null;
  private generation = 0;
  private frameRate = 24000 / 1001;
  private currentFrame = 0;
  private playing = false;
  private clockStart = 0;
  private clockOffset = 0;
  private renderPending = false;

  constructor(
    private sample: Sample,
    private readonly automatic = true,
    private readonly sourceUrl: () => string = () => ""
  ) {
    this.element = document.createElement("article");
    this.element.className = "viewer";
    this.element.dataset.profile = sample.profile;
    this.element.dataset.state = "idle";
    this.element.innerHTML = viewerMarkup(sample);
    this.canvas = find(this.element, "canvas");
    this.playbackButton = find(this.element, "[data-action='playback']");
    this.seekInput = find(this.element, "input[type='range']");
    this.position = find(this.element, "output");
    this.status = find(this.element, "[data-role='status']");
    this.diagnostics = find(this.element, "pre");
    this.playbackButton.addEventListener("click", () => void this.togglePlayback());
    this.seekInput.addEventListener("input", () => void this.seek(Number(this.seekInput.value)));
  }

  async selectSample(sample: Sample): Promise<void> {
    await this.unload();
    this.sample = sample;
    this.element.dataset.profile = sample.profile;
    find<HTMLElement>(this.element, "h3").textContent = sample.name;
    find<HTMLElement>(this.element, ".viewer-copy").textContent = sample.detail;
    find<HTMLElement>(this.element, ".badge").textContent = sample.profile.replace("dnxhr_", "");
    this.canvas.setAttribute("aria-label", `${sample.name} video output`);
  }

  async load(input?: MxfSourceInput, label = this.sample.name): Promise<void> {
    if (this.decoder || this.element.dataset.state === "loading") return;
    const generation = ++this.generation;
    this.element.dataset.state = "loading";
    this.status.textContent = `Opening ${label}…`;
    this.setEnabled(false);
    try {
      this.renderer = await DnxWebGpuRenderer.create(this.canvas, {
        onDeviceLost: (error) => {
          this.pause();
          this.status.textContent = error.message;
        }
      });
      this.rendererMode = this.renderer ? "webgpu" : "canvas2d";
      this.renderer ??= DnxCanvasRenderer.create(this.canvas);
      if (!this.renderer) throw new Error("WebGPU and Canvas2D are unavailable.");
      const source = input ?? await HttpRangeSource.open(this.sourceUrl());
      if (generation !== this.generation) return;
      const opened = await DnxRandomAccessDecoder.create(source, {
        concurrency: Math.min(8, Math.max(1, navigator.hardwareConcurrency ?? 4)),
        packetCacheSize: 4,
        prefetchFrames: 1,
        onIndexProgress: ({ offset, totalBytes }) => {
          if (generation === this.generation) this.status.textContent = `Indexing · ${percent(offset, totalBytes)}%`;
        }
      });
      if (generation !== this.generation) {
        if (!(opened instanceof Error)) await opened.close();
        return;
      }
      if (opened instanceof Error) throw opened;
      this.decoder = opened;
      this.frameRate = opened.editRate ? opened.editRate.numerator / opened.editRate.denominator : 24000 / 1001;
      this.seekInput.max = String(opened.frameCount - 1);
      this.setEnabled(true);
      await this.renderFrame(0);
      this.element.dataset.state = "ready";
      this.status.textContent = `${opened.frameCount} frames · ${formatBytes(opened.sourceBytesRead)} indexed`;
    } catch (error) {
      if (generation !== this.generation) return;
      this.element.dataset.state = "error";
      this.status.textContent = toError(error).message;
    }
  }

  async unload(): Promise<void> {
    if (!this.automatic && !this.decoder) return;
    ++this.generation;
    this.pause();
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder) await decoder.close();
    this.renderer?.destroy();
    this.renderer = null;
    this.rendererMode = "uninitialized";
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.currentFrame = 0;
    this.seekInput.value = "0";
    this.position.value = "—";
    this.setEnabled(false);
    this.element.dataset.state = "idle";
    this.status.textContent = this.automatic ? "Sample unloaded" : "Choose a file to begin";
    this.diagnostics.textContent = "No decoder allocated.";
  }

  private async renderFrame(index: number): Promise<void> {
    const decoder = this.decoder;
    if (!decoder) return;
    const frame = await decoder.seek(index);
    if (frame instanceof Error) {
      if (frame.name !== "AbortError") this.status.textContent = frame.message;
      return;
    }
    if (decoder !== this.decoder) return;
    this.renderer?.render(frame);
    this.currentFrame = index;
    this.seekInput.value = String(index);
    this.position.value = `${index + 1} / ${decoder.frameCount}`;
    this.diagnostics.textContent = JSON.stringify(frameDiagnostics(frame, decoder, this.rendererMode), null, 2);
  }

  private async play(): Promise<void> {
    if (!this.decoder || this.playing) return;
    if (this.currentFrame >= this.decoder.frameCount - 1) await this.seek(0);
    this.playing = true;
    this.updatePlaybackButton();
    this.clockOffset = this.currentFrame / this.frameRate;
    this.clockStart = performance.now() / 1000;
    requestAnimationFrame(() => this.tick());
  }

  private pause(): void {
    if (this.playing) this.clockOffset = this.mediaTime();
    this.playing = false;
    this.updatePlaybackButton();
  }

  private async togglePlayback(): Promise<void> {
    if (this.playing) this.pause();
    else await this.play();
  }

  private async seek(index: number): Promise<void> {
    this.clockOffset = index / this.frameRate;
    this.clockStart = performance.now() / 1000;
    await this.renderFrame(index);
  }

  private tick(): void {
    const decoder = this.decoder;
    if (!this.playing || !decoder) return;
    const target = Math.min(decoder.frameCount - 1, Math.floor(this.mediaTime() * this.frameRate));
    if (target !== this.currentFrame && !this.renderPending) {
      this.renderPending = true;
      void this.renderFrame(target).finally(() => { this.renderPending = false; });
    }
    if (target >= decoder.frameCount - 1) {
      this.pause();
      return;
    }
    requestAnimationFrame(() => this.tick());
  }

  private mediaTime(): number {
    return this.clockOffset + performance.now() / 1000 - this.clockStart;
  }

  private setEnabled(enabled: boolean): void {
    this.playbackButton.disabled = !enabled;
    this.seekInput.disabled = !enabled;
    if (!enabled) this.pause();
  }

  private updatePlaybackButton(): void {
    this.playbackButton.textContent = this.playing ? "Pause" : "Play";
    this.playbackButton.setAttribute("aria-pressed", String(this.playing));
  }
}

class HttpRangeSource implements MxfSource {
  private constructor(readonly size: number, private readonly url: string) {}

  static async open(url: string): Promise<HttpRangeSource> {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) throw new Error(`Sample unavailable (${response.status}). Run the sample generator first.`);
    const size = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Sample server did not report a valid file size.");
    return new HttpRangeSource(size, url);
  }

  async read(offset: number, length: number, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.size) {
      throw new RangeError(`HTTP source range ${offset}+${length} is outside 0-${this.size}.`);
    }
    if (length === 0) return new Uint8Array();
    const response = await fetch(this.url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
      signal: options.signal
    });
    if (response.status !== 206) throw new Error(`Sample server rejected a byte-range request (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== length) throw new Error(`Short byte-range response: expected ${length}, received ${bytes.byteLength}.`);
    return bytes;
  }
}

function viewerMarkup(sample: Sample): string {
  const placeholder = sample.profile === "custom" ? "Choose a file to begin" : "Loading selected flavor…";
  return `<div class="viewer-head"><div><h3>${sample.name}</h3><div class="viewer-copy">${sample.detail}</div></div><span class="badge">${sample.profile === "custom" ? "MXF" : sample.profile.replace("dnxhr_", "")}</span></div>
    <div class="stage"><canvas aria-label="${sample.name} video output"></canvas><div class="placeholder">${placeholder}</div></div>
    <div class="controls"><button data-action="playback" type="button" aria-pressed="false" disabled>Play</button><input type="range" min="0" max="0" value="0" step="1" disabled aria-label="Frame"><output>—</output></div>
    <div class="viewer-foot"><span class="status" data-role="status">${sample.profile === "custom" ? "Choose a file to begin" : "Waiting for viewport"}</span><details><summary>Diagnostics</summary><pre>No decoder allocated.</pre></details></div>`;
}

function frameDiagnostics(
  frame: DecodeFrame,
  decoder: DnxRandomAccessDecoder,
  renderer: string
): Record<string, unknown> {
  return {
    profile: (frame.metadata?.header as { profile?: unknown } | undefined)?.profile,
    frame: frame.index,
    dimensions: `${frame.width}×${frame.height}`,
    format: frame.format,
    backend: frame.metadata?.idctMode,
    renderer,
    sourceBytesRead: decoder.sourceBytesRead,
    cachedPackets: decoder.cachedPacketCount
  };
}

function sampleUrl(profile: string, color: ColorSet, resolution: ResolutionSet): string {
  const gamut = color === "hdr" ? "rec2020" : "rec709";
  return `/samples/beach_${gamut}_${profile}_${resolution}p2398_5s.mxf`;
}

async function sampleMediaStats(url: string): Promise<{ size: number; bitrateMbps: number }> {
  const response = await fetch(url, { method: "HEAD" });
  if (!response.ok) throw new Error(`Sample unavailable (${response.status}).`);
  const size = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid sample size.");
  return { size, bitrateMbps: size * 8 / 5.005 / 1_000_000 };
}

function updateVariantUi(
  color: ColorSet,
  resolution: ResolutionSet,
  buttons: readonly HTMLButtonElement[]
): void {
  document.body.dataset.color = color;
  for (const button of buttons) {
    const selected = (button.dataset.color === color) || (button.dataset.resolution === resolution);
    button.setAttribute("aria-pressed", String(selected));
  }
  required("pipeline-description").textContent = color === "hdr"
    ? "A five-second R3D camera original, developed in RWG/Log3G10 and transformed with RED’s Rec.2020 / BT.1886 Medium Contrast / R_2 IPP2 LUT."
    : "A five-second R3D camera original, developed in RWG/Log3G10 and transformed with RED’s Rec.709 / BT.1886 Medium Contrast / R_2 IPP2 LUT.";
  required("resolution-pill").textContent = resolution === "2160" ? "3840 × 2160" : "1920 × 1080";
  required("color-pill").textContent = color === "hdr" ? "HDR · Rec.2020 / BT.1886" : "SDR · Rec.709 / BT.1886";
}

function required<T extends HTMLElement = HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}.`);
  return value as T;
}

function find<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector(selector);
  if (!value) throw new Error(`Missing ${selector}.`);
  return value as T;
}

function percent(value: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round(value / total * 100)) : 0;
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

function formatFileSize(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`;
  return `${(value / 1_000_000).toFixed(value < 100_000_000 ? 1 : 0)} MB`;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

start();
