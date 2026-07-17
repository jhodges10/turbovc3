export interface DnxPlaybackClockOptions {
  duration: number;
  now?: () => number;
}

export type DnxPlaybackSyncDecision = "drop" | "present" | "hold";

export class DnxPlaybackClock {
  readonly duration: number;
  private readonly now: () => number;
  private mediaAnchor = 0;
  private clockAnchor = 0;
  private pausedTime = 0;
  private running = false;

  constructor(options: DnxPlaybackClockOptions) {
    if (!Number.isFinite(options.duration) || options.duration < 0) {
      throw new RangeError("DNx playback clock duration must be a finite non-negative number.");
    }
    this.duration = options.duration;
    this.now = options.now ?? (() => performance.now() / 1000);
  }

  get isRunning(): boolean {
    this.sampleCurrentTime();
    return this.running;
  }

  get currentTime(): number {
    return this.sampleCurrentTime();
  }

  get isEnded(): boolean {
    return this.sampleCurrentTime() >= this.duration;
  }

  videoDecision(timestamp: number, tolerance = 1 / 60): DnxPlaybackSyncDecision {
    if (!Number.isFinite(timestamp)) {
      throw new RangeError("DNx video timestamps must be finite numbers.");
    }
    if (!Number.isFinite(tolerance) || tolerance < 0) {
      throw new RangeError("DNx playback sync tolerance must be a finite non-negative number.");
    }
    const drift = timestamp - this.sampleCurrentTime();
    return drift < -tolerance ? "drop" : drift > tolerance ? "hold" : "present";
  }

  private sampleCurrentTime(): number {
    if (!this.running) {
      return this.pausedTime;
    }
    const timestamp = this.clamp(
      this.mediaAnchor + Math.max(0, this.now() - this.clockAnchor)
    );
    if (timestamp >= this.duration) {
      this.pausedTime = this.duration;
      this.running = false;
    }
    return timestamp;
  }

  start(timestamp = this.pausedTime, clockTime = this.now()): void {
    this.mediaAnchor = this.clamp(timestamp);
    this.pausedTime = this.mediaAnchor;
    this.clockAnchor = clockTime;
    this.running = true;
  }

  pause(): number {
    this.pausedTime = this.currentTime;
    this.running = false;
    return this.pausedTime;
  }

  seek(timestamp: number): number {
    const bounded = this.clamp(timestamp);
    if (this.running) {
      this.mediaAnchor = bounded;
      this.clockAnchor = this.now();
    }
    this.pausedTime = bounded;
    return bounded;
  }

  private clamp(timestamp: number): number {
    if (!Number.isFinite(timestamp)) {
      throw new RangeError("DNx playback clock timestamps must be finite numbers.");
    }
    return Math.max(0, Math.min(this.duration, timestamp));
  }
}
