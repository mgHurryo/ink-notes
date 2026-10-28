# Changelog

## 0.1.5-beta.19 - 2026-10-28

- Clear the interaction state when the stroked page vanishes (#294): lifting the pen after the page holding the active stroke is removed no longer leaves a ghost stroke behind, because the pending stroke and its interaction state are reset together with the page. Keep momentum suppression across a soft axis switch on the wheel gesture tail (#295): the tail of a trackpad sweep that drifts past the axis-retention ratio, or re-targets via Shift mid-flight, no longer re-arms into a second page flip, while discrete-notch streams and not-yet-flipped gestures keep their hard reset. Backfill the missing beta.16-18 changelog and versions.json entries (#296) and pin the convention with a release-metadata consistency test; no app behavior change.

## 0.1.5-beta.18 - 2026-10-28

- Refresh the activity timestamp during pointer lasso drags (#283): a lasso drag longer than the 2.5s silence window no longer gets healed mid-drag, so a landing finger cannot commit the partial selection as an undoable command and start a pan. Let a stylus touch take over before the page-flip rebound (#284): a Pencil landing mid-flip now owns input first and is no longer swallowed by the flipSettling latch, so the user can write immediately without re-landing the pen. Cap discrete notch pages by the per-gesture budget (#285): fast quantized touchpad streams and a held mouse wheel now flip at most two pages per gesture instead of racing through a dozen. Fix visual regression (#286): the visual specs assert the new budgeted paging contract and the responsive rail assertion polls past the 200ms expansion transition, no app behavior change.

## 0.1.5-beta.17 - 2026-10-28

- Rebound a page drag when a Pencil lands mid-flip (#278): a stylus touch during a finger page-flip drag now settles the flip instead of leaving the page stranded at an offset. Rearm constant-magnitude flicks in the blocked window (#279): a third fast flick with constant velocity pages again instead of being swallowed by the renewal-blocked branch. Pin vertical notch timestamps against sync dispatch collisions (#280): the visual fixture no longer flakes when quantized event timestamps collide and collapse the damping gap.

## 0.1.5-beta.16 - 2026-10-28

- Settle an ink commit stranded by a mid-flight generation bump (#273): a stale render result no longer leaves the commit loop permanently stalled with held cells never released. Compensate refines dropped by an aborted ink commit (#274): pen-down during an in-flight interactive commit no longer loses the full-density refine work, so ghost strokes do not linger. Rearm vertical flicks landing in the inertia tail (#275): mid-tail re-scans on the vertical axis flip pages again, matching the horizontal axis.

## 0.1.5-beta.15 - 2026-10-25

- Render page-flip previews at the same density as live tiles (16M-pixel budget instead of the 4M overlay budget), so Retina iPads no longer show a blurry incoming page for the whole flip that only sharpens once the real tiles replace it. Recognize a renewed horizontal trackpad gesture when a wheel sample jumps clear of the decaying inertia envelope in a single step (>= max(24px, 2.2x the decayed level), with the previous sample held low inside the post-renewal block window) instead of requiring two compound 1.2x growth spikes that real precision-trackpad fast phases never produce; flicks landing inside the previous 1-2s Windows inertia tail now page immediately, while momentum peaks, the two-page gesture cap and the 55ms quiet-gap rearm remain. Expose pinchRenderZoom, tileDensity and tileDisplayScale in the dev panel and diagnostics JSON to pin down the intermittent fully-zoomed blur on Retina iPads (not yet root-caused). Patch dev-only vite and moment to clear the npm-audit high gate. Typecheck, 886 unit tests, WebKit swipe regression (2 tests including a new iPad-sized viewport), Chromium desktop-input (18) and full visual suite (174) pass; physical iPad and precision-trackpad behavior remains unverified.

## 0.1.5-beta.14 - 2026-10-15

- Treat a 55 ms quiet interval as a renewed horizontal trackpad swipe even when the next swipe starts with a smaller delta. Repeated same-direction swipes can resume paging while the two-page gesture cap, inertia suppression and mouse-wheel behavior remain. Typecheck, 880 unit tests, focused Chromium desktop-input tests, build and PR CI pass; dependency audit passes the high-severity gate with two existing moderate Moment advisories. Physical trackpad behavior remains unverified.

## 0.1.5-beta.13 - 2026-10-15

- Re-arm renewed horizontal trackpad flicks after a 55 ms quiet interval even when the device omits near-zero inertia tail events. Preserve the fast near-zero-tail path, momentum peak suppression, per-gesture two-page limit, mouse-wheel behavior and mouse-drag queue handling. Typecheck, 878 unit tests, build, PR CI and focused Chromium trackpad checks pass; the desktop-input suite retains one known PDF tile-mount fixture failure, and physical touchpad behavior remains unverified.

## 0.1.5-beta.12 - 2026-10-15

- Recognize short-gap renewed trackpad flicks as separate gestures so each receives a fresh two-page allowance, while requiring the prior inertia to settle near zero before rearming to avoid replaying momentum peaks. When a mouse drag takes over during a page handoff, discard wheel destinations that have not started and keep the active transition plus the drag's own page. Typecheck, 876 unit tests, focused Chromium regressions, build and PR CI pass; physical trackpad validation remains unverified.

## 0.1.5-beta.11 - 2026-10-15

- Reset the per-gesture two-page limit for each renewed trackpad swipe, so repeated independent swipes keep paging instead of becoming permanently blocked. Preserve the two-page cap within one gesture and existing mouse-wheel behavior. Typecheck, 874 unit tests, focused Chromium regression, build, dependency audit and PR CI pass; physical trackpad validation remains unverified.

## 0.1.5-beta.10 - 2026-10-15

- Prevent one continuous trackpad gesture from queuing repeated page turns during slow handoffs, while keeping separate swipes and discrete mouse-wheel notches. Reuse prewarmed adjacent-page previews and defer their painting until page-turn animations settle. Typecheck, 872 unit tests, build and PR CI pass; the desktop-input suite has one unrelated PDF tile-mount fixture failure, and physical trackpad frame pacing remains unverified.

## 0.1.5-beta.9 - 2026-10-15

- Rework continuous horizontal trackpad paging: shorter intentional swipes now reach the page threshold, a same-direction swipe can rearm while the previous inertia is still active, and the rest of one swipe cannot trigger a duplicate page. Preserve vertical mouse-wheel scrolling and notch behavior. Automated tests and Chromium wheel/trackpad simulations pass; physical trackpad validation remains unverified.

## 0.1.5-beta.8 - 2026-10-15

- Restore repeat two-finger horizontal trackpad page turns when a new same-direction flick ramps up from small deltas after the prior gesture's inertia. Preserve inertia suppression, scrolling and edge paging; automated typecheck, 860 unit tests, build, dependency audit and PR CI pass. Physical trackpad behavior remains unverified.

## 0.1.5-beta.7 - 2026-10-15

- Unify desktop mouse-wheel and touchpad routing: normalize pixel, line and page deltas, preserve native scrolling within page content, and keep touchpad inertia within one edge-page gesture. Ink and PDF share the same routing and queued page transitions. Typecheck, build, 858 unit tests, PR CI and focused Chromium checks pass; one existing PDF tile fixture remains failing, and physical wheel hardware is unverified.

## 0.1.5-beta.6 - 2026-10-15

- Route horizontal trackpad gestures to page navigation at fit zoom instead of consuming them as canvas scrolling. At increased zoom, preserve horizontal panning and turn the page at the horizontal edge. Typecheck, build, 856 unit tests, PR CI and focused Chromium regressions pass; the full desktop-input suite retains one unrelated PDF tile-fixture failure, and physical wheel hardware remains unverified.

## 0.1.5-beta.5 - 2026-10-15

- Preserve horizontal trackpad page gestures when their target is inside vertically scrollable content, and keep noisy touchpad deltas on the active scroll axis. Queued multi-page transitions still animate each page but complete in 64ms per queued step, reducing the delay after a gesture. Typecheck, build, 856 unit tests, PR CI, and focused Chromium regressions pass; the full desktop-input suite retains one unrelated PDF tile-fixture failure, and physical wheel hardware remains unverified.

## 0.1.5-beta.4 - 2026-10-15

- Let a renewed horizontal trackpad flick rearm after a short pause, and animate queued wheel destinations one page at a time instead of jumping directly to the last page. Typecheck, build, high-severity dependency audit, 854 unit tests, focused Chromium wheel regressions and PR CI pass; the full desktop-input suite retains one unrelated PDF preview tile-fixture failure, and physical wheel hardware remains unverified.

## 0.1.5-beta.3 - 2026-10-15

- Reduce wheel-to-page sensitivity: one large pixel-mode event advances at most one page, same-direction trackpad inertia must pause before another page, and rapidly repeated mouse-wheel notches receive a small cumulative dampening. Typecheck, unit tests, high-severity dependency audit, build, and focused Chromium wheel regressions pass; the full desktop-input suite retains one unrelated PDF preview tile-fixture failure, and physical wheel hardware remains unverified.

## 0.1.5-beta.2 - 2026-10-15

- Render only visible tiles that contain handwriting, avoiding worker and raster work for transparent cells. Chromium now finishes loading visible ink without requiring a pointer hover; no note migration or format change. Automated tests and Chromium regression pass; real Obsidian/mobile device latency remains unverified.

## 0.1.5-beta.1 - 2026-10-14

- Cut per-frame rebuild work shared by the desktop (Chromium) and mobile (WebKit) writing paths: settled render frames no longer rebuild the tile queue and rescan the whole tile cache, confirmed stroke outlines reuse one cached path object per frame, and the page-rail thumbnail refresh for the current page coalesces onto a single animation frame.
- Reduce input-path overhead on hardware-pen streams: the line-hold straightening timer arms once per stroke instead of re-arming on every raw pen sample (up to ~266 Hz), eraser hit-testing reuses one dedup map per sample, unchanged strokes skip the style-key rebuild during tile sync, and neighboring-page prewarm jobs no longer queue duplicates.
- Defer offscreen page-rail thumbnails until they scroll into view; visible thumbnails and all explicit repaints keep their previous synchronous behavior.
- No note migration or format change. Automated typecheck, unit tests, build, and visual browser regressions pass; the frame-time gains are code-path verified and await device measurement.

## 0.1.4 - 2026-10-13

- Replace operating-system detection through `navigator.userAgent` with Obsidian's `Platform` API while preserving handwriting-first defaults for iPad split windows.
- Open linked sticky notes with the workspace API supported by the declared Obsidian minimum (1.5.7), instead of `revealLeaf`, which requires Obsidian 1.7.2.
- Apply sticky-note layout and PDF snapshot styles through Obsidian's `setCssStyles` and `setCssProps` APIs. Preserve Markdown export styling and verify it in Ink and PDF browser tests.
- No note migration or format change. Automated typecheck, unit tests, build, audit, and sticky browser regressions pass; the Community review scanner itself was not rerun in this environment.

## 0.1.3 - 2026-10-13

- Promote the 0.1.3 beta series to stable. Create and manage Ink notebooks, write on PDF pages, add blank pages, reorder or hide handwritten pages, and edit the same PDF from split panes with conflict-aware sidecar saves. Source PDFs remain unchanged.
- Add pressure-aware handwriting, highlighter and eraser tools, adjustable scribble erasing, freehand/rectangle lasso with clipboard actions, shapes, movable text boxes, inline Markdown sticky notes, and a grouped image library with batch import and management.
- Add per-tab Reading and Editing modes, device-aware initial modes, desktop keyboard/mouse/wheel/trackpad navigation, and PDF viewer preferences for Ink-first, native, and plugin-compatible workflows.
- Compress saved handwriting losslessly when it reduces file size. Existing JSON notes remain readable, but older plugin versions cannot open notes after they have been saved in the compressed format. Update every device that edits a vault before sharing compressed notes, and keep a backup before downgrading.
- Require Obsidian 1.5.7 or later. Automated typecheck, unit, browser, audit and build checks pass; physical iPad and desktop hardware validation remains device-dependent.

## 0.1.3-beta.14 - 2026-10-13

- Count each discrete mouse-wheel notch as one page request and preserve queued notches through page transitions; renewed trackpad motion can start another flick without waiting for the idle timeout.
- Preserve native scrolling within page bounds and the existing horizontal trackpad paging behavior. Automated unit and desktop browser tests pass; physical Obsidian desktop hardware remains unverified.

## 0.1.3-beta.13 - 2026-10-13

- Keep mounted handwriting tiles and queued render jobs during desktop scrolling within the same visible tile range; skip empty overlay redraws during ordinary viewport motion.
- Share in-flight PDF neighbour rasters between swipe previews and destination pages, and invalidate pending work when a document or view is reset.
- Add regressions for stable tile DOM and shared page renders. Automated typecheck, build, unit tests and desktop browser tests pass; physical Obsidian desktop performance remains unmeasured.

## 0.1.3-beta.12 - 2026-10-13

- Compress saved handwriting losslessly when it reduces file size, while continuing to read existing JSON notebooks and PDF sidecars.
- Avoid duplicate visible-ink tile updates during PDF page navigation, promote matching neighbour rasters into the active page, and bound/release offscreen preview canvases.
- Verified in automated unit and desktop browser tests; real Obsidian/iPad memory pressure and crash behavior remain unverified.

## 0.1.3-beta.9 - 2026-10-12

- Prevent Obsidian safe-area padding from reducing the PDF canvas during sticky keyboard editing. Keep automatic scrolling inside the plugin canvas rather than scrolling outer panes or the WebView.
- Preserve folded sticky anchors through repeated expansion, folding, reloads and worker saves. Expanded notes fit inward without rewriting their folded position; ink routing and PDF export use the same display origin.
- Replace folded sticky headers with a single preview icon. Tap to open, double-tap to type, drag with a finger or mouse, and long-press/right-click for actions and index links. Folded previews remain plain-text/ink overviews.
- Add host safe-area, keyboard editing, icon interaction, edge-anchor and geometry regressions. Verified 660 unit tests, 46 Chromium checks and 18 WebKit checks. Physical iPad keyboard and full Obsidian/plugin validation remain pending; browser PDF tests use blank sidecar fixtures.

## 0.1.3-beta.8 - 2026-10-12

- Keep the current PDF fit while editing sticky titles, Markdown or keywords through keyboard-driven viewport height changes. Reveal the focused editor after pane resizing, preserve drafts and zoom lock, and use a 16px title input to avoid iOS small-input zoom.
- Move folded labels within their actual visible bounds and preserve edge positions through saving and reloading. Unfold inward at the right/bottom page boundaries, including temporary reading-mode expansion, without changing saved frame size or content.
- Give the sticky header more vertical space and control padding, using the same fixed inset in DOM, ink routing and PDF export. Existing content displays 20 board units lower within the same frame; stored text, handwriting coordinates and sizes are unchanged, and cropped content remains stored.
- Add keyboard-cropped viewport, locked/unlocked zoom, four-corner folding, edge-position persistence and fitted-header regressions. Physical iPad keyboard and full Obsidian/plugin validation remain pending; browser PDF tests use blank sidecar fixtures.

## 0.1.3-beta.7 - 2026-10-12

- Keep each sticky note in a separate stacking context so overlapping titles, paper, Markdown and ink paint as complete cards. Use a transparent DOM ink canvas so it no longer hides typed content; PDF snapshots retain opaque paper.
- Stabilize stacking by creation order across editing, worker updates, reloads and split-pane merges. Stagger new notes and give new notes wider frames on narrow pages.
- Unify expanded and folded note movement through the entire title, enlarge and normalize icon controls, and move secondary actions into the native options menu for narrow frames. Support double-tap typing on blank boards, title long-press menus, repeated-button menu dismissal and touch movement thresholds; finger-as-pen retains writing behavior. Prevent native text dragging from cancelling lasso gestures.
- Preserve stored handwriting coordinates, fixed text layout, inline editing, reading-mode folding, shared writing tools, links and export. Physical iPad validation remains pending; the previously reported hardware-only handwriting drift is not confirmed fixed.

## 0.1.3-beta.6 - 2026-10-12

- Restore native touch activation of sticky-note fold, expand, Markdown editing and option controls by isolating the full control contact from page gestures. Route sticky move/resize contacts before page navigation and avoid duplicate Touch/Pointer ownership. Preserve current text drafts when starting a drag, and refresh committed text after outside gestures or cancellation.
- Add Chromium touch and WebKit regressions for sticky controls and handwriting alignment in Ink/PDF surfaces. Physical iPad handwriting drift remains unresolved; browser checks do not reproduce it.

## 0.1.3-beta.5 - 2026-10-12

- Redesign sticky notes as inline page boards, replacing the separate editor and numeric placement fields. Shared pen/highlighter/eraser/lasso tools work across sticky/document boundaries with atomic undo/redo.
- Add direct Markdown/title editing, fixed text layout through frame resizing, finger/mouse grip and resize gestures, Pointer board panning, compact folded labels, reliable fold controls and long-press/right-click index links.
- Support Markdown paragraph ids in sticky links, retain existing data/search/split-pane merging, and render Markdown text in bounded PDF snapshots. Hardware iPad/WebKit validation remains pending; previews retain plain-text overviews.

## 0.1.3-beta.4

- Clear the previous PDF sidecar when a workspace view starts loading another file, so read-only or failed sidecar resolution cannot leave the old document's notes attached to the new PDF.

- Add colored sticky notes to Ink and PDF handwriting pages with position/size controls, foldable previews, handwritten and typed content, and undo/redo. Frame resizing retains the fixed content coordinates; the editor can extend and scroll its board without allocating a board-sized canvas. Explicit Save applies drafts; reading mode prevents changes and stale drafts cannot overwrite another pane's note.
- Add vault-wide sticky-note title/text/keyword search and Markdown links to exact notes. Provide an optional cancellable handwriting-index adapter with a five-second per-note timeout; no recognition service is bundled or invoked by default. Notes appear in previews, Ink embeds and PDF exports, which capture the visible window/fold state. Source PDFs remain unchanged; old versions may discard sticky metadata on save.
- Recognize default-pen scribble erasing from raw Pencil samples, with conservative repeated-area reversal checks to reduce accidental erasure of connected handwriting. Add a persistent enable toggle and 0–100% sensitivity slider in eraser settings (default 25%); lower values require more deliberate scrubbing. Ordinary/blank-area strokes remain ink.

## 0.1.3-beta.3

- Unify pen, finger, mouse and keyboard gestures across Ink and PDF editors. By default, stylus writes while fingers select or move images/handwriting and navigate; opt in to Use finger as pen for single-finger writing, highlighting, erasing and selection, with two-finger navigation. Hold opens clipboard actions, color removal requires an explicit menu choice, and pressure-curve points use an explicit remove action. Cancelled edits roll back before pinch or stylus handoff.

## 0.1.3-beta.2

- Close lasso/rectangle action menus after copy, cut, delete or paste and on outside presses; empty selections no longer show Paste just because the clipboard contains ink. In editing mode, hold one finger still on the page for 600ms to show a paste-only menu with any tool. Movement, early release, a second finger, stylus input, page changes and viewport interruption cancel the hold; paste retains the active tool and existing clipboard scope. Desktop shortcuts and Lasso settings remain available.

- Simplify the image library with compact import/group menus, a scrollable thumbnail grid and a fixed insertion footer. Show batch management only when images are selected. Fix direct finger dragging and corner resizing in Ink and PDF pages by preserving native touch targets and routing active image gestures before page navigation; a second finger cancels the image preview and keeps page pinch zoom available.

## 0.1.3-beta.1

- Add image-library batch deletion with a count/name confirmation and undo of the latest deletion while the library stays open. Existing multi-select group moves now disable with no selection; counts include selections hidden by search/group filters. Deletion removes catalog entries only, retaining managed files for placed images, previews and PDF exports; it does not reclaim disk space.

- Add a dedicated Pointer arrow tool (desktop shortcut A) for image editing. Insertion selects the image immediately; a finger/mouse contact on an image opens its controls, and tapping outside dismisses them. Stylus Pointer and native stylus Touch input cannot select/drag images; handwriting and lasso tools keep their existing behavior. Pointer contacts on blank paper never create ink.

- Add a grouped image library with batch photo/file, vault, path-list, paste and drop imports. Insert reusable managed image copies into Ink and PDF handwriting pages; move, resize, change their layer above/below handwriting and delete individual placements with undo/redo. Images default below handwriting and appear in previews, Markdown embeds and PDF exports. Existing note files remain readable without migration; sync managed image assets with notes and back up before downgrading to an older plugin.

- Add Freehand and Rectangle selection modes in lasso settings for both Ink and PDF handwriting. Freehand remains the default; rectangle drags work in every direction, select crossing strokes, and retain the existing move/copy/cut/delete/paste actions. The mode persists across sessions; older settings default to Freehand.
- Add floating lasso Copy / Cut / Delete / Paste actions for Ink notebooks and PDF handwriting. Actions stay inside the editor pane, wrap on narrow screens, and support undo/redo and desktop shortcuts. Selection and placement targets clear on page/file changes.
- Add an opt-in Copy and paste across files setting in the lasso panel. A plugin-scoped in-memory clipboard preserves handwriting proportions, pressure and brush settings across Ink/PDF pages; copied contents clear on reload and never use the system clipboard or modify the original PDF.
- Add multi-select page management to both page rails. Bulk deletion is undoable; PDF deletions hide source-page note records only in the sidecar and never modify the source PDF. The final visible page is protected.
- The default pen can now erase handwriting with a deliberate fast scribble over existing ink. It removes complete strokes crossed by the gesture and the gesture itself, with one undo restoring the erased writing; ordinary pen marks and scribbles over blank areas remain ink.
- Allow both editing panes of the same PDF to write, erase and add note pages. Concurrent sidecar saves merge strokes, deletion markers and page changes instead of overwriting another pane's notes.
- Preserve deferred peer handwriting when the source PDF changes while a split pane is still applying it. Stale panes become read-only and no longer save old coordinates; local and peer notes are retained together in a conflict copy for recovery. External sidecar refreshes are ignored after the source revision is blocked, and normal saves avoid an unnecessary full merge when no peer state is pending. Merging external edits still resets that pane's undo/redo history to prevent stale snapshots from overwriting peer work. iPad, Obsidian and PDF++ runtime combinations remain unverified.
- Recover a conflict copy before unloading a PDF when its latest handwriting cannot be saved, including source-revision blocks. PDF teardown now runs even when both the normal save and recovery copy fail, so a replaced tab cannot retain stale sidecar or worker state.

## 0.1.2 - 2026-10-10

- Fix ordinary PDF opens bypassing Ink Notes first when the host supplies focus flags, empty fragments or native viewport memory. Track the original public openFile request so passive state added during dispatch does not override an explicit handwriting preference.
- Keep handwriting tabs when the host delivers focus or empty-fragment state after opening or refocusing. The view receiver shares the opening route's navigation check instead of immediately returning these tabs to the native viewer.
- Preserve explicit page/search/selection links, unknown navigation requests, compatible/native modes and tabs explicitly returned to the native viewer. Opening context is cleared on completion or failure and both wrappers are removed on unload.
- Replace the withdrawn initial 0.1.2 package with the complete focus-handoff fix. Users who installed the withdrawn package must reinstall this release manually: the version number remains 0.1.2, so automatic update checks may not detect the replacement.
- No notebook/sidecar migration or rendering changes; minimum Obsidian remains 1.5.7. Physical iPad reproduction remains unverified.

## 0.1.1 - 2026-10-10

- Fix Community directory review blockers: remove redundant host branding from the manifest description, use official settings headings and supported style APIs/CSS, and require Obsidian 1.5.7 for view-scoped keyboard shortcuts.
- Add an explicit PDF open mode. Preferring Ink handwriting now takes over ordinary PDF opens even with PDF++ enabled; compatible mode preserves native enhancement workflows. Existing checked automatic-takeover preferences migrate to prefer Ink.
- Preserve page/search/selection navigation in the native viewer and retain manual handwriting/native-view entry points. Notebook and PDF sidecar formats are unchanged.

## 0.1.0 - 2026-10-10

- Publish the first formal 0.1 release of Ink Notes with native notebooks, PDF handwriting, page previews, blank-page insertion, reading/editing modes, zoom lock and PDF export. Correct the briefly published 1.0.0 numbering to 0.1.0; users who installed 1.0.0 must manually reinstall because automatic version comparison treats 0.1.0 as older. Existing notebook/sidecar formats and minimum Obsidian 1.5.0 remain compatible.
- Desktop mouse navigation now continues from panning into gallery page switching at actual scroll edges. Independent trackpad bursts retain their destinations while a previous page waits on saving or rendering; canceled drags rebound.
- Desktop zoom keeps existing ink rasters during motion and refines after a short pause. Late Worker tiles at an old density no longer replace a better raster for the current magnification.
- Native PDF enhancement plugins retain their own viewer workflows through evidence-based default takeover suppression, transparent page/subpath navigation and an explicit handwriting entry. PDF++ and Ink handwriting use separate views; same-view overlay integration is not included.
- Preserve active and concurrent ink during PDF view handoff, save and close. Detect external source-PDF changes and block exporting old coordinates against changed PDF bytes.
- Compatibility inventory covers 283 candidates from pinned public source snapshots. Verification includes 491 unit/host tests and 62 Chromium browser tests; real Obsidian combinations, physical touchpads, iPad WebKit and hardware frame-rate measurements remain unverified.

## 0.8.0-beta.36 - 2026-10-10

- Notebook and PDF views offer an explicit reading/editing toggle. Reading hides editing controls, blocks handwriting/history/page changes, and keeps previews, export, navigation and zoom. Switching completes active ink; editing remains the default and restores the selected tool.
- Desktop controls share middle-button or Space+left dragging, wheel/trackpad scrolling and cursor zoom, horizontal edge navigation, and editor-scoped keyboard shortcuts. Reading also supports ordinary left-button panning.
- Pinch zoom shows a compact animated readout with a zoom lock. Locked views keep the magnification across pages while allowing panning; unlocked navigation continues to reset the incoming page to 100%.
- The Add page menu inserts blank pages before/after the current page or at the document boundaries. Deliberate outward swipes beyond the first/last page threshold also create a blank page in editing mode.
- The notebook picker always offers creation, with search and rename actions. Toolbar navigation/history stay left, writing tools remain centered, and document actions stay right.
- Storage formats and minimum Obsidian version remain compatible. Physical devices, actual Obsidian/popout lifecycle and WebKit remain unverified; reading mode is per-view and retains PDF writer ownership.

## 0.8.0-beta.35 - 2026-10-10

- PDF page previews now invalidate shifted rasters and blank-page neighbours, so inserting a blank page immediately shows a blank preview instead of reusing the following PDF page.
- Notebook and PDF page swipes continue across rapid consecutive gestures with synchronized transitions, bounded destinations, and clean cancellation at page boundaries.
- PDF pages render at display pixel density, keeping 100% text crisp across device densities, pane sizes, zoom, rotation, and neighbour prewarms.
- Repeated Page options activation now closes the existing menu; PDF export has its own Download action without a duplicate menu item.
- Stylus contacts after switching to the eraser are accepted immediately, and page zoom resets to 100% when navigating to another page.
- Pen export reuses the visible pressure-sensitive outline, while pinch rendering keeps notebook paper and ink in one stable coordinate space during and after two-finger zoom.

## 0.8.0-beta.34 - 2026-10-10

- Page swipes now move both pages together on a viewport-sized track, keeping the gap fixed throughout the slide. PDF neighbours retain their own aspect ratio instead of stretching into the current page dimensions.
- Flips continue from the release position, short drags and unavailable neighbours rebound, and stale or opposite-direction velocity no longer triggers a fling. PDF previews include handwriting, and notebook previews retain scaled paper patterns.
- Navigation resets the real page transform and keeps the incoming snapshot until the save/Worker barrier and page rendering finish, replacing the notebook fixed handoff timer. Duplicate settles, interrupted gestures, and obsolete animations cannot commit another flip.
- Added regression tests for frame spacing and proportions, forward/backward landing, boundaries, cancellation, and delayed Worker handoff. iPad/WebKit feel and dense-document swipe performance remain unverified.

## 0.8.0-beta.33 - 2026-10-10

- Preset color edits apply LIVE while you adjust: the platform picker fires an input event per adjustment, and edits now key off that instead of the unreliable change/close signals - with the swatch slot tracking its current color so every following adjustment lands. Fixes double-tap re-colors not sticking.
- The plus button settles the new preset on a quiet period after you stop adjusting (800ms), with input blur and panel close as immediate backstops - the platform picker neither blurs its input nor reports close when dismissed on iPad, which is why a pick only landed after closing the whole settings panel.

## 0.8.0-beta.32 - 2026-10-10

- The page-flip settle now CONTINUES the slide from the exact release point - flips glide into the slot, rejected flips glide home - driven by the Web Animations API with the commit on animation finish. The previous transition/timer chain was what devices delayed (the freeze mid-slide with both pages visible that then self-recovered). Both editors.
- Double-tapping a preset swatch no longer has the color picker yanked away mid-adjust: the settled pick now updates the swatch strictly in place - the previous rebuild destroyed the very input the platform picker is anchored to, closing it immediately and discarding every further adjustment.
- The plus button adds exactly one preset per picker session: the platform picker fires a change for every swatch tapped inside it, so the palette received every tried color at once. The live value becomes the tool color while adjusting; it joins the palette once, when the picker closes.

## 0.8.0-beta.31 - 2026-10-10

- The PDF page is pane-sized again: beta.29's fit formula mixed its units (the page box is already pane-wide at zoom 1, and the formula scaled by paneWidth/pageWidth a second time), blowing every page ~1.4x past the pane - cut off right and bottom - with Reset recomputing the same broken value. A landscape page now fits the pane width at zoom 1; a portrait page fits the pane height. Zoom out / Reset zoom / Zoom in stay in the page-options menu.
- The page-flip flash is attacked at its remaining root: a trailing touchcancel (or duplicated settle) could spring an already-decided flip back, sliding the neighbour stage beside the incoming page and destroying it there. A decided flip now never springs back, and the commit listens on the stage's own transitionend instead of the page's (which can receive bubbled foreign transitions). Both editors.
- The preset palette picker is per-swatch and native again: a tap on a swatch selects the color and arms that swatch's own color input; the next tap lands on the real input and opens the system picker (programmatic .click() never opened it on iPad - the beta.30 regression). Hold still deletes the preset.
- Switching to the eraser closes the brush panel instead of stranding an empty shell whose pinned sample stroke stayed on screen.

## 0.8.0-beta.30 - 2026-10-10

- The preset palette lost its intermediate editor: a double-tap on a swatch re-colors that preset straight in the system picker, and a 550ms hold deletes the preset outright (the one-swatch minimum holds; a notice confirms). Tapping the platform picker sheet can no longer close the panel mid-edit - the tap-outside dismissal waits while a picker session is open.
- The PDF page-options menu gains Zoom out / Reset zoom / Zoom in. A manual pinch latches until the document changes, and without an entry point back to the fit that read as "the fit itself is huge"; Reset clears the latch and re-fits. The fit is also defensively capped at the pinch maximum.
- The eraser mini popover gets the brush panel's gesture shield: a slider drag no longer reaches the app chrome (which dragged the sidebars out). The size slider hides in stroke mode, where the hit radius is fixed and the slider does nothing.

## 0.8.0-beta.29 - 2026-10-10

- The PDF fit fills the pane again: the 980px page-box limit and the fit-at-most-100% limit are gone, so a fullscreen pane shows the page as large as it allows - a landscape slide fills the pane width, a portrait page fills the pane height (orientation-correct contain, never width-filled across a portrait page).
- The page-flip commit no longer teleports the old page: at the slide's end the neighbour stage already covers the page slot exactly, and the commit now only drops the covered page's transform. Re-reading layout offsets during teardown returned intermediate values on devices, which flashed the old page to the side of the incoming one before it disappeared. Both editors.
- The preset palette works on touch: the edit editor opens on a detected double-tap (iPads never deliver dblclick), and the plus button adds exactly one preset per pick - the color picker streams input events while dragging, and adding per event stuffed the palette with the whole drag path. A pick becomes a preset when it settles (change event or a 500ms pause).
- The highlighter panel is the highlighter panel again: pen-only dynamics (smooth, taper, pressure, curve, speed) are hidden unless the pen is active - they rendered under the highlighter too and buried its size/color/opacity under low-frequency sliders. A panel switch or open scrolls back to the top.
- Scrolling inside a popover no longer moves the popover: repositioning during a touch scroll chased the platform's jittering fixed-element rects and nudged the panel sideways mid-scroll (brush panel and eraser mini popover).

## 0.8.0-beta.28 - 2026-10-08

- Popovers follow "open where tapped, close back into it": the settings panel and the eraser mini popover now anchor to the tool button that opened them, play a short grow-out-of-the-button animation on open and shrink back into it on close. The eraser mini popover is mounted inside the themed view again (outside it every theme token resolved to nothing - the fully transparent panel), anchors to its eraser button instead of floating over the page, and re-tapping the eraser toggles it closed (the pointerdown/click race used to reopen it on every tap, which read as a flashing popover that never closed). Switching tools closes it.
- The preset colors are a real editable palette: double-click a swatch to edit that preset (color input plus Remove, disabled at the one-swatch minimum); the plus button stores a picked color as a new preset while the palette holds fewer than ten (full palette degrades to use-now). The palette is shared by both editors, persists with the tool settings, and 1..10 entries are enforced in storage. The stock five colors remain the default.
- The toolbar is one centered group again: the document section no longer rides at the far right edge.
- The page-options menu closes on an outside tap again: surface input no longer swallows the tap that dismisses it (the menu previously stayed open until one of its own items was picked), and a tap on the page while a menu is open never starts ink underneath.
- PDF: page options and export always respond - the read-only lock no longer silently no-ops them (mutating menu items still fail with a notice; export only reads). Pinch-zoom, pan and page-flip gestures now work while the view is read-only; the lock gates only ink input. Failing writer arbitration shows why ("another open tab is already writing...") instead of leaving every control dead.
- PDF page rail: starts collapsed like the notebook editor's and gets a toolbar Pages toggle (same pressed styling); thumbnails skip painting while collapsed and repaint on reveal. Rail thumbnails now draw the page's handwriting at thumbnail scale over the PDF bitmap, and refresh after input settles - matching the notebook rail.
- Notebook paper: ruled, grid and dot cells are fixed to the page (exactly 32 page px, scaled by zoom), so zooming reads like zooming an image and the line count never changes. Page thumbnails render as true miniatures: nib width stays proportional to the paper (no more fat, unreadable strokes) and the thumbnail ruling shows the page's real line count. Thumbnail clones are reused across redraws through an identity-keyed cache - fresh clones re-outlined every stroke per repaint, a measured 2x~285ms main-thread stall per stroke on large notebooks.
- Both editors share one popover wiring (dismiss, Escape, reposition); the PDF view only supplies its surface class. The Obsidian dev shim gained the varargs addClass/removeClass the real host provides.

## 0.8.0-beta.27 - 2026-10-08

- The PDF handwriting view now has a page preview rail: a permanent left column with one thumbnail per page, rendered from the actual PDF page content at thumbnail scale (~120px wide, ~0.2 pdf.js scale). Click a thumbnail to jump to that page; the current page stays highlighted. No new buttons - the rail is always there, like the notebook editor's page rail, and it scrolls for long documents.
- Thumbnails render on demand, visible range first: opening a fifty-page PDF does not render fifty pages. Rendered thumbnails live in their own small cache (evicted beyond one page from the current page, like the neighbour prewarm cache), and a thumbnail next to the current page can be downscaled straight from the existing neighbour pre-raster for an instant first frame.

## 0.8.0-beta.26 - 2026-10-08

- Page thumbnails now show content: every rail thumbnail carries a canvas that renders that page's strokes as a scaled vector snapshot (paper-color background stays). The current page's thumbnail refreshes after its ink actually changes - stroke added or removed, undo/redo, page switch, external merge - not per frame; a failed thumbnail render is contained and can never affect the main canvas.
- Drag the page rail's right edge to widen or narrow it: the rail width follows a pointer-captured drag handle, persists to localStorage, and clamps into a usable range. Past ~260px the thumbnails reflow into multiple auto-fill grid columns that adapt as the rail grows.
- The rail now animates: expanding and collapsing the page rail transitions its width over ~200ms instead of snapping via display:none.

## 0.8.0-beta.25 - 2026-10-08

- Tool settings now persist across sessions and across both editors: the notebook and the PDF handwriting view share one saved brush configuration (pen and highlighter color, width, opacity and pen dynamics, plus eraser mode and size). Any change - sliders, swatches, eraser controls - saves automatically (500 ms debounce) and is restored on the next open; corrupted saved values fall back per-field to the defaults instead of breaking the editor.
- Double-click a color swatch to make that color the tool's default: it is saved with the shared settings and pre-selected next session. A single click still just selects the color for now.
- Fix the "Take over PDF tabs automatically" setting not surviving a restart: the loader re-applied the default over the saved value, so the checkbox reset itself on every launch.

## 0.8.0-beta.21 - 2026-10-08

- Ink rendering rebuilt from polygon ribbons to stamped primitives: every sample point contributes a disc and every segment a connecting trapezoid, all wound the same direction and filled as one path. Same-direction overlaps add their winding instead of cancelling, so sharp turns, retraces and Chinese-style hooks can no longer produce holes, notches or hairline seams - at any brush width - while the single fill still keeps translucent strokes from double-darkening. Committed tiles, retained previews, live confirmed outlines and the brush-panel sample all share the new geometry.

## 0.8.0-beta.20 - 2026-10-08

- Fix the hairline white seams at sharp turns: the split ribbon runs from beta.19 abutted each other exactly, and the antialiased edges of the abutting caps left a thin unfilled sliver at every joint. Run A now keeps one segment past the turn so the bands overlap in area (along the real stroke path), closing the seams.

## 0.8.0-beta.19 - 2026-10-07

- Fix mangled strokes on sharp turns and retraces (Chinese-character hooks, writing back over a line) at any brush width: the ribbon outline was one self-intersecting polygon whose opposite-wound overlap cancelled to holes under nonzero fill. The outline now splits at sharp turns into separately filled runs; straight and gently curved strokes are pixel-identical to before.
- Fix the swipe flip flashing at the end: the settle animation now travels the same distance as the drag did (including the dynamic gutter), so the incoming page no longer snaps the last few pixels when it takes over the slot.
- The notebook swipe stage now covers the page box instead of the surrounding extent, fixing the incoming page appearing horizontally stretched (the reported squash) and matching the PDF editor's flip.
- Notebook paper lines no longer flicker or change count while zooming: the paper scale snaps to whole device pixels so the rasterizer cannot re-snap the ruled-line background every frame.

## 0.8.0-beta.18 - 2026-10-07

- Fix the flip animation being cut short: the page change was committed on a fixed 170ms timer while the slide ran 160ms - on busy frames the timer won, so the page slid halfway and the next one snapped in with no animation. The flip now commits when the slide transition actually finishes (with a fallback timer), so the animation always plays through.

## 0.8.0-beta.17 - 2026-10-07

- The smart fit is now contain-fit: the whole page is always visible with the tighter axis flush - a tall Word page fits the height completely (no scrolling needed to see the bottom), a landscape page fills the width edge to edge. The previous build scaled landscape pages to the height instead, which forced horizontal scrolling before a flip.
- Page-flip settle is snappier: the slide animation shortened to 160ms and the page commits at 170ms.
- The notebook page flip no longer shows a transient squash: the sliding page snapshot is re-synced to the live page geometry when it takes over the slot and keeps covering until the real page has rendered.

## 0.8.0-beta.16 - 2026-10-07

- Smart fit zoom: a PDF page opens filling its width (portrait pages) or its height when width-fill would leave it floating with vertical slack (landscape pages) - one axis is always flush with the pane. Manual zoom overrides it and never goes below the fitted size.
- Page-swipe gutters are now dynamic: the gap between the current page and the incoming neighbour equals the page's own edge distance, so dense text pages no longer look stitched together mid-drag.
- Zooming is dramatically smoother: the heavy full-page pdf.js raster is debounced (the previous frame stays on screen, CSS-scaled, until 160ms after the gesture settles) instead of re-rendering on every pinch step.
- Neighbouring pages are pre-rendered in the background while you read, and the swipe stage consumes that cache - page flips show the neighbour instantly instead of waiting for its render.

## 0.8.0-beta.15 - 2026-10-07

- Fix the flip settle animation: the neighbouring page now slides all the way into the page slot and stays covering it until the real page has rendered underneath - previously the incoming page slid back out of view and the old page flashed before the new one appeared, which read as a bounce back to the original page.
- The PDF editor's smallest zoom is now fit-width (100%): zooming out no longer floats a tiny page in a field of empty canvas.
- The area around the PDF page gets a theme-aware desk tint (deep grey in dark themes, light grey in light themes) instead of raw white bands on all sides.
- The PDF page no longer flashes blank while zooming or resizing: frames render into an offscreen buffer and swap onto the visible canvas only when complete (resizing the visible canvas wipes it, which is what flashed).
- While a handwriting view is open, touches on the writing surface no longer reach the app chrome at all (stop-propagation): Obsidian's left/right sidebar edge swipes can never interrupt writing - previously they fired only sometimes because the gesture handlers consumed the touches inconsistently. The raw white bands around the page (including at maximum zoom, where they were the scroller's padding peeking out at the scroll limits) are now the theme-aware desk tint.

## 0.8.0-beta.14 - 2026-10-07

- Fix handwriting landing up-left of the pen in the PDF editor: the ink overlay's coordinate space was the PDF's point size (e.g. 595pt for A4) while every mapping assumed the page box's pixel size (notebook behaviour), so strokes were proportionally compressed toward the top-left. The logical space is now the page box, matching the notebook editor. This also corrects committed tiles, the eraser radius and the modeler space in the PDF editor.
- Gallery-style page flipping: the current page follows the finger one-to-one while the neighbouring page slides in beside it (the PDF editor renders the real neighbouring page; the notebook draws a vector snapshot). The flip is decided once, on release, by travel distance (over a third of the pane) or by fling velocity - long drags no longer skip ahead several pages, and a flick with a small travel flips.
- Zoomed flipping: when the page is zoomed and scrolls sideways, a horizontal drag pans as before, but from a scroll edge it flips pages in that direction (gallery behaviour while zoomed).

## 0.8.0-beta.13 - 2026-10-07

- Fix the zoomed page being squashed by its own scroller: the beta.12 centring turned the scroller into a flex container, and once the zoomed page grew past the pane the flex layout compressed the page's height instead of letting it scroll - flattening the rendered text, pinning the apparent background size, and mis-mapping every stroke at higher zooms. The page box no longer shrinks (`flex: none`) in either editor.
- Page-flip drag rework: the page now follows the finger while dragging, a flip needs a deliberate drag (a fifth of the pane width, minimum 96px - previously a twitch flipped instantly), extra dragging past a page keeps flipping, and releasing the finger settles the page back with an animation.

## 0.8.0-beta.12 - 2026-10-07

- True centre zoom anchoring in both editors: the page now sits dead-centre in its scroller while it fits (auto margins collapse to zero once it overflows, so panning and the anchor math keep working). Previously the page hung from the top edge, so zooming pivoted around the top-centre.
- Split-view fixes: the PDF editor re-layouts (and re-renders, debounced) when its pane resizes - a view opened before a split previously kept its stale geometry, overflowing the pane and mis-mapping strokes; and both editors now heal interactions whose pointer the platform lost (iPadOS split-view transitions can swallow the final pointerup/touchend - the stuck interaction then blocked every two-finger gesture until the next pen stroke).
- Photos-style page flipping: a horizontally dominant single-finger drag flips to the previous/next page in both editors (when the document cannot scroll sideways). The PDF toolbar's previous/next and zoom buttons are gone - pages flip by swipe, zoom lives on pinch and Ctrl/⌘-wheel.
- The PDF reading mode is removed: the view is always in editing shape, read-only behaviour remains purely as a lock state (fingerprint-mismatched or corrupt sidecars stay protected, and the single-writer arbiter still holds). The eye toggle, text layer and mode plumbing are gone.
- The brush-settings button moves to the far left of the toolbar in both editors (it carries the sample-stroke preview); it no longer sits between the tools.

## 0.8.0-beta.11 - 2026-10-07

- Zoom in the PDF editor is now anchored like the notebook editor: the toolbar zoom buttons and reset keep the viewport centre stable, Ctrl/⌘-wheel keeps the cursor position stable, and a two-finger pinch keeps the gesture midpoint stable. Previously every PDF zoom scaled around the page top, so the content you were looking at drifted up and away.

## 0.8.0-beta.10 - 2026-10-07

- Continue the unification at the UI layer, everything on the notebook editor's standard: the shared writing layer now also owns the toolbar components (icon button, tool button with its click contract, sections, active/disabled states), the interaction render pass (frame routing, selection, lasso preview with the lifted-stroke drag, eraser cell preview), the touch gesture handlers (Scribble stylus-touch ownership and two-finger pinch/pan) and the brush settings popover's eraser block and tool presets.
- The PDF editor adopts the notebook look and behavior wholesale: same tool icons (pen-line/highlighter/eraser/lasso-select), same labels, same toolbar button DOM and states, same tool presets (pen maximum 24) and eraser settings UI (icon mode radios, 8-160 slider, stroke-eraser hint), same eraser cursor, and same notebook defaults (direct ink, #1b1b1b pen, 18px highlighter, eraser 32) - it previously shipped smoothed ink with different colors and a different eraser range out of the box.
- The PDF editor gains the notebook's touch handling in editing mode: Apple Pencil Scribble now works and two-finger pinch/pan zooms the page; reading mode keeps native scrolling (the handlers are gated on the edit lock).
- The PDF lasso drag now lifts the selected strokes onto a dedicated canvas that follows the drag (previously only a dashed box moved while the ink stayed put until release).
- Intentional PDF behavior changes beyond parity: selecting a tool in reading mode still enters editing; undo/redo buttons use the disabled attribute (styled by the shared rule); the in-popover eraser mode buttons are the notebook's icon radios.

## 0.8.0-beta.9 - 2026-10-07

- Extract the shared writing layer (`src/ink-writing.ts`): pointer capture, raw-update consumption, coalesced-sample feeding, stroke-modeler engagement (smooth/sparse/direct), lift-pressure clamping, preview/commit lifecycle, eraser and lasso behavior, history-stack mechanics and save scheduling now live once and serve both the notebook and PDF editors. Every fix in this layer applies to both.
- The PDF editor adopts the notebook pipeline wholesale and drops its forked one, fixing several drifts: the sparse-input modeler engagement was dead (intervals were reset at pointerdown), sparse strokes used the wrong modeler tuning, `pointerrawupdate` samples were never consumed, and saves could run mid-stroke instead of deferring to the next idle window.
- The PDF preview now uses the same worker-confirmed outline + live-tail rendering and confirmed-outline retention as the notebook editor, with a matching confirmed-preview layer, and the ghost tip anchors at the live stroke tail in both editors.
- The PDF eraser cursor adopts the notebook cursor (mode-aware size, stroke/circle/square states, reference point) and the eraser hover model.
- Undo stacks are capped at 200 entries in both editors (previously unbounded in the notebook view); this is the only intentional behavior change for the notebook editor.

## 0.8.0-beta.4 - 2026-10-07

- Fix the PDF ink editor's broken GUI on iPad: the shared brush popover is now mounted at the view root with fixed, viewport-clamped positioning (mainline parity) instead of nested inside the toolbar group, where the toolbar's layout context mangled it into an unreadable arc; the popover now opens/closes reliably (brush button, Escape, outside tap).
- Fix blank toolbar icons in the PDF view: icon SVGs get explicit sizing.
- Fix handwritten strokes not appearing until the tile commit: the PDF ink host's layers now carry explicit positioning and z-index (tiles 1 / selection 3 / preview 5 / eraser cursor 6), so the live preview renders above the PDF canvas immediately.
- PDFs editable in Ink Notes now open straight into editing mode when handwriting is available (the eye toggle still switches to reading); previously they opened read-only with no visible way into the editor.

## 0.8.0-beta.3 - 2026-10-06

- Polish the tool settings popover from device feedback: the duplicated per-panel "Tool settings" header is removed (the pinned header alone carries the title and live size), the scroll body keeps a visible gap between the controls and the scrollbar, and the sample-stroke and pressure-curve canvases are pinned to a paper-white background so ink previews stay legible in dark mode (previously dark ink rendered on the dark theme background and disappeared).
- Move the developer diagnostics toggle from the toolbar into the Page options (···) menu — the toolbar is now fully icon-only, and the diagnostics panel, Export/Copy JSON (also in this menu and the Obsidian settings tab) remain available to everyone.

## 0.8.0-beta.2 - 2026-10-06

- Fix the tool settings popover being unable to scroll vertically on iPad: the open-state rule forced block layout, which disabled the pinned-header flex column and left the scroll body unconstrained (clipped by the popover with no scrollbar anywhere). The open popover now uses the intended flex column — the sample-stroke preview stays pinned while the settings scroll.
- Fix the color swatches stretching into wide ellipses on iPad: the swatches now carry a higher-specificity fixed 40px circle with aspect-ratio and a max-width cap, and the swatch row wraps.
- Vertical-only touch panning moves to the scroll body (removed from the popover root), and the body gets legacy WKWebView momentum scrolling (-webkit-overflow-scrolling).

## 0.8.0-beta.1 - 2026-10-06

- PDF handwriting: opening a PDF now creates a sidecar notes file under `A_pdfinkwrittern/` and opens the tab in the Ink Notes reading view — the page renders with saved handwriting on top, and ink input stays off until you explicitly toggle edit mode.
- Editing mirrors the notebook editor: pen, highlighter, stroke/circle/square erasers, lasso select and move, and undo/redo, all rendered through the existing background-worker tile pipeline.
- Data safety: sidecar writes are gated by a SHA-256 fingerprint of the PDF and compare-and-swap saves with bounded merge retries; corrupt, unknown-version, or foreign sidecars force read-only instead of being overwritten; states that cannot be saved safely keep the ink in a conflict copy.
- Blank note pages: insert after any page (inheriting the neighbor's size and rotation), delete, or move — source PDF pages are permanent and their order never changes.
- Renaming a PDF migrates its sidecar automatically; moving it while the plugin was closed is recovered on the next open via a unique content-fingerprint match (with several matches, you pick).
- Vector export: "Export PDF with handwriting" writes `<name> (handwritten).pdf` next to the source, preserving original page content, sizes, and rotation; digitally signed, encrypted, and corrupt PDFs are rejected explicitly and the sidecar is untouched.
- PDF++ compatibility: while PDF++ is enabled the automatic takeover yields and PDFs keep opening in the enhanced built-in viewer — handwriting stays available per tab from the file context menu or command palette, and a handwriting tab can hand itself back to the built-in viewer from the page menu.


## 0.7.0-beta.5 - 2026-10-06

- iPad UX pass on the tool settings popover: the sample-stroke preview is pinned in a header that stays visible at all times while only the settings controls scroll (vertical-only panning, no scroll chaining), and the open menu shields touches from Obsidian's workspace swipe gestures, so adjusting a slider can no longer summon the file switcher or side panels.
- All toolbar buttons are icon-only (labels remain as tooltips and aria-labels); the color swatches keep a fixed circular size instead of stretching into ellipses on iPad.
- Reading mode: a toolbar toggle (book icon) that disables ink capture and eraser tracking and restores native page panning and scrolling for reviewing notes; everything returns on exit.
- Editor ergonomics: a suggested default hotkey (Ctrl/Cmd+Shift+O) opens the notebook file picker, diagnostics JSON export moved into the Page options menu and the Obsidian settings tab (no longer developer-only), and the developer panel toggle lives in the new Ink Notes settings tab.

## 0.7.0-beta.4 - 2026-10-06

- Pressure curve editor refinements from device feedback:
  - The mapping is enforced non-decreasing — more pressure maps to equal or more width, never less (drag is height-clamped between neighbors; new points insert between neighbor heights; storage normalization flattens dips).
  - Dragging an interior point onto the bottom edge removes it.
  - A Reset button restores the default linear mapping.
  - The editor stays collapsed until manually expanded from the Pressure curve header (chevron), and draws when expanded.

## 0.7.0-beta.3 - 2026-10-06

- Fix the pressure curve editor rendering blank: the draw routine was defined but never invoked, and the popover is built display:none so a build-time draw would also have had no layout. The popover now triggers a preview redraw when it opens (after layout), and point drags redraw both the curve editor and the sample stroke. Verified in a live popover with pixel sampling and screenshots.

## 0.7.0-beta.2 - 2026-10-06

- Fix the Taper slider being effectively binary: any value above 0 collapsed the stroke ends to a sharp point. The taper now sets a width envelope that keeps (100 − taper)% of the width at each end — 1% is visually round, mid values narrow progressively, only 100 converges to a point.
- Taper, pressure and speed now compose instead of compounding: the taper defines the width envelope and the pressure/speed response modulates the actual width within it, so a firmly pressed tapered tail widens the whole cone rather than staying a fixed thin needle (and the pressure limiter keeps overly hard presses in check).
- Pressure mapping curve: a 2D multi-point editor in the pen brush panel (drag points, click to add, double-click to remove) remaps raw pen pressure before the response amplitude — boosts or tames the response where the hardware feels dull or twitchy. The curve is captured per stroke, sanitized (monotonic x, clamped y, identity stripped) and rendered in the sample preview.
- Speed compensation profile is now quadratic and capped at −35%, so the pressure response stays clearly visible when both channels are active (previously the linear −65% masked pressure variation entirely).

## 0.7.0-beta.1 - 2026-10-06

- iPad predicted events: where the WebView provides getPredictedEvents (iPadOS does), the live ink now draws a tapering ghost tip that follows the pen between samples — deep black at the ink junction fading to faint at the predicted position. Predicted points are speculative and never enter the stroke; they live only on the preview layer and are dropped at lift so the real tail takes over. The developer panel now counts predicted samples per session and per stroke, so availability on a given device is verifiable.
- Pen dynamics, captured per stroke and rendered from stored points (render-only; points are never rewritten; older strokes default to the previous behavior):
  - Taper (0-100): end shape from round caps to tapered points, with a length-ramped width falloff that also masks residual tail-width jumps.
  - Pressure (0-100): pressure response amplitude, from uniform width (off) to full dynamics.
  - Speed width (0-100): speed-based thinning, self-scaled to each stroke's own median pace so it works at any zoom or writing size; works together with the pressure response.
- The pen brush panel gains the three sliders plus a live sample-stroke preview canvas rendered through the same outline geometry as committed ink, so previews match real output while adjusting.
- Settings popover is height-capped with internal scrolling so the new controls never cover the toolbar.

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
