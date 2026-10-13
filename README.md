# Ink Notes

**Handwrite, annotate PDFs, and organize visual notes directly in Obsidian.** Ink Notes keeps notebooks and handwriting in your vault, so your existing sync service can carry them across desktop, iPhone, and iPad.

[![Obsidian Community Plugin](https://img.shields.io/badge/Obsidian-Community%20Plugin-483699?logo=obsidian&logoColor=white)](https://community.obsidian.md/plugins/ink-notes)
[![Latest release](https://img.shields.io/github/v/release/mgHurryo/ink-notes?include_prereleases&label=latest%20release)](https://github.com/mgHurryo/ink-notes/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Obsidian 1.5.7+](https://img.shields.io/badge/Obsidian-1.5.7%2B-483699?logo=obsidian&logoColor=white)](https://obsidian.md/)

Pressure-aware handwriting, PDF annotation, movable images, sticky notes, and text boxes share one page-based workspace. The original PDF stays untouched; notebooks and PDF notes are stored in your vault.

## Quick start

1. **Install:** In Obsidian, open **Settings → Community plugins → Browse**, find **Ink Notes**, choose **Install**, then enable it under **Installed plugins**. Ink Notes requires Obsidian 1.5.7 or later.
2. **Open a notebook:** Select the pen icon in the ribbon, or run **Ink Notes: Open Ink Notebook**. The picker can create, open, and rename notebooks; **Ink Notes: Create Ink Notebook** creates one directly.
3. **Write on a PDF:** Open a PDF and run **Ink Notes: Open current PDF with handwriting**, or choose **Open PDF with Ink Notes handwriting** from the file menu. This opens a separate Ink Notes tab; assign the command a hotkey in **Settings → Hotkeys** for quicker access.
4. **Read or edit:** Use **Reading** to navigate without drawing and **Editing** to write. Export creates a PDF copy with handwriting; the source PDF is preserved.

<details>
<summary>Manual installation and upgrade notes</summary>

Download `main.js`, `manifest.json`, and `styles.css` from the [latest GitHub release](https://github.com/mgHurryo/ink-notes/releases/latest). Place them in `.obsidian/plugins/ink-notes/` inside your vault, reload Obsidian, and enable **Ink Notes** in **Settings → Community plugins**.

If you installed the withdrawn initial 0.1.2 package, replace all three plugin files with the corrected 0.1.2 release and restart Obsidian. Because the version number is unchanged, an automatic update check may report that you are already up to date.
</details>

## Contents

| Create and edit | Navigate and organize | Reference |
| --- | --- | --- |
| [Features](#features) · [Scribble erase](#scribble-to-erase-with-the-pen) · [Lasso](#copy-handwriting-with-the-lasso) | [Desktop navigation](#desktop-navigation) · [PDF viewer behavior](#why-does-a-pdf-still-open-in-the-default-viewer) · [UI preview](#ui-preview) | [Markdown embeds](#markdown-embeds) · [Privacy and storage](#privacy-and-storage) |
| [Images](#insert-and-arrange-images) · [Sticky notes](#sticky-notes) · [Text boxes](#page-text-boxes) · [Shapes](#shapes-and-hold-to-straighten) | [Lossless storage](#lossless-handwriting-storage) · [PDF plugin compatibility](#pdf-plugin-compatibility) | [Build](#build) |

<details>
<summary>PDF viewer settings and plugin compatibility</summary>

### Why does a PDF still open in the default viewer?

Choose **Settings -> Ink Notes -> PDF handwriting -> Default PDF viewer**. **Ink Notes first** opens ordinary PDFs in handwriting even when PDF++ is enabled. Focus flags, empty link fragments and native viewport memory added during ordinary file opens do not override this choice. **Compatibility mode** automatically chooses the native viewer when a supported PDF extension is enabled; it is the default for a fresh installation. **Native PDF viewer** disables automatic handwriting opens. Existing checked **Take over PDF tabs automatically** settings migrate to **Ink Notes first**; unchecked settings migrate to **Native PDF viewer**. Changing the mode does not convert tabs already open, so close and reopen the PDF or use the explicit handwriting command.

In compatibility mode, Ink Notes deliberately keeps the native PDF viewer when a supported viewer extension such as PDF++, Jot or PDF Writer is enabled. This lets its text selection, links, highlighting and other native-view features continue working. Page/search/selection links and other navigation state keep the native viewer in every mode so their destinations are preserved.

To use both workflows, keep the other plugin enabled and choose **Ink Notes first** or open an Ink Notes handwriting tab explicitly. Native-view extensions and Ink Notes use separate views; their annotations and tools are not combined into a single viewer. You can return from an Ink Notes tab with **Ink Notes: Return current PDF tab to the built-in viewer**; that tab retains your native-viewer choice.

If the explicit command is missing, check that Ink Notes is enabled in this vault and reload it. If an unknown plugin still intercepts the explicit opening, temporarily disable that plugin to isolate the conflict, then [report an issue](https://github.com/mgHurryo/ink-notes/issues) with plugin names, versions and the opening steps. Compatibility with every plugin combination is not guaranteed.

</details>

## Features

| Write | Edit | Organize |
| --- | --- | --- |
| Pressure-aware pen and highlighter, smoothing controls, paper templates, and stroke/circle/square erasers. | Lasso, movable images, text boxes, shapes, sticky notes, undo/redo, and PDF export. | Multi-page notebooks, page rails, vault-backed sync, Markdown embeds, and cross-device conflict handling. |

Ink Notes uses pointer input for pen, mouse, and touch-capable WebViews. It has no native dependency and is packaged once for desktop and mobile Obsidian.

### Scribble to erase with the pen

Keep **Pen** selected and repeatedly scrub, draw connected overlapping circles, or draw dense horizontal/vertical waves over existing ink. Rotated scrubs and repeated figure-eight marks also work. The gesture and covered ink disappear together; only touched portions of existing strokes are erased, preserving the rest of a connected word or long line. Scribbling on an expanded sticky erases its visible handwriting without deleting ink hidden underneath. Undo restores the original ink in one step.

Open **Erase** settings to enable **Scribble erase with pen** and adjust **Scribble sensitivity**. Lower sensitivity requires more repetitions and reduces accidental erases; the conservative default remains 25%. The regular eraser's size/mode does not expand scribble coverage. A single strike-through, isolated circle, sparse wave or ordinary progressing handwriting stays as ink; scribbles on empty paper also stay as ink. Recognition requires a compact, repetitive single pen contact completed within 1.8 seconds. Very dense repetitive handwriting or diagrams can resemble erasing; lower sensitivity or disable the feature when drawing those shapes.

### Copy handwriting with the lasso

Choose **Select** and circle or rectangle-select handwriting to show **Copy**, **Cut**, **Delete** and **Paste**. The menu fits above or below the selection and wraps on narrow screens. It closes after an action or an outside press; ordinary taps on empty paper do not open a paste menu. In editing mode, hold one finger still on the page for about **600 ms** to show **Paste** at that location with any tool selected. Moving more than 10 screen pixels, lifting early, adding another finger or starting stylus input cancels the hold. Paste keeps the current tool; in Select mode the pasted handwriting remains selected for moving. Cut, paste and delete support undo/redo; copying keeps the original strokes.

Tap **Select** again to open **Lasso** settings. Choose **Freehand** (the default) to draw a selection loop, or **Rectangle** to drag a box from one corner to the opposite corner in any direction. The rectangle selects whole strokes that lie inside or cross its boundary. Your mode is remembered and shared between Ink and PDF editors. Both modes support the same movement and clipboard actions.

Enable **Copy and paste across files** in Lasso settings to paste handwriting from any Ink notebook or PDF handwriting page into another file. This option is off by default; while off, pasting is limited to pages of the source file. In the destination, long-press the page with a finger to choose a paste location, or use **Paste handwriting** in Lasso settings to paste at the visible page center when nothing is selected. This copies handwriting only; PDF text and page backgrounds are excluded.

On desktop, Select supports **Ctrl/Cmd+C**, **Ctrl/Cmd+X**, **Ctrl/Cmd+V**, and **Delete/Backspace**. The handwriting clipboard is held in memory for the running plugin instance and clears on restart or plugin reload. It is not the system clipboard and does not sync between devices.

### Insert and arrange images

In editing mode, click **Image library** beside Select. Open **Import images** to batch-import with **Photos / files** (the native photo/file picker on mobile), **From vault**, or **Enter vault paths** (one path per line). You can also drop multiple files or paste copied images into the library. Use **Groups** to create or rename groups. Search and filter above the scrollable thumbnail grid; the insertion button stays in the footer. Importing adds images to the library; select them and click **Insert selected** to place them on the current Ink or PDF handwriting page.

For batch management, tick individual images or use **Select visible**; batch actions appear only while images are selected. **Clear selection** resets the entire selection. Selections persist across search/group filters, and the count shows how many selected images are hidden. Use **Move selected to…** for batch grouping or **Delete selected** to remove selected entries after confirming their count and names. **Undo last deletion** restores the latest removed batch until you close the library or delete another batch. Deletion only removes library entries: images already placed in notes remain visible and exportable, and managed image files are kept. This does not reclaim disk space or delete your original files.

Images start below handwriting so you can write on them. Inserting switches to the **Pointer** arrow tool and selects the new image immediately. By default, touch an existing image with a finger in any tool to select it, then drag it or its bottom-right resize handle; resize preserves the aspect ratio. In **Pointer** (**A** on desktop), a mouse or stylus can also select and move images precisely. In Pen, Highlight, Erase and Select, stylus contacts keep their current tool and never move images. Position/width percentage controls remain available. Tapping outside closes image editing. **Above handwriting / Below handwriting** changes its layer; **Delete image** removes that instance. These edits support undo/redo. Reading mode disables image editing. Images appear in page previews, Markdown embeds and exported PDFs.

### Consistent gestures

The default is **pen for handwriting, fingers for objects and navigation**. In **Select**, either a finger, stylus or mouse can circle/rectangle-select ink and drag the selection. Tap a tool to activate it; tap the active tool again for its settings. Hold a finger still for about **600 ms** for clipboard options, or right-click the page on desktop. Ordinary blank taps do not open Paste. Double-tap a color swatch to edit it; hold/right-click for options and explicitly choose **Remove preset color** to delete it. Pressure-curve points likewise use an explicit **Remove point** button.

Without a stylus, enable **Settings → Ink Notes → Input and gestures → Use finger as pen**. One finger then writes, highlights, erases or selects with the current tool; two fingers move and zoom the page. Choose **Pointer** to manipulate images or swipe between pages with one finger. Stationary long-press paste still works with every tool and removes the provisional ink/erase action first. Adding a second finger cancels the unfinished single-finger edit before navigation, preserving undo/redo history. The preference is shared by open Ink and PDF editors and persists across restarts. See the [gesture matrix and audit](docs/GESTURES.md) for details.

The library stores managed PNG copies in `Ink Notes/Images/assets/` and groups in `Ink Notes/Images/library.json`. Notes and PDF sidecars store only image references and geometry; the source PDF and original images are preserved. Sync the managed assets together with your notes. Removing a placed image keeps its library asset for other pages. Imports are sequential, limited to 30 MB and 16 megapixels per image, and report unsupported or damaged files individually. Supported formats depend on the WebView; HEIC may require conversion first. Animated images are imported as a still frame. Missing assets are reported during export so a PDF is not silently saved without images. Older plugin versions do not understand image metadata; keep a vault backup before downgrading.

### Pointer and handwriting selection

The **Pointer** arrow (**A**) selects and moves images, text boxes and sticky notes. Drag the selected corner to resize; double-tap a text box to edit it. Click outside or press Escape to dismiss selection. Mouse and stylus use the same object behavior in Pointer; drawing tools keep their writing behavior. Dragging a sticky note's blank board in Pointer moves the whole note, preserving the positions of its contents. Alt+drag/Alt+wheel scrolls its internal board. For touch, explicitly choose **Scroll sticky content** in the note's menu, then tap **Done** to return to moving objects; Space+drag or middle-button drag pans the document.

**Select** (**V**) handles handwriting in freehand or rectangle mode. Tap/click directly on a visible stroke to select it, then drag it immediately; overlapping ink selects the topmost stroke. Starting on empty paper still draws a selection boundary. Dragging an already selected group moves all its strokes; clicking empty space clears the selection. Small contact jitter does not move ink. A second finger switches to navigation and cancels the provisional movement; pointer cancellation does the same. These operations work on document and sticky handwriting and support undo/redo.

### Sticky notes

Choose **Add sticky note** to place a note directly on the current Ink/PDF page. Use the document toolbar's pen, highlighter, eraser and lasso on it immediately. A stroke crossing its edge is split: the inside part belongs to the sticky, and the outside part belongs to the document. Undo/redo treats that gesture as one edit. Existing page ink remains on the page when a sticky is placed over it.

Drag anywhere on a note's title to move it with a finger or mouse, including a folded label. Drag its bottom-right corner to resize. Pen contacts on the title or resize handle do not move the note unless **Pointer** is selected. No coordinates or percentage fields are needed. Resizing crops/extends the visible window without stretching handwriting or reflowing its saved text layout. **Pointer** moves the whole note when dragging its blank board; it never silently pans the handwriting inside. Alt+drag or Alt+wheel explicitly scrolls the unbounded board without moving the note. Space+drag or middle-button drag navigates the document. Switch back to your writing tool to continue writing anywhere on the note or document. New notes are staggered, and overlapping cards keep a stable creation order: editing an older note does not unexpectedly raise it over newer notes.

Use **Type on sticky note** or double-tap/double-click its content area, including empty space, to edit Markdown directly on the card. Finger double-tap editing is disabled when **Use finger as pen** is enabled; use the typing button/menu instead. Click outside (or Ctrl/Cmd+Enter) to apply the text; Escape cancels the text draft. Double-tap/double-click the title to rename it. Text and handwriting share the board; handwriting is drawn over typed content. The note's **…** menu contains typing, renaming, folding, links, keywords, colors, folded preview and deletion. Narrow frames move typing and, when necessary, folding into this menu to keep the title and options accessible. Long-press the title or right-click the card to open the same menu; clicking **…** again closes it. Text edited in another pane cannot silently overwrite an open draft.

Use the note's **+ / Add text box** button (also in **…**) to add multiple independent Markdown boxes. Drag a box with a finger to position it, double-tap it to edit, and drag its selected corner to resize. Selected boxes expose move, edit and delete buttons; tap outside to hide them. With a mouse or Pencil, choose **Pointer** to move a box by its content; drawing tools still write over it. Keyboard users can focus a box and use arrows to move, Shift+arrows for larger steps, Alt+arrows to resize, Enter to edit and Delete to remove it. Each box has its own saved layout, search text and paragraph links. Resizing a box changes text wrapping and its visible window without modifying its text or handwriting. Old note text remains the first box; deleting any box supports undo/redo.

Select a text box and choose **Format text box** to set its font, size (8–144 board units), bold or italic style. Font presets use local sans-serif, serif, monospace, Song or Kai fonts, with system fallbacks when unavailable. **Scale text with box** is off by default: resizing only changes wrapping and the visible window. When enabled, the edge with the greater proportional change controls uniform font scaling; letters are never stretched. Styles belong to each box and survive undo/redo, saved files, previews and PDF export. Resizing the entire sticky still only changes its viewport.

**Fold** makes a compact label, optionally with a content preview. Tap its title/preview or **Expand** to restore the same frame dimensions. Long-press or right-click the label/preview to copy its Markdown link. Add a Markdown paragraph id such as `^definition-1` to typed content; the same menu offers a link to that paragraph. External links open the exact file, page and sticky inline; paragraph links highlight their target. Reading mode permits temporary folding/expansion without saving changes.

Use **Ink Notes: Find sticky notes** to search titles, typed text and manual keywords across Ink notebooks and PDF handwriting. Links contain the vault name and file path, so copy new links after renaming/moving the notebook or vault. Search uses open-view state and saved notes, including PDF sidecars.

Sticky notes appear in previews, Ink embeds and exported PDFs. PDF export renders Markdown text and handwriting in their current visible window/folded state; external Markdown images and dynamic embeds are excluded from the text snapshot. Page thumbnails/Ink embeds retain a plain-text overview. Offscreen content remains in the note data. Notes are stored in the `.ink` file or PDF sidecar; source PDFs are preserved. Keep a backup before downgrading to versions that do not understand sticky metadata.

Handwriting recognition is not bundled. An optional [handwriting index interface](docs/sticky-handwriting-index.md) allows another integration to provide recognized search terms. Without an integration, Ink Notes does not send handwriting anywhere or run recognition.

## Lossless handwriting storage

Ink notebooks and PDF handwriting sidecars automatically use compact JSON or gzip compression when it reduces file size. Every original sample, coordinate, pressure, tilt, timestamp and stroke style is retained: compression does not simplify handwriting or change its appearance. Images remain separate managed assets; this does not compress the original PDF, image assets or exported PDF.

Existing JSON notes still open normally and become compressed on the next normal save; opening a note alone does not rewrite it. Saving uses the same merge, deletion tombstones and atomic conflict checks. Compression runs in the existing background Worker for normal Ink/PDF saves, with a local fallback when background processing is unavailable. Search, previews and PDF export read either format. Small files remain plain JSON; larger compressed files start with `INK-GZIP-1`, followed by base64 gzip (including `.pdfink.json` files). Compressed input is integrity checked and capped at 256 MiB after decompression; larger uncompressed legacy notes remain JSON on save.

Update Ink Notes on **all devices that edit these files** before sharing compressed notes. Older versions cannot open compressed files and will report a format error. Keep a backup before downgrading; gzip/base64 decoding restores the original JSON for external recovery. Compression ratios depend on the note's data, not just the number of strokes.

## Page text boxes

In an Ink notebook or PDF, choose the toolbar's **Add text box** (T on desktop) to insert text directly on the page and start typing. Add as many independent boxes as needed. These boxes have a transparent background, with no sticky-note title bar or folded state. They use the same inline Markdown editor and font controls as sticky text: local font presets, size, bold, italic and optional **Scale text with box**. Resizing changes wrapping and the visible window; font size stays fixed unless that option is enabled.

Tap to select a box, drag with a finger to move it, and drag its selected bottom-right handle to resize. With a mouse or pen, **Pointer** selects and moves boxes; drawing tools continue handwriting on the page, including over text. Insertion selects Pointer automatically. Double-tap/double-click or **Edit text box** opens inline editing; click outside or Ctrl/Cmd+Enter to apply, Escape to cancel. Tap outside to hide the controls. Arrow keys move a focused box, Shift makes larger steps, Alt+arrows resize, Enter edits and Delete removes. Reading mode displays text without editing controls.

Text objects support undo/redo, synchronization, page previews, Ink embeds and PDF export. They reuse the existing note-object storage in the `.ink` file or PDF sidecar; the source PDF is unchanged. Right-click or long-press a box for editing, formatting, deletion and Markdown links, including paragraph ids. Enlarge a box to reveal text clipped by its saved dimensions. Typed content is included in the existing note search. Older builds may display page text as sticky cards, so keep a backup before downgrading.

## Shapes and hold to straighten

In editing mode, choose **Shapes** in either an Ink notebook or PDF, select **Line, Arrow, Rectangle, Square, Ellipse, Circle or Triangle**, then drag to draw. Shapes use the current pen color, width and opacity with uniform thickness. They are ordinary handwriting strokes: lasso selection, erasing, copy/paste, undo/redo, saving and PDF export use the existing workflow. Press **S** on desktop to reuse the last selected shape; tap Shapes again to change it. Fingers navigate unless **Use finger as pen** is enabled.

With **Pen**, draw a fairly straight stroke of at least 40 page pixels, keep the nib touching the page, and stop moving for **2 seconds**. The stroke becomes a straight line between its endpoints; keep dragging to adjust the endpoint and lift to finish. Small resting jitter is tolerated. Curves, short marks and backtracking strokes are excluded. Lifting, cancelling, changing tools/modes or losing window focus cancels a pending hold.

## Desktop navigation

New Ink/PDF tabs start in **Reading mode** on phones, small mobile screens, desktop computers and unknown devices. Large mobile tablets start in editing mode. iPad split windows keep the tablet default even when their pane is narrow. The default uses device facts once, never the live pane width. Your mode selection belongs to each tab, survives workspace restoration and stays unchanged when resizing, rotating or splitting the window. Tabs may use different modes.

Obsidian cannot reliably report whether a stylus is paired before its first contact, so tablets use the handwriting-first default even without a connected pen. Use the mode button to choose reading or editing explicitly; connecting/disconnecting a pen does not change your selection.

Mouse wheel and two-finger trackpad scrolling first move within the current page. At the top/bottom boundary, continued scrolling by about 100 pixels changes to the previous/next page. Horizontal trackpad scrolling and **Shift+wheel** follow the same rule at the left/right boundary. Returning vertically to the previous page lands at its bottom; moving forward lands at the top. Pixel, line and page wheel units are supported.

Decaying trackpad inertia is limited to one page per gesture. Reverse direction, pause briefly, or start a renewed flick after its tail to continue navigating. Navigation requests during animations or saves are combined into the latest destination instead of dropped. **PageUp/PageDown**, **Home/End** and **Alt+Left/Right** navigate; **Ctrl/Cmd+wheel**, **+/-** and **0** zoom/reset. **Space+drag** or middle-button drag pans in editing mode; left drag pans in reading mode. Text fields and nested scroll panels keep their own interaction.

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

## Privacy and storage

Ink Notes does not send notes, diagnostics or usage data to a server, and requires no account or payment. It does not make network requests or read files outside your vault. Notebook files live in `Ink Notes/`; PDF handwriting sidecars live in `A_pdfinkwrittern/`. Cross-device sync is provided by your chosen vault sync service, not by Ink Notes. Diagnostics exports are local and may contain handwriting records; review them before sharing.

## PDF plugin compatibility

Ink Notes keeps its handwriting in a separate view and sidecar; it never replaces the source PDF. In compatibility mode, native PDF extensions (including PDF++, Jot, PDF Writer, translators, readers and annotation tools in the audited list) retain their normal viewer automatically. Ink Notes first honors the user's handwriting preference for ordinary opens. PDF navigation/search/selection state is forwarded to the native viewer. Handwriting remains available through **Open current PDF with handwriting** and the PDF file context menu, and **Return current PDF tab to the built-in viewer** saves ink before handing the tab back.

Native text-layer extensions operate in the native viewer, while Ink Notes editing operates in its own tab. This does not combine independent annotation formats or guarantee compatibility among third-party plugins themselves. If another tool changes the source PDF revision, reopen it to check the sidecar; export refuses to apply old ink coordinates to different source bytes.

The [compatibility audit](docs/pdf-plugin-compatibility.md), [283-plugin inventory](docs/pdf-plugin-inventory.md), and [pinned source evidence](docs/pdf-plugin-compatibility.json) distinguish source inspection from real Obsidian validation. The automatic takeover setting remains available for plugins outside the audited list.

## Build

```bash
npm ci
npm run typecheck
npm run build
```

## License and attribution

Ink Notes is licensed under [Apache-2.0](LICENSE). The bundled stroke model is adapted from Google's [`ink-stroke-modeler`](THIRD-PARTY-NOTICES.md) and retains its Apache-2.0 attribution. Bundled dependencies retain their respective licenses; see [third-party notices](THIRD-PARTY-NOTICES.md).
