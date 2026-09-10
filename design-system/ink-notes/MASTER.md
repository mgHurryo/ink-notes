# Ink Notes Design System

**Product:** handwriting-first Obsidian editor
**Direction:** canvas-first minimalism with a compact Swiss-style control hierarchy
**Design dials:** variance 4/10, motion 2/10, density 8/10

## Principles

1. The paper is the product. Chrome stays compact, quiet, and out of the writing path.
2. Primary tools remain reachable at every supported width; secondary actions move into contextual surfaces.
3. Pen, highlighter, and eraser settings are separate contexts with immediate visual feedback.
4. The interface inherits Obsidian semantic tokens rather than imposing a fixed light or dark skin.
5. Every icon-only action has an accessible name, a visible focus ring, and at least a 44px target.

## Tokens

- **Typography:** `var(--font-interface)` with system fallbacks; no external font requests.
- **Surfaces:** `--background-primary`, `--background-secondary`, and `--background-secondary-alt`.
- **Text:** `--text-normal`, `--text-muted`, and `--text-on-accent`.
- **Interaction:** `--interactive-accent`, `--background-modifier-hover`, and `--background-modifier-border`.
- **Spacing:** 4px micro spacing, 8px control spacing, 12–16px panel padding, 24–36px canvas breathing room.
- **Radii:** 8px controls, 12–14px transient panels, nearly square paper.
- **Motion:** 160ms color/border transitions only; no layout-shifting transforms.

Fixed colors are permitted only for paper, ink, highlighter pigments, and paper guides because those are document content rather than application chrome.

## Components

### Primary toolbar

- Exactly 56px high.
- Contains Pages, Pen, Highlight, Erase, Select, Undo, Redo, and Page options.
- Uses icons at compact widths and adds labels only when sufficient space exists.
- Selected tools use both accent fill and pressed state semantics.

### Tool settings

- Anchored dialog with one visible tool context at a time.
- Title, live stroke preview, size slider, presets, color, opacity, and smoothing form a clear top-to-bottom hierarchy.
- Stroke eraser does not expose a meaningless size control; local circle/square erasers do.
- Escape closes the dialog and restores focus to the active tool.

### Page rail

- Collapsed by default.
- Displays current/total count, page actions, and page thumbnails.
- Remains in document flow instead of overlaying the paper.

### Workspace and paper

- Workspace is a neutral semantic surface.
- Paper receives restrained elevation to distinguish it without a heavy app-like frame.
- Canvas density, input behavior, and rendered document colors are not modified by theme styling.

## Responsive behavior

- **360–760px:** icon-only 44px toolbar targets with no horizontal scrolling; compact 128px page rail.
- **760–999px:** icon-only centered toolbar and wider canvas gutters.
- **1000px+:** toolbar labels may appear while retaining the 56px height.
- Popovers are viewport-bounded and internally scroll when vertical space is constrained.

## Accessibility and quality gates

- Text contrast: 4.5:1 minimum; meaningful control boundaries and icons: 3:1 minimum.
- Color is never the only selected-state indicator.
- Respect `prefers-reduced-motion`.
- No emoji, external fonts, hidden primary controls, layout-shifting hover effects, or fixed dark-only palette.
- Verify 360px, 480px, 720px, desktop, light, dark, and high-contrast variants.
