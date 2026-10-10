# Ink Notes

Ink Notes is a cross-platform handwritten notebook plugin for Obsidian. It stores notebooks as JSON files inside the Vault under `Ink Notes/`, so Obsidian Sync and other Vault sync tools can replicate the same pages and strokes to Windows, macOS, Linux, iOS, and iPadOS.

## Current MVP

- Pointer Events input for pen, mouse, and touch-capable WebViews.
- Pressure-aware pen strokes with tilt values retained in the file and adjustable smoothing for cleaner everyday handwriting.
- Real-time pen and highlighter previews, including long strokes that cross render tiles.
- Stroke, circular, and square erasers with an always-visible aiming outline and adjustable local-eraser size.
- Paper templates, a collapsible page rail, page creation, duplication, deletion, reordering, rename, and zoom.
- Undo and redo for drawing, erasing, lasso moves, and page operations.
- Lasso selection and constrained on-page stroke movement.
- A single compact 56px responsive toolbar with tool settings in an accessible popover and no duplicate offscreen controls.
- Atomic Vault writes with stroke and page tombstones so deleted content stays deleted during cross-device merges.
- Read-only Markdown `ink` code-block embeds with optional page targeting.
- No native dependency, so the plugin is packaged once for all Obsidian platforms.

## UI Preview

Run `npm run preview` and open http://127.0.0.1:4173 to exercise the actual editor view with a lightweight browser host. Preview notes are in memory only; Vault storage and sync must be verified in Obsidian. The layout responds to the editor pane width, including split panes and mobile screens.

## Markdown embeds

Embed the first page of a notebook in Markdown:

````markdown
```ink
Ink Notes/My Notebook.ink
```
````

Target a specific page by adding its page ID (available from **Page options → Copy page embed syntax**):

````markdown
```ink
Ink Notes/My Notebook.ink
page: page-id
```
````

## Capability boundary

Apple Pencil squeeze and double-tap are not standard Web signals, so this MVP does not claim support for those gestures. They can be added later through platform-specific bridge APIs if Obsidian exposes them.

## PDF plugin compatibility

Ink Notes keeps its handwriting in a separate view and sidecar; it never replaces the source PDF. Native PDF extensions (including PDF++, Jot, PDF Writer, translators, readers and annotation tools in the audited list) retain their normal viewer automatically. PDF navigation/search/selection state is forwarded to the native viewer. Handwriting remains available through **Open current PDF with handwriting** and the PDF file context menu, and **Return current PDF tab to the built-in viewer** saves ink before handing the tab back.

Native text-layer extensions operate in the native viewer, while Ink Notes editing operates in its own tab. This does not combine independent annotation formats or guarantee compatibility among third-party plugins themselves. If another tool changes the source PDF revision, reopen it to check the sidecar; export refuses to apply old ink coordinates to different source bytes.

The [compatibility audit](docs/pdf-plugin-compatibility.md), [283-plugin inventory](docs/pdf-plugin-inventory.md), and [pinned source evidence](docs/pdf-plugin-compatibility.json) distinguish source inspection from real Obsidian validation. The automatic takeover setting remains available for plugins outside the audited list.

## Build

```bash
npm install
npm run typecheck
npm run build
```
