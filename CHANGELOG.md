# Changelog

## Unreleased

## 0.6.0-beta.6 - 2026-10-06

- Replace the pen outline generator (perfect-freehand) with a variable-width stroke ribbon flattened to a single polygon: left offsets forward, end cap, right offsets backward, start cap, filled with nonzero winding. Diagnostics from real handwriting showed the strand-offset outline structurally fails when letters are small relative to the nib: tight loop interiors collapsed to slivers, curves rendered with polygon facets, and hooks folded into dots. The ribbon keeps loop interiors open, renders curves smoothly, and draws hooks fully at every nib-to-letter ratio. The per-point diameter convention (width * (0.55 + pressure * 0.75)) and the corner-preserving centerline smoothing are unchanged, and live ink, retained previews, committed tiles and Markdown embeds share the same geometry, so they remain pixel-identical. The perfect-freehand dependency is removed.

## 0.6.0-beta.5 - 2026-10-06

- Render sampled curves as curves: the pen outline now connects the captured centerline with corner-preserving smoothing instead of raw polylines, so a fast hook sampled a handful of times (a flicked a/d tail, cursive turns) renders as the curve the pen drew rather than a straight-line kink. Corners stay sharp by construction: a vertex only participates while both adjacent segments are short relative to the nib width, so deliberate corners drawn with long strokes (Chinese character turns, angular letters) keep their vertex exactly, endpoints never move, and every displacement stays a small fraction of the nib width. Render-only: stored points remain the raw samples.
- Cap the Smooth dial's spring softening at 1.4x the reference mass (previously 2x at strength 100). A softer spring lags the pen further, and enough lag cuts tight end-of-stroke hooks out of the modeled trajectory — the "algorithm straightens my hook" report at high strengths. The wobble window still widens with the dial, keeping the calmer feel; strength 50 remains the exact upstream reference tuning.

## 0.6.0-beta.4 - 2026-10-06

- Fix the tail dot reported from iPad: iPadOS re-reports a fresh, frequently higher pressure on the pointerup sample at the frozen tail position (device diagnostics measured the fading tail at 0.01-0.33 while the lift jumps back to 0.36-0.76). Contact force can only fall while the pen leaves the surface, so the lift pressure is now clamped to the previous sample's pressure in both capture paths (modeled and direct). A skidding lift still lands where the pen lifted; it just no longer fattens the tail into a round dot.
- Diagnostics (from the developer panel JSON this fix was derived from): input ~125 Hz, sparse detection not flagged, coalesced API present but empty on iPadOS, pointerrawupdate absent. The earlier "Direct engages the modeler" report matches the Smooth dial being at 100 during capture; the sparse branch was correctly idle.

## 0.6.0-beta.3 - 2026-10-06

- Add a developer diagnostics overlay for tracking down device-specific capture issues: a new toolbar button (activity icon) or the "Toggle Ink developer diagnostics" command opens a live panel showing the build version, pointer/environment capabilities (coalesced events, pointerrawupdate, predicted events, touch points, DPR, zoom), measured input rate (min/median/mean/max sample intervals), the sparse-device detection state with its threshold, the current Smooth mode, and a per-stroke record of the last eight pen strokes: whether the modeler engaged and why (smooth strength / sparse auto / direct), delivered samples vs stored points, fallback state, and how far the stored tail lands from the true lift position.
- The panel's Export JSON / Copy JSON buttons produce a full diagnostics report, including the raw delivered sample points ([x, y, pressure, t]) of recent strokes (recorded only while the panel is open, capped per stroke) so device-specific ink issues can be reproduced offline.
- Read-only by design: no capture, storage, or rendering behavior changes while the panel is closed; with it open, samples are additionally retained for the last strokes only.

## 0.6.0-beta.2 - 2026-10-06

- Fix the dot that appeared past a stroke's tail on every pen lift when the stroke modeler was engaged: the modeler's end-of-stroke catch-up cluster (converging, sometimes overshoot-reversing sub-pixel steps) reached the outline renderer whole, whose outline-point gate then misconnected the end-cap arc into a visible bulb. Modeled points are now deduplicated against a real radius (0.35 page px, previously an ineffective 0.01) with the final lift point under the same rule, so the catch-up cluster never reaches storage while the tail still lands within a fraction of a nib width of the lift position.
- Fix the Smooth dial appearing to have no effect: the sparse-device detection fed human pauses (between strokes, letters or hover bursts, 150-500 ms) into the sample-interval history, so normal writing rhythm tripped the sparse threshold and silently re-engaged the modeler even with the dial at 0. Intervals above 120 ms are now treated as pauses and excluded.
- No notebook schema change; strokes stored by earlier versions render unchanged except for the removed tail dot.

## 0.6.0-beta.1 - 2026-10-06

