type TimerLike = ReturnType<typeof setTimeout> | null;

export class ElectionTimer {
  private minTimeout: number;
  private maxTimeout: number;
  private timer: TimerLike = null;
  private callback: (() => void) | null = null;

  constructor(config: { electionTimeoutMin?: number; electionTimeoutMax?: number }) {
    this.minTimeout = config.electionTimeoutMin ?? 150;
    this.maxTimeout = config.electionTimeoutMax ?? 300;
  }

  reset(): void {
    this.stop();
    const timeout = this.minTimeout + Math.random() * (this.maxTimeout - this.minTimeout);
    this.timer = setTimeout(() => {
      if (this.callback) this.callback();
    }, timeout);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer as NodeJS.Timeout);
      this.timer = null;
    }
  }

  onTimeout(callback: () => void): void {
    this.callback = callback;
  }
}
