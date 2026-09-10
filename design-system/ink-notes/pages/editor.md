# Editor Page Overrides

This file overrides the Ink Notes master design system for the handwriting editor.

## Layout

- The editor fills its Obsidian pane; it has no arbitrary maximum content width.
- The workspace receives all height remaining below the 56px toolbar.
- Page rail expansion reduces the scroller width and never covers the writing surface.
- Paper is centered when space permits and remains fully reachable by scrolling when zoomed.

## Interaction priorities

1. Pointer input and live ink preview.
2. Tool selection and undo/redo.
3. Contextual tool settings.
4. Page organization and document options.

## Editor-specific details

- Pen and highlighter use independent settings and independent live previews.
- Eraser mode controls show icon and text inside the settings dialog.
- The eraser reference outline remains deliberately high-contrast over both white paper and colored ink.
- Toolbar and settings animations are cosmetic and must not add work to the pointer hot path.
