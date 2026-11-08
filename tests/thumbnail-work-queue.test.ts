import { afterEach, describe, expect, it, vi } from "vitest";
import { ThumbnailWorkQueue } from "../src/thumbnail-work-queue";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("thumbnail work queue", () => {
  it("uses the browser idle budget when available", () => {
    const idleCallbacks: Array<(deadline: { didTimeout: boolean; timeRemaining(): number }) => void> = [];
    const draw = vi.fn((_deadline: number) => true);
    const idleApi = globalThis as typeof globalThis & { requestIdleCallback: (callback: (deadline: { didTimeout: boolean; timeRemaining(): number }) => void) => number };
    vi.stubGlobal("requestIdleCallback", vi.fn((callback: (deadline: { didTimeout: boolean; timeRemaining(): number }) => void) => {
      idleCallbacks.push(callback); return idleCallbacks.length;
    }));
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    vi.stubGlobal("requestAnimationFrame", vi.fn());
    vi.spyOn(performance, "now").mockReturnValue(0);

    const queue = new ThumbnailWorkQueue<string>(2);
    queue.enqueue("a", (deadline) => { draw(deadline); return true; });
    expect(vi.mocked(idleApi.requestIdleCallback)).toHaveBeenCalledOnce();
    expect(vi.mocked(requestAnimationFrame)).not.toHaveBeenCalled();
    idleCallbacks[0]({ didTimeout: false, timeRemaining: () => 8 });
    expect(draw).toHaveBeenCalledWith(2);
    queue.dispose();
  });

  it("shares each frame budget fairly across queued thumbnails", () => {
    const frames: FrameRequestCallback[] = [];
    let now = 0;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const queue = new ThumbnailWorkQueue<string>(6);
    const progress = new Map([ ["a", 0], ["b", 0], ["c", 0] ]);
    for (const key of progress.keys()) queue.enqueue(key, (deadline) => {
      while ((progress.get(key) ?? 0) < 2 && now < deadline) {
        progress.set(key, (progress.get(key) ?? 0) + 1);
        now += Math.min(1, deadline - now);
      }
      return progress.get(key) === 2;
    });

    frames.shift()!(0);
    expect(now).toBe(6);
    expect([...progress.values()]).toEqual([2, 2, 2]);

    while (frames.length > 0) frames.shift()!(now);
    queue.dispose();
    expect([...progress.values()]).toEqual([2, 2, 2]);
  });

  it("cancels queued work by canvas key and settles disposal callbacks", () => {
    const frames: FrameRequestCallback[] = [];
    const cancelled: string[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(performance, "now").mockReturnValue(0);

    const queue = new ThumbnailWorkQueue<string>(6);
    queue.enqueue("old", () => false, () => cancelled.push("old"));
    queue.enqueue("keep", () => false, () => cancelled.push("keep"));
    queue.cancel("old");
    expect(cancelled).toEqual(["old"]);

    queue.dispose();
    expect(cancelled).toEqual(["old", "keep"]);
    expect(vi.mocked(cancelAnimationFrame)).toHaveBeenCalledOnce();
    expect(frames).toHaveLength(1);
  });

  it("cancels the scheduled slice and settles every callback when the rail closes", () => {
    const cancelled: string[] = [];
    const idleApi = globalThis as typeof globalThis & {
      requestIdleCallback: (callback: (deadline: { didTimeout: boolean; timeRemaining(): number }) => void) => number;
      cancelIdleCallback: (id: number) => void;
    };
    vi.stubGlobal("requestIdleCallback", vi.fn((_callback: (deadline: { didTimeout: boolean; timeRemaining(): number }) => void) => 1));
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const queue = new ThumbnailWorkQueue<string>();
    queue.enqueue("a", () => false, () => cancelled.push("a"));
    queue.enqueue("b", () => false, () => cancelled.push("b"));
    queue.cancelAll();
    expect(cancelled).toEqual(["a", "b"]);
    expect(vi.mocked(idleApi.cancelIdleCallback)).toHaveBeenCalledOnce();
    queue.dispose();
  });
});
