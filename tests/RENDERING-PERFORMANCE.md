# Rendering performance check

## Current tiled implementation

The full-page measurements below describe the intermediate renderer, not the
final drawing path. The final renderer uses 128-logical-pixel tiles, a uniform
spatial index, cached Canvas bitmaps, and viewport-sized selection/pen overlays.
Zoom/scroll reuse mounted tiles immediately. After 100 ms of inactivity, tiles
are refined one per animation frame. Newly exposed uncached regions receive a
low-density tile even during motion, so completely uncached content is not instant.

The current and adjacent pages share a roughly 16-million-pixel (64 MB RGBA)
LRU tile budget. Each of the two viewport overlays is capped at 4 million pixels
(16 MB); the pen overlay is released at pen-up. Nominal bitmap total is therefore
about 96 MB at the cap, before browser/GPU copies and vector path storage. Visible
tile density is reduced under pressure. This is not unlimited lossless zoom.

Neighbor prewarming covers only the corresponding visible region and runs behind
current-page tile jobs. It is best-effort: rapid navigation can outrun prewarming.
There is no page-slide animation and no explicit WebGL or worker renderer. CSS
transforms allow browser compositor acceleration, but GPU execution is browser-
and device-dependent; geometry/index work still runs on the main thread.

Index sync scans a page's stroke metadata on edits, commit, and page activation;
queries for painting do not scan the page. Pen motion only rebuilds the live pen.
Pen-up flushes dirty visible tiles synchronously to avoid double-composited ink
or disappearing previews, so very long strokes can still cause a commit spike.

The dedicated tests/tiles-browser.ts harness uses 1001 strokes / about 80400
points, includes a semi-transparent cross-tile stroke, and checks visible pixels,
deletion invalidation and exact pixel restoration after undo. Synthetic data and
forced readback are not a guarantee of Obsidian/mobile input latency.

Latest final-harness run: index build 17.7 ms; local query average 0.006 ms,
39 candidates out of 1001 strokes. Tile median / maximum: density 2 = 17.4 /
32.4 ms; density 6 = 12.0 / 16.2 ms. Earlier runs were faster; these figures
show the variance, not a stable 60 FPS claim. The visible sample had 276491
nontransparent pixels; deleting the crossing stroke changed 15 visible tiles
and restoring it reproduced the original pixels exactly.

## Intermediate full-page baseline

Measured in the local Codex Chromium browser on 2026-09-08. Synthetic strokes,
820 x 1180 logical page, DPR 2, 80 samples per completed stroke. Timings include
a 1-pixel getImageData readback to flush raster work. They are conservative
rendering measurements, not end-to-end input latency or a mobile FPS guarantee.
Each full-page case has two warmup frames and seven measured frames.

| Completed strokes | Zoom | Legacy median ms | Cached outline median ms |
| --- | --- | --- | --- |
| 100 | 1x | 165.5 | 15.0 |
| 100 | 3x | 167.8 | 18.9 |
| 500 | 1x | 769.8 | 53.6 |
| 500 | 3x | 918.1 | 74.8 |
| 1000 | 1x | 1702.9 | 113.9 |
| 1000 | 3x | 1840.4 | 158.9 |

Full-page redraw is not an acceptable per-pointer-event strategy on dense pages.
The pen now uses a separate preview canvas and appends the final stroke to the
base canvas once. Highlighters retain full-page multiply rendering for correctness;
eraser and lasso edits also retain full redraws.

Growing single-stroke preview, 1000 to 1022 samples, twenty measured frames:

| Zoom | Median ms | p95 ms |
| --- | --- | --- |
| 1x | 1.9 | 2.6 |
| 3x | 7.0 | 7.4 |

Geometry-only generation averaged 0.34 ms for 1000 points and 1.94 ms for
10000 points (thirty runs). Preview timings exclude browser compositing,
pointer handling, bitmap allocation at pointerdown, and Obsidian overhead.

Zoom immediately transforms the current image, then rerasterizes 100 ms after
the last gesture event. Dense pages can still pause at final rerasterization
(including cold path generation after a layout resize); this is not a promise
of sharp rasterization on every gesture frame.

Each bitmap is capped at approximately 16 million pixels / 64 MB raw RGBA.
Base plus active preview can reach approximately 128 MB, excluding browser/GPU
copies and path storage. Preview allocation is released after pen-up. At high
DPR and zoom the cap deliberately trades some resolution for bounded memory.
For example, an 820 x 1180 page at DPR 2, 3x ideally needs 34.8 million pixels;
the cap renders it at roughly 4.07x logical density instead of 6x.

The browser harness is tests/rendering-benchmark.ts. Bundle it with esbuild
as a browser IIFE and serve in a minimal HTML page. Add ?preview to skip the
slow full-page comparisons. Visual samples cover 50%, 100%, 200%, and 300%.

Further work, if dense-page editing or low-memory tablets need it: viewport
tiling and dirty-region redraw. Those are intentionally outside this patch.
