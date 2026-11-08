interface ThumbnailWork<Key> {
  key: Key;
  drawUntil: (deadline: number) => boolean;
  onCancel: () => void;
}

/** Runs thumbnail drawing jobs under one shared per-frame time budget. */
export class ThumbnailWorkQueue<Key> {
  private queue: ThumbnailWork<Key>[] = [];
  private frame: number | null = null;
  private disposed = false;

  constructor(private readonly frameBudgetMs = 4) {}

  enqueue(key: Key, drawUntil: (deadline: number) => boolean, onCancel: () => void = () => undefined): void {
    if (this.disposed) { onCancel(); return; }
    this.queue.push({ key, drawUntil, onCancel });
    this.schedule();
  }

  cancel(key: Key): void {
    const cancelled = this.queue.filter((work) => work.key === key);
    this.queue = this.queue.filter((work) => work.key !== key);
    for (const work of cancelled) work.onCancel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) globalThis.cancelAnimationFrame(this.frame);
    this.frame = null;
    const cancelled = this.queue;
    this.queue = [];
    for (const work of cancelled) work.onCancel();
  }

  private schedule(): void {
    if (this.frame !== null || this.queue.length === 0 || this.disposed) return;
    this.frame = globalThis.requestAnimationFrame(() => {
      this.frame = null;
      const deadline = performance.now() + this.frameBudgetMs;
      let remaining = this.queue.length;
      while (this.queue.length > 0 && remaining > 0 && performance.now() < deadline) {
        const work = this.queue.shift()!;
        const startedAt = performance.now();
        const sliceDeadline = Math.min(deadline, startedAt + (deadline - startedAt) / remaining);
        if (!work.drawUntil(sliceDeadline)) this.queue.push(work);
        remaining--;
      }
      this.schedule();
    });
  }
}
