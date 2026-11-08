import { afterEach, describe, expect, it, vi } from "vitest";
import { ThumbnailWorkQueue } from "../src/thumbnail-work-queue";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("thumbnail work queue", () => {
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
});
