import {
  AudioBufferSink,
  BufferSource,
  Input,
  Mp4InputFormat,
  QuickTimeInputFormat
} from "mediabunny";
import { MxfDemuxer } from "./mxf/mxfDemuxer.js";
import type { MxfPacket, MxfTrack } from "./mxf/mxfTypes.js";
import type { MxfSourceInput } from "./mxf/mxfSource.js";

export interface DnxAudioPlaybackOptions {
  audioContext?: AudioContext;
  destination?: AudioNode;
  scheduleLeadTime?: number;
  onError?: (error: Error) => void;
}

export interface DnxAudioTrackInfo {
  codec: string | null;
  sampleRate: number;
  numberOfChannels: number;
  duration: number;
}

interface ScheduledAudioBuffer {
  buffer: AudioBuffer;
  timestamp: number;
  duration: number;
}

interface DnxAudioSource {
  buffers(timestamp: number): AsyncIterable<ScheduledAudioBuffer>;
  dispose(): void;
}

export class DnxAudioPlayback implements AsyncDisposable {
  readonly track: DnxAudioTrackInfo;
  private readonly source: DnxAudioSource;
  private readonly context: AudioContext;
  private readonly destination: AudioNode;
  private readonly ownsContext: boolean;
  private readonly scheduleLeadTime: number;
  private readonly onError: (error: Error) => void;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private scheduleGeneration = 0;
  private schedulePromise: Promise<void> = Promise.resolve();
  private mediaStartTime = 0;
  private contextStartTime = 0;
  private pausedTime = 0;
  private playing = false;
  private closed = false;

  private constructor(
    source: DnxAudioSource,
    context: AudioContext,
    ownsContext: boolean,
    track: DnxAudioTrackInfo,
    options: DnxAudioPlaybackOptions
  ) {
    this.source = source;
    this.context = context;
    this.destination = options.destination ?? context.destination;
    this.ownsContext = ownsContext;
    this.track = track;
    this.scheduleLeadTime = Math.max(0, options.scheduleLeadTime ?? 0.05);
    this.onError = options.onError ?? (() => undefined);
  }

  static async create(
    bytes: Uint8Array,
    options: DnxAudioPlaybackOptions = {}
  ): Promise<DnxAudioPlayback | null> {
    const context = options.audioContext ?? createAudioContext();
    if (!context) {
      return null;
    }
    const ownsContext = !options.audioContext;
    const input = new Input({
      formats: [new QuickTimeInputFormat(), new Mp4InputFormat()],
      source: new BufferSource(bytes)
    });

    try {
      const audioTrack = await input.getPrimaryAudioTrack();
      if (!audioTrack || !(await audioTrack.canDecode())) {
        input.dispose();
        if (ownsContext) {
          await context.close();
        }
        return null;
      }
      const [codec, sampleRate, numberOfChannels, duration] = await Promise.all([
        audioTrack.getCodec(),
        audioTrack.getSampleRate(),
        audioTrack.getNumberOfChannels(),
        input.computeDuration([audioTrack])
      ]);
      return new DnxAudioPlayback(
        new MediabunnyAudioSource(input, new AudioBufferSink(audioTrack)),
        context,
        ownsContext,
        { codec, sampleRate, numberOfChannels, duration },
        options
      );
    } catch (error) {
      input.dispose();
      if (ownsContext) {
        await context.close();
      }
      throw error;
    }
  }

