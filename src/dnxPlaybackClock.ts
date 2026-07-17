export interface DnxPlaybackClockOptions {
  duration: number;
  now?: () => number;
}

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
    return this.running;
  }

  get currentTime(): number {
    if (!this.running) {
      return this.pausedTime;
    }
    return this.clamp(
      this.mediaAnchor + Math.max(0, this.now() - this.clockAnchor)
    );
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
