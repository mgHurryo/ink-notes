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

## Build

```bash
npm install
npm run typecheck
npm run build
```
