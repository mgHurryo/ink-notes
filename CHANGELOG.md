# Changelog

## 0.1.0-beta.2 - 2026-09-07

- Clarify the drawing toolbar with labeled controls, grouped actions, visible color swatches, and live brush values.
- Improve iPad touch targets and selected-tool contrast.

## Unreleased

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