  static async createFromMxf(
    input: MxfSourceInput | MxfDemuxer,
    options: DnxAudioPlaybackOptions = {}
  ): Promise<DnxAudioPlayback | null> {
    const context = options.audioContext ?? createAudioContext();
    if (!context) {
      return null;
    }
    const ownsContext = !options.audioContext;
    try {
      const demuxer = input instanceof MxfDemuxer ? input : await MxfDemuxer.open(input);
      const track = demuxer.tracks.find((candidate) => candidate.kind === "audio");
      if (!track || !isSupportedMxfPcmTrack(track)) {
        if (ownsContext) await context.close();
        return null;
      }
      const packets = demuxer.packetsForTrack(track);
      if (packets.length === 0) {
        if (ownsContext) await context.close();
        return null;
      }
      const sampleRate = track.descriptor!.sampleRate!.numerator / track.descriptor!.sampleRate!.denominator;
      const numberOfChannels = track.descriptor!.channels!;
      const bitsPerSample = track.descriptor!.bitsPerSample!;
      const duration = Math.max(...packets.map((packet) => packet.timestamp + packet.duration));
      return new DnxAudioPlayback(
        new MxfPcmAudioSource(demuxer, packets, context, sampleRate, numberOfChannels, bitsPerSample),
        context,
        ownsContext,
        { codec: `pcm_s${bitsPerSample}le`, sampleRate, numberOfChannels, duration },
        options
      );
    } catch (error) {
      if (ownsContext) await context.close();
      throw error;
    }
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get isClockRunning(): boolean {
    return this.playing && this.context.state === "running";
  }

  get currentTime(): number {
    if (!this.playing) {
      return this.pausedTime;
    }
    return Math.min(
      this.track.duration,
      this.mediaStartTime + Math.max(0, this.context.currentTime - this.contextStartTime)
    );
  }

  async unlock(): Promise<void> {
    this.assertOpen();
    if (this.context.state === "suspended") {
      void this.context.resume().catch((error: unknown) => {
        if (!this.closed) {
          this.onError(toError(error));
        }
      });
    }
  }

  async start(timestamp = this.pausedTime): Promise<void> {
    this.assertOpen();
    const boundedTimestamp = Math.max(0, Math.min(this.track.duration, timestamp));
    this.stopSources();
    await this.unlock();

    const generation = ++this.scheduleGeneration;
    this.mediaStartTime = boundedTimestamp;
    this.pausedTime = boundedTimestamp;
    this.contextStartTime = this.context.currentTime + this.scheduleLeadTime;
    this.playing = true;
    this.schedulePromise = this.scheduleBuffers(generation, boundedTimestamp).catch((error: unknown) => {
      if (generation === this.scheduleGeneration && !this.closed) {
        this.playing = false;
        this.onError(toError(error));
      }
    });
  }

  pause(): void {
    if (!this.playing) {
      return;
    }
    this.pausedTime = this.currentTime;
    this.playing = false;
    this.scheduleGeneration += 1;
    this.stopSources();
  }

  async seek(timestamp: number): Promise<void> {
    if (this.playing) {
      await this.start(timestamp);
    } else {
      this.pausedTime = Math.max(0, Math.min(this.track.duration, timestamp));
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.playing = false;
    this.scheduleGeneration += 1;
    this.stopSources();
    this.source.dispose();
    await this.schedulePromise.catch(() => undefined);
    if (this.ownsContext) {
      await this.context.close();
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async scheduleBuffers(generation: number, timestamp: number): Promise<void> {
    for await (const wrapped of this.source.buffers(timestamp)) {
      if (generation !== this.scheduleGeneration || this.closed) {
        return;
      }
      const offset = Math.max(0, timestamp - wrapped.timestamp);
      if (offset >= wrapped.duration) {
        continue;
      }
      const source = this.context.createBufferSource();
      source.buffer = wrapped.buffer;
      source.connect(this.destination);
      source.onended = () => {
        source.disconnect();
        this.sources.delete(source);
      };
      this.sources.add(source);
      const relativeStart = Math.max(0, wrapped.timestamp - timestamp);
      source.start(this.contextStartTime + relativeStart, offset);
    }
  }

  private stopSources(): void {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source that naturally ended may reject a second stop call.
      }
      source.disconnect();
    }
    this.sources.clear();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("DNx audio playback is closed.");
    }
  }
}

class MediabunnyAudioSource implements DnxAudioSource {
  constructor(
    private readonly input: Input,
    private readonly sink: AudioBufferSink
  ) {}

  buffers(timestamp: number): AsyncIterable<ScheduledAudioBuffer> {
    return this.sink.buffers(timestamp);
  }

  dispose(): void {
    this.input.dispose();
  }
}

class MxfPcmAudioSource implements DnxAudioSource {
  constructor(
    private readonly demuxer: MxfDemuxer,
    private readonly packets: readonly MxfPacket[],
    private readonly context: AudioContext,
    private readonly sampleRate: number,
    private readonly channels: number,
    private readonly bitsPerSample: number
  ) {}

  async *buffers(timestamp: number): AsyncIterable<ScheduledAudioBuffer> {
    const bytesPerSample = this.bitsPerSample / 8;
    const bytesPerFrame = bytesPerSample * this.channels;
    for (const packet of this.packets) {
      if (packet.timestamp + packet.duration <= timestamp) {
        continue;
      }
      const bytes = await this.demuxer.readPacket(packet);
      if (bytes.byteLength % bytesPerFrame !== 0) {
        throw new Error(
          `MXF PCM packet ${packet.index} has ${bytes.byteLength} bytes, not a multiple of ${bytesPerFrame}.`
        );
      }
      const frameCount = bytes.byteLength / bytesPerFrame;
      const buffer = this.context.createBuffer(this.channels, frameCount, this.sampleRate);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let channel = 0; channel < this.channels; channel += 1) {
        const output = buffer.getChannelData(channel);
        for (let frame = 0; frame < frameCount; frame += 1) {
          const offset = (frame * this.channels + channel) * bytesPerSample;
          output[frame] = readPcmSample(view, offset, this.bitsPerSample);
        }
      }
      yield {
        buffer,
        timestamp: packet.timestamp,
        duration: frameCount / this.sampleRate
      };
    }
  }

  dispose(): void {}
}

function isSupportedMxfPcmTrack(track: MxfTrack): boolean {
  const descriptor = track.descriptor;
  const sampleRate = descriptor?.sampleRate;
  const channels = descriptor?.channels;
  const bitsPerSample = descriptor?.bitsPerSample;
  const essenceContainer = descriptor?.essenceContainerUl;
  return Boolean(
    sampleRate &&
    sampleRate.numerator > 0 &&
    sampleRate.denominator > 0 &&
    channels &&
    channels > 0 &&
    (bitsPerSample === 16 || bitsPerSample === 24 || bitsPerSample === 32) &&
    essenceContainer?.startsWith("060e2b34040101010d0103010206")
  );
}

function readPcmSample(view: DataView, offset: number, bitsPerSample: number): number {
  if (bitsPerSample === 16) {
    return view.getInt16(offset, true) / 0x8000;
  }
  if (bitsPerSample === 24) {
    const value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
    return ((value & 0x800000) ? value - 0x1000000 : value) / 0x800000;
  }
  return view.getInt32(offset, true) / 0x80000000;
}

function createAudioContext(): AudioContext | null {
  const constructor = globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return constructor ? new constructor({ latencyHint: "playback" }) : null;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
