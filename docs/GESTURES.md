# Gesture contract

Ink notebooks and PDF handwriting use the same input rules. This is a local
interaction design informed by the official references below, not a claim
that every gesture exactly matches Goodnotes or that user studies were run.

| Action | Finger, default | Stylus | Mouse / keyboard |
| --- | --- | --- | --- |
| Write, highlight, erase | Navigate; does not add or erase ink | Current tool, immediately | Current tool; Space + drag navigates |
| Select handwriting | Circle or rectangle in Select | Same in Select | Same in Select; copy/cut/paste shortcuts |
| Move selected handwriting | Drag selection in Select | Same in Select | Same in Select |
| Select/move/resize image | Tap image, drag body/handle in any tool | Pointer only; writing tools keep writing | Pointer only |
| Move page / change page | Drag blank paper; swipe at page boundary | Use fingers for navigation | Reading-mode drag, Space + drag, wheel/trackpad and page shortcuts |
| Zoom | Two-finger pinch; lock permits pan only | Use fingers | Existing Ctrl/Mod + wheel zoom |
| Clipboard options | Stationary 600 ms hold; selected ink shows selection actions, blank paper shows Paste if available | Selection actions after selecting ink | Right-click paper; existing shortcuts |
| Dismiss object edit or actions | Outside tap, action button, Done/Escape | Same | Same |
| Tool settings | Tap active tool again | Same | Same |
| Color preset | Tap selects; double-tap edits; hold opens removal options | Same on controls | Click selects; double-click edits; right-click / Shift+F10 options |
| Delete curve point | Select point, explicit Remove point | Same | Same |
| Page batch management | Explicit Manage/selection/actions in full preview | Same | Same |

Selecting ink can show its existing Copy/Cut/Delete/Paste strip immediately;
this is tied to a selection, not to tapping arbitrary blank paper. No new
double-tap page reset, two-finger undo or three-finger clipboard shortcuts
are introduced. Such gestures would conflict with page navigation or OS actions.

## Desktop scrolling

The shared Ink/PDF input layer consumes normal wheel events to scroll the page
on the dominant axis. It changes pages only after scrolling stops at that axis's
boundary and accumulated outward movement reaches 100 CSS pixels. A wheel event
that still moves the page does not also turn it. Shift+wheel selects the horizontal
axis. Line/page units are converted before scrolling; Ctrl/Cmd+wheel keeps its
cursor-centered zoom behavior.

A decaying inertia tail cannot turn another page. Idle for 180 ms, reversal,
axis change, or renewed motion of at least 40 pixels after a tail of at most
12 pixels rearms navigation. The tail minimum is retained so gradual new flicks
can rearm too. These are bounded fallbacks because WheelEvent exposes no portable
gesture start/end or inertia flag; physical trackpads still need device testing.

Vertical navigation lands at the top of the next page or the bottom of the previous
page. Pending page requests reuse the swipe destination queue, including
PageUp/PageDown, Home/End and Alt+Left/Right during animations/saves. Editing
shortcuts stay blocked during the handoff. Text inputs and nested scroll surfaces
retain their native wheel handling; Alt+wheel remains available to sticky boards.

## No stylus

Enable **Use finger as pen** in the plugin's **Input and gestures** settings.
It defaults to off, including for older saved configurations. One finger uses
the selected Pen, Highlight, Erase or Select tool. Use two fingers to move/zoom
the viewport, or Pointer to swipe between pages and manipulate images with a
single finger. A stationary 600 ms hold still opens clipboard options in every
tool; provisional ink or erasure is reversed before the menu appears.

Adding another finger cancels the unfinished single-finger edit before the
two-finger navigation gesture. Existing undo/redo commands perform the reversal,
including worker and tile updates; cancellation does not add a history entry or
clear an existing redo. Eraser cancellation restores equivalent strokes with new
IDs under the existing collaborative tombstone rules. Cancelled lasso movement
discards its preview without changing stroke coordinates. Lifting one finger
after a pinch does not start writing with the remaining contact.

The preference is shared live across all open Ink/PDF views. Reading mode and
PDF source-change protection continue to disable edits. Active stylus input takes
priority over fingers on images. Plain capacitive styluses are reported as fingers
by the browser; enable finger writing for those devices.

## Audit and changes

| Previous inconsistency | Resolution |
| --- | --- |
| Images required Pointer even for a finger | Fingers manipulate them in any tool by default; drawing stylus input passes through |
| Lasso discarded finger contacts and cleared selection | Finger shares the existing lasso input/drag path |
| Pointer rejected stylus image selection | Stylus precision manipulation is available in Pointer |
| Finger input could only navigate | Explicit opt-in persisted finger-writing setting |
| Hold directly deleted a color | Hold opens options; deletion requires an explicit action |
| Double-click or dragging to the curve bottom deleted a point | Select then Remove point; dragging only edits coordinates |
| Page paste required touch hold on desktop | Right-click counterpart uses the same selection actions |

Tool re-tap, explicit page management, image insertion selection, outside
dismissal, zoom lock, boundary page-insertion thresholds and keyboard shortcuts
reuse their existing implementation. No notebook/sidecar schema migration or
new image data is needed.

## Pending sticky notes

PR #177 remains unmerged. Its draft has separate gesture issues: single-tap
content editing, Pointer-only header dragging and event shielding that needs
checking against native touch cancellation and document listeners. Before that
feature is integrated, align it with this contract: tap selects the note, drag
moves/resizes, double-tap edits text, stylus writing stays writing, and long-press
offers actions. These are follow-up requirements, not behavior shipped here.

## References and limits

- [Apple: basic iPad gestures](https://support.apple.com/guide/ipad/touchscreen-gestures-ipad2c09c4d4/ipados): tap, hold, swipe and two-finger pinch.
- [Goodnotes: select, move and edit with Lasso](https://support.goodnotes.com/hc/en-us/articles/7353695644175-Select-Move-and-Edit-Content-With-the-Lasso-Tool): freehand/rectangle selection, drag and object actions.
- [Goodnotes: insert images](https://support.goodnotes.com/hc/en-us/articles/7353727617295-Insert-images-into-Goodnotes): selected inserted images, manipulation and long-press paste.
- [Goodnotes: palm rejection](https://support.goodnotes.com/hc/en-us/articles/7353727026959-Configure-palm-rejection-for-comfortable-writing): device distinction between Pencil and capacitive input.

Official documentation was reviewed; Notability's documentation endpoint was
unavailable, so no Notability behavior is asserted. Automated tests exercise
both editor implementations and real Chromium native Touch dispatch. Actual
iPad Pencil/Scribble, iPadOS palm rejection and Android hardware require device
verification; desktop Chromium cannot establish their behavior.