- Make direct capture the pen default: ink stores and renders every delivered sample exactly as the digitizer reported it, in the style of the apple-pencil-capability-probe writing pad. The 0.5.0 stroke modeler no longer runs unless asked.
- Add a Smooth slider (0-100) to the pen brush settings. 0 is direct ink; 1-100 selects the stroke modeler strength, with 50 reproducing the upstream reference tuning, lower values snappier and higher values calmer. Stroke ends still land on the lift point at every strength.
- Auto-rescue sparse devices: when recent samples show a median interval above ~24 ms (below ~40 Hz), the next pen stroke engages the modeler automatically even with the dial at 0, because raw polylines from low-rate devices look segmented. The first stroke after opening a notebook is always direct (no history yet).
- Capture pen samples through pointerrawupdate where the host exposes it (Obsidian desktop / Chromium): each hardware sample reaches the ink pipeline immediately instead of waiting for the frame-aligned pointermove batch, with timestamp dedup so coalesced replays never double-feed. iPad WebKit does not expose the event and is unaffected.
- No notebook schema change; existing notebooks render exactly as before. Real-device (iPad/Pencil, Windows pen) writing feel is not verified for these changes.

## 0.5.0-beta.1 - 2026-10-06

- Model pen strokes at capture time with a TypeScript port of the causal core of Google's open-source ink-stroke-modeler: digitizer wobble smoothing, 180 Hz resampling, spring-drag position modeling and an end-of-stroke catch-up that lands stroke tails exactly on the lift position. Stored points are only ever appended and never rewritten, preserving the raw-capture guarantee that finished ink always matches its committed tiles.
- Keep fast sparse corners faithful: the wobble filter applies only to near-stationary input, so moving strokes keep their captured trajectory, and the renderer still draws faithful polygons. Pressure and tilt flow through the modeler's projection onto the raw input polyline; lift pressure keeps the writing pressure.
- Pen strokes only: highlighter, eraser and lasso capture exactly as before, and the stored notebook schema is unchanged, so existing notebooks render as they always did. If a stroke's input stream breaks (clock jump or an extreme gap), that stroke falls back to raw capture instead of losing ink.
- Known trade-off: while a stroke is in progress the modeled tip trails the pointer slightly (the modeler's spring lag, the same behavior as upstream without prediction); stroke ends always converge on lift. Real-device (iPad/Pencil) writing feel is not verified for this change, and the upstream tuning constants may need device-specific adjustment later.

## 0.4.0-beta.1 - 2026-10-06

- Store and render strokes exactly as the pen reported them. The finalize-time stroke optimizer (sub-nib sample dedupe, corner detection, corner-preserving relaxation) and the capture-time point stabilization are removed, ending the regression chain that traded cut corners, missing stroke halves, thin tails and preview settle across 0.3.0-beta.1–.3.
- Remove the per-brush smoothing dial: every captured sample is kept verbatim, and only exact duplicate positions from repeated input events are skipped. Handwriting captured on one device now matches the committed tiles, retained previews and saved file byte-for-byte on every device, with no republish step after the pen lifts.
- Real-device (iPad/Pencil) writing feel is not verified for this raw-capture change; the smoothing dial no longer exists, so jitter filtering cannot be re-enabled from settings.

## 0.3.0-beta.3 - 2026-10-05

- Repair the reported stroke-tail artifact: lift events inherit the previous sample's pressure instead of jumping to a fixed value, and a pen-up sample inside the minimum spacing replaces the previous point instead of appending a degenerate segment, so strokes no longer end in a suddenly-thinning line with a detached dot.
- Keep fast-written acute corners and sparse curves faithful: the finalize optimizer refuses to relax points that deviate from their neighbor chord more than a jitter limit, so deliberate folds are no longer rounded into curves and quick strokes are no longer visibly shrunk.
- Render pen outlines as a faithful polygon in live ink, retained previews and committed tiles. The midpoint-quadratic outline fitting used since beta.2 cut corners on sparsely sampled fast strokes, bending acute turns into large arcs and visually swallowing the bend region of a stroke (reported as half of a stroke going missing).
- Slow handwriting now tracks the pen: capture smoothing renders 3px steps at 90% of the pen movement (previously 66%) and keeps 5px+ steps exact, removing the intermittent lagging-nib feel while the finalize optimizer still removes residual jitter with corner protection.
- Add browser pixel regressions: full-path coverage across live preview, retained overlay and committed tiles for a long fast stroke with a sharp bend, in Worker and no-Worker modes. The existing fast-corner pixel tests now pass again. Physical iPad/Pencil verification remains outstanding.

## 0.3.0-beta.2 - 2026-10-04

- Tune the whole ink pipeline for handwriting: optimizer sample spacing now follows the nib diameter (35% of it, floored), and the corner-detection arc window scales with each stroke's own extent, so hooks stay protected from margin-note to page-filling sizes and hairline nibs keep their detail.
- Render the retained finished-stroke preview from the refined geometry, so every completed stroke matches the committed tiles immediately and never visibly settles or jumps at tile commit.
- Align main-thread pen outlines (Markdown embeds, Worker-less fallback) with the Worker's closed midpoint-quadratic tile rendering.
- Brush smoothing 0 keeps captured geometry and previews byte-exact and skips the refined preview path. Add nib-scale, writing-size, retained-preview and render-parity regressions. Physical iPad/Pencil writing feel and latency remain unverified.

## 0.3.0-beta.1 - 2026-10-04

- Add a finalize-time stroke geometry optimizer: sub-threshold sample deduplication, corner detection over an arc-length window, and corner-preserving relaxation between pen-down and pen-up samples once the whole stroke is known.
- Preserve hook endings and sharp corner turns: detected corners and both stroke endpoints keep their captured position and pressure, so smoothing can no longer round deliberate structure away.
- Trim saved notebook size on dense high-frequency input by collapsing samples closer than half the smallest nib width.
- Optimization strength follows each brush's existing smoothing setting; 0 keeps the captured trajectory byte-exact, and already-straight sample runs stay byte-exact at any setting.
- Add optimizer unit regressions and finalize integration regressions. Physical iPad/Pencil handwriting feel and latency remain unverified; existing saved strokes keep their stored geometry until redrawn.

## 0.2.0-beta.8 - 2026-10-04

- Keep every unconfirmed live stroke sample visible when fast handwriting outruns the Worker or Worker support is unavailable, instead of clearing earlier ink and retaining only the final 32 samples.
- Reduce default pen smoothing from 0.7 to 0.25 and preserve small position changes and input pressure when smoothing is set to 0.
- Remove the extra fixed position filter and quadratic fitting over pen outlines so sparsely sampled fast corners stay near their recorded positions; retain pressure sizing, pressure-spike rejection and rounded pen caps.
- Keep live, Worker and committed pen geometry consistent without rewriting saved stroke data. Existing pen strokes and Markdown embeds may look less smoothed; very long unconfirmed strokes require additional fallback rendering work.
- Add fast-corner, smoothing-off and delayed/unavailable Worker regressions with actual browser ink-pixel checks. Physical iPad/Pencil handwriting feel and latency remain unverified.

## 0.2.0-beta.7 - 2026-10-04

- Receive explicitly identified Pencil Touch events through the existing stroke pipeline when Scribble interferes with rapid Pointer input, without requiring system Scribble to be disabled or changing native text input elsewhere.
- Adopt Pointer-first contacts without duplicating ink, ignore duplicate Pointer completion and delayed downs after Touch ownership is observed, and preserve pressure, orientation, tools, and undo/redo.
- Cancel native drawing-area Touch defaults before early returns, keep fingers out of stylus drawing, and resume an already resting finger's pan after Pencil release.
- Add Touch-only/mixed-event per-stroke geometry and immediate-pixel regressions. Physical iPad verification with Scribble enabled remains required; Touch sample cadence may differ from coalesced Pointer samples.

## 0.2.0-beta.6 - 2026-10-04

- Accept consecutive Pencil strokes when explicit pointer capture is temporarily unavailable, preserve new strokes through delayed capture-loss events for reused pointer ids, and release DOM capture before completed-preview work.
- Finish uncaptured input released outside the paper in its owning document, keep completion listeners aligned with Obsidian window migration, and clean up listeners on unload.
- Tolerate only expected pointer-capture DOMExceptions across windows while propagating other errors. Add input, document-event, migration, and exception regressions; physical iPad Apple Pencil verification remains required.

## 0.2.0-beta.5 - 2026-10-04

- Keep wide centered pages anchored under the two-finger midpoint and synchronize tile display scale immediately so live and committed Pencil ink stays in the same position while zooming.
- Keep completed strokes visible across late Worker responses, viewport changes, and asynchronous tile commits without copying the full high-density overlay on pointer-up.
- Bound temporary completed-stroke geometry and acquire Pencil capture before publishing a reused pointer interaction so the next stroke starts immediately instead of disappearing or being ignored.

## 0.2.0-beta.4 - 2026-09-10

- Replace WebKit CSS zoom and transformed page rendering with explicit scaled layout dimensions so Apple Pencil input remains aligned with the page and right-side ink stays visible while zoomed.
- Keep tile, overlay, lasso, eraser cursor, and paper geometry on one display scale without changing persistent notebook coordinates or raster-density limits.
- Stop rebuilding the page when switching tools, preventing visible full-editor resets and unnecessary tile work.
- Seal the final live stroke frame immediately on pointer-up so the next Pencil contact does not wait for Worker refinement, tile commits, serialization, or Vault writes.

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
