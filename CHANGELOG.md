# Changelog

## Unreleased

## 0.2.0-beta.3 - 2026-09-10

- Keep iPad ink canvases out of WebKit's transformed-subtree rasterization path and preserve exact high-DPR tile density at every zoom level.
- Reject isolated Apple Pencil pressure glitches during outline generation and keep high-DPR tile bleed in logical pixels so synchronized straight strokes remain solid instead of developing bitten-looking edges or seams.
- Keep rapid strokes on the overlay until input is idle, then copy the previous high-resolution tile and composite only newly added ink instead of replaying all historical strokes on the main thread after every pointer-up.
- Move notebook parsing, normalization, conflict merging, and serialization into an inline Worker while retaining bounded compare-before-write Vault persistence and a safe main-thread fallback.
- Stream active Pencil samples and rasterize visible tiles in the Worker so pointer-up and the next stroke do not wait for full-stroke copies, historical tile replay, or save preparation.
- Keep live pen and highlighter geometry aligned with final tiles, preserve ink immediately after release, and update affected eraser cells before pointer-up.
- Redesign the editor around a canvas-first 56px toolbar, responsive page rail, semantic Obsidian theme tokens, accessible touch targets, and viewport-bounded settings panels.
- Give pen and highlighter independent color, width, opacity, and smoothing settings with live stroke previews; keep stroke eraser size-free while retaining adjustable circle and square erasers.

## 0.2.0-beta.2 - 2026-09-09

- Keep completed Pencil strokes in a high-resolution overlay while affected tiles render incrementally, allowing the next stroke to begin without waiting for a synchronous visible-tile flush.
- Preserve full 2x backing density for iPad-sized writing overlays and visible tiles while keeping selection overlays and background cache memory bounded.
- Delay autosave work until one second of writing inactivity so whole-notebook cloning and JSON processing do not compete with rapid Pencil input.
- Reconcile save and Vault-sync results incrementally so timestamp-only changes do not rebuild the editor, background-page updates do not redraw the current canvas, and current-page ink updates invalidate only affected tiles.

## 0.2.0-beta.1 - 2026-09-09

- Fail closed when a notebook on disk contains damaged JSON, and serialize saves by dirty revision without losing pending edits after an error.
- Upgrade notebooks to schema 2 with deterministic page order and page-deletion tombstones while retaining schema 1 compatibility.
- Lock pointer interactions to their starting page and tool, preserve final samples, and safely flush active input before close or file changes.
- Replace periodic view polling with debounced, per-file Vault events and self-write suppression.
- Add page duplication, deletion, reordering, history support, notebook search selection, and page-targeted Markdown `ink` embeds.
- Add stroke, circular, and square erasers with local spatial queries, adjustable local size, and a high-contrast hover aiming reference.
- Add adjustable handwriting smoothing and lightweight corner-preserving stroke beautification.
- Keep long highlighter strokes visible in a continuous live overlay, then atomically commit them to tiles on pointer-up.
- Move lasso and eraser commits to coherent low-density fallback frames followed by background high-density refinement.
- Replace the multi-row controls with one responsive 56px toolbar using Obsidian semantic theme variables; remove legacy offscreen bars and focus targets.
- Add deterministic unit, integration, and browser regressions for persistence, input, embeds, rendering, themes, and 360–1280px layouts.

## 0.1.0-beta.5 - 2026-09-08

- Ignore delayed capture-loss events from the previous stroke once the pen has been recaptured, so consecutive strokes are not cut short.
- Do not append capture-loss event coordinates as ink points.
- Defer disk reads that finish during handwriting until the pointer finishes, using the same merge queue as saves.
- Preserve the selected page during background merges and discard read results for a file that is no longer open.
- Add regression coverage for rapid consecutive strokes and overlapping background reads and saves. Real-device Apple Pencil verification is still required.
- Anchor pinch and modifier-wheel zoom to the input position, support touch panning, and keep zoom within 50% to 300%.
- Improve ink clarity with cached stroke outlines, viewport tile rendering, and a separate live-pen overlay; refine tiles after viewport motion stops.
- Redesign the notebook editor with document and tool bars, a floating brush palette, a collapsible page rail, and responsive pane layouts.
- Add repository CI for type checking, tests, dependency auditing, and reproducible build checks; update development tooling to address known audit findings.
- Keep the Obsidian 1.5.0 minimum version and existing notebook format. Real iPad input latency, memory pressure, Apple Pencil behavior, and cross-device synchronization remain unverified for this release.

## 0.1.0-beta.2 - 2026-09-07

- Clarify the drawing toolbar with labeled controls, grouped actions, visible color swatches, and live brush values.
- Improve iPad touch targets and selected-tool contrast.

## 0.1.0-beta.3 - 2026-09-07

- Fix zoomed canvas sizing so strokes remain correctly aligned after zoom.
- Recover lost pointer capture to allow immediate consecutive Apple Pencil strokes.
- Stop rebuilding the toolbar after each stroke, tool change, or color change to remove flicker.

## 0.1.0-beta.4 - 2026-09-08

- Preserve Apple Pencil coalesced and final pointer samples so stroke tails are not lost when lifting the pencil.
- Ignore disk refreshes while a pointer is active to prevent an in-progress stroke from being redrawn from stale data.
- Defer asynchronous save merges until the active pointer finishes so the next stroke appears immediately.
- Improve stroke rendering with zoom-aware supersampling, pressure-segment smoothing, and round caps for short strokes.
- Group toolbar actions, clarify selected tools and colors, and increase primary touch targets.
- Replace the inline brush-size slider with a larger, viewport-positioned popover.
- Real iPad drawing performance, visual quality, theme contrast, and split-screen layout remain unverified.

## 0.1.0-beta.1 - 2026-09-07

First public test release of Ink Notes for Obsidian.

### Added

- Cross-platform pen and highlighter input with pressure-aware strokes.
- Page creation, renaming, paper styles, page rail, and zoom controls.
- Undo and redo for drawing, erasing, and lasso movement.
- Polygon lasso selection with constrained on-page movement.
- Vault-backed `.ink` notebooks and cross-device stroke merging.
- Tombstones that prevent deleted strokes from reappearing after sync.

### Compatibility

- Requires Obsidian 1.5.0 or later.
- Supports desktop and mobile platforms through Obsidian WebView APIs.
- Existing `.ink` files without tombstones are upgraded in memory when read.

### Known limitations

- Apple Pencil squeeze and double-tap are not available through standard WebView input events.
- Real multi-device conflict behavior requires broader beta testing.
- Five audit findings remain in development-only Vitest, Vite, and esbuild tooling. Production dependencies report no known vulnerabilities.
