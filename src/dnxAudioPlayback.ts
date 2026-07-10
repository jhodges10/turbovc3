import {
  AudioBufferSink,
  BufferSource,
  Input,
  Mp4InputFormat,
  QuickTimeInputFormat
} from "mediabunny";

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

export class DnxAudioPlayback implements AsyncDisposable {
  readonly track: DnxAudioTrackInfo;
  private readonly sink: AudioBufferSink;
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
    private readonly input: Input,
    sink: AudioBufferSink,
    context: AudioContext,
    ownsContext: boolean,
    track: DnxAudioTrackInfo,
    options: DnxAudioPlaybackOptions
  ) {
    this.sink = sink;
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
        input,
        new AudioBufferSink(audioTrack),
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
    this.input.dispose();
    await this.schedulePromise.catch(() => undefined);
    if (this.ownsContext) {
      await this.context.close();
    }
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async scheduleBuffers(generation: number, timestamp: number): Promise<void> {
    for await (const wrapped of this.sink.buffers(timestamp)) {
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

function createAudioContext(): AudioContext | null {
  const constructor = globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return constructor ? new constructor({ latencyHint: "playback" }) : null;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
