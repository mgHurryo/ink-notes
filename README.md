# Ink Notes

Ink Notes is a cross-platform handwritten notebook plugin for Obsidian. It stores notebooks as JSON files inside the Vault under `Ink Notes/`, so Obsidian Sync and other Vault sync tools can replicate the same pages and strokes to Windows, macOS, Linux, iOS, and iPadOS.

## Current MVP

- Pointer Events input for pen, mouse, and touch-capable WebViews.
- Pressure-aware pen strokes with tilt values retained in the file.
- Highlighter, eraser, paper templates, page rail, page creation, page rename, and zoom.
- Undo and redo for drawing, erasing, and lasso moves.
- Lasso selection and constrained on-page stroke movement.
- Labeled toolbar groups, visible color swatches, and live brush size/opacity values.
- Atomic Vault writes with tombstones so deleted strokes stay deleted during cross-device merges.
- No native dependency, so the plugin is packaged once for all Obsidian platforms.

## Capability boundary

The WebView capability probe in the supplied screenshot is treated as runtime input support information. Apple Pencil squeeze and double-tap are not standard Web signals, so this MVP does not claim support for those gestures. They can be added later through platform-specific bridge APIs if Obsidian exposes them.

## Build

```bash
npm install
npm run typecheck
npm run build
```
