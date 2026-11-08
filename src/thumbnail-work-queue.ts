interface ThumbnailWork<Key> {
  key: Key;
  drawUntil: (deadline: number) => boolean;
  onCancel: () => void;
}

interface IdleDeadlineLike { didTimeout: boolean; timeRemaining(): number }
interface IdleCallbackApi {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
}

/** Runs thumbnail drawing only in idle time where the browser supports it. */
export class ThumbnailWorkQueue<Key> {
  private queue: ThumbnailWork<Key>[] = [];
  private frame: number | null = null;
  private idle: number | null = null;
  private disposed = false;

  constructor(private readonly frameBudgetMs = 2) {}

  enqueue(key: Key, drawUntil: (deadline: number) => boolean, onCancel: () => void = () => undefined): void {
    if (this.disposed) { onCancel(); return; }
    this.queue.push({ key, drawUntil, onCancel });
    this.schedule();
  }

  cancel(key: Key): void {
    const cancelled = this.queue.filter((work) => work.key === key);
    this.queue = this.queue.filter((work) => work.key !== key);
    if (this.queue.length === 0) this.cancelScheduledWork();
    for (const work of cancelled) work.onCancel();
  }

  cancelAll(): void {
    this.cancelScheduledWork();
    const cancelled = this.queue;
    this.queue = [];
    for (const work of cancelled) work.onCancel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAll();
  }

  private schedule(): void {
    if (this.frame !== null || this.idle !== null || this.queue.length === 0 || this.disposed) return;
    const idleApi = globalThis as typeof globalThis & IdleCallbackApi;
    if (idleApi.requestIdleCallback) {
      this.idle = idleApi.requestIdleCallback((deadline) => {
        this.idle = null;
        const available = Math.max(0, deadline.timeRemaining());
        const budget = Math.min(this.frameBudgetMs, available > 0 ? available : deadline.didTimeout ? 1 : 0);
        this.drain(performance.now() + budget);
      }, { timeout: 250 });
      return;
    }
    // WebKit versions without requestIdleCallback get a small bounded slice,
    // then yield for the rest of the frame so pen and toolbar input can run.
    this.frame = globalThis.requestAnimationFrame(() => {
      this.frame = null;
      this.drain(performance.now() + this.frameBudgetMs);
    });
  }

  private drain(deadline: number): void {
    let remaining = this.queue.length;
    while (this.queue.length > 0 && remaining > 0 && performance.now() < deadline) {
      const work = this.queue.shift()!;
      const startedAt = performance.now();
      const sliceDeadline = Math.min(deadline, startedAt + (deadline - startedAt) / remaining);
      if (!work.drawUntil(sliceDeadline)) this.queue.push(work);
      remaining--;
    }
    this.schedule();
  }

  private cancelScheduledWork(): void {
    if (this.frame !== null) globalThis.cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.idle !== null) {
      (globalThis as typeof globalThis & IdleCallbackApi).cancelIdleCallback?.(this.idle);
      this.idle = null;
    }
  }
}
