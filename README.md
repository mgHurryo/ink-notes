# Ink Notes

Ink Notes is a cross-platform handwritten notebook plugin for Obsidian. It stores notebooks as JSON files inside the Vault under `Ink Notes/`, so Obsidian Sync and other Vault sync tools can replicate the same pages and strokes to Windows, macOS, Linux, iOS, and iPadOS.

Ink Notes is licensed under Apache-2.0. The bundled stroke model is adapted from Google's `ink-stroke-modeler` and retains its Apache-2.0 attribution. Other bundled dependencies retain their original licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Install and enable

Ink Notes requires Obsidian 1.5.7 or later for view-scoped keyboard shortcuts.

Install Ink Notes from the [Obsidian Community directory](https://community.obsidian.md/plugins/ink-notes), or open **Settings -> Community plugins -> Browse**, search for **Ink Notes**, and select **Install**. Then enable it in **Settings -> Community plugins -> Installed plugins**. Installation and enabling are separate steps.

For manual installation, download `main.js`, `manifest.json` and `styles.css` from the [latest GitHub release](https://github.com/mgHurryo/ink-notes/releases/latest), place them in `.obsidian/plugins/ink-notes/` inside your vault, reload Obsidian, then enable **Ink Notes** in **Settings -> Community plugins**. Existing installations with the old higher version numbers need a manual reinstall of 0.1.0.

If you installed the withdrawn initial 0.1.2 package, manually replace all three plugin files with the corrected 0.1.2 release and restart Obsidian. The version number is unchanged, so an automatic update check may report that you are already up to date.

## Start a notebook or PDF

- For a native notebook, select the pen icon in the ribbon or run **Ink Notes: Open Ink Notebook** from the command palette. The picker can create, open and rename notebooks. **Ink Notes: Create Ink Notebook** creates one directly.
- For a PDF, open the PDF, then run **Ink Notes: Open current PDF with handwriting** from the command palette. This opens a separate Ink Notes tab. You can also right-click the PDF in the file explorer, or open its file context menu on mobile, and choose **Open PDF with Ink Notes handwriting**. The command palette and file menu are alternatives to the editor's three-dot menu.
- Assign a hotkey to **Open current PDF with handwriting** in **Settings -> Hotkeys** for quicker access.
- In the handwriting view, use **Editing** for writing and erasing, or **Reading** for navigation without drawing. Export creates a PDF copy with handwriting; the source PDF is preserved.

### Why does a PDF still open in the default viewer?

Choose **Settings -> Ink Notes -> PDF handwriting -> Default PDF viewer**. **Ink Notes first** opens ordinary PDFs in handwriting even when PDF++ is enabled. Focus flags, empty link fragments and native viewport memory added during ordinary file opens do not override this choice. **Compatibility mode** automatically chooses the native viewer when a supported PDF extension is enabled; it is the default for a fresh installation. **Native PDF viewer** disables automatic handwriting opens. Existing checked **Take over PDF tabs automatically** settings migrate to **Ink Notes first**; unchecked settings migrate to **Native PDF viewer**. Changing the mode does not convert tabs already open, so close and reopen the PDF or use the explicit handwriting command.

In compatibility mode, Ink Notes deliberately keeps the native PDF viewer when a supported viewer extension such as PDF++, Jot or PDF Writer is enabled. This lets its text selection, links, highlighting and other native-view features continue working. Page/search/selection links and other navigation state keep the native viewer in every mode so their destinations are preserved.

To use both workflows, keep the other plugin enabled and choose **Ink Notes first** or open an Ink Notes handwriting tab explicitly. Native-view extensions and Ink Notes use separate views; their annotations and tools are not combined into a single viewer. You can return from an Ink Notes tab with **Ink Notes: Return current PDF tab to the built-in viewer**; that tab retains your native-viewer choice.

If the explicit command is missing, check that Ink Notes is enabled in this vault and reload it. If an unknown plugin still intercepts the explicit opening, temporarily disable that plugin to isolate the conflict, then [report an issue](https://github.com/mgHurryo/ink-notes/issues) with plugin names, versions and the opening steps. Compatibility with every plugin combination is not guaranteed.

## Features

- Pointer Events input for pen, mouse, and touch-capable WebViews.
- Pressure-aware pen strokes with tilt values retained in the file and adjustable smoothing for cleaner everyday handwriting.
- Real-time pen and highlighter previews, including long strokes that cross render tiles.
- Stroke, circular, and square erasers with an always-visible aiming outline and adjustable local-eraser size.
- Paper templates, a collapsible page rail, page creation, duplication, deletion, reordering, rename, and zoom.
- Undo and redo for drawing, erasing, lasso moves, cut/paste/delete, and page operations.
- Lasso selection, constrained on-page movement, and a floating Copy / Cut / Delete / Paste menu that stays inside the current editor pane.
- A single compact 56px responsive toolbar with tool settings in an accessible popover and no duplicate offscreen controls.
- Atomic Vault writes with stroke and page tombstones so deleted content stays deleted during cross-device merges.
- Read-only Markdown `ink` code-block embeds with optional page targeting.
- No native dependency, so the plugin is packaged once for all Obsidian platforms.

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

### Sticky notes

Choose **Add sticky note** to place a note directly on the current Ink/PDF page. Use the document toolbar's pen, highlighter, eraser and lasso on it immediately. A stroke crossing its edge is split: the inside part belongs to the sticky, and the outside part belongs to the document. Undo/redo treats that gesture as one edit. Existing page ink remains on the page when a sticky is placed over it.

Drag anywhere on a note's title to move it with a finger or mouse, including a folded label. Drag its bottom-right corner to resize. Pen contacts on the title or resize handle do not move the note unless **Pointer** is selected. No coordinates or percentage fields are needed. Resizing crops/extends the visible window without stretching handwriting or reflowing its saved text layout. **Pointer** lets you drag the content inside an expanded note to reach more of its unbounded board; Alt+wheel also scrolls inside it. Switch back to your writing tool to continue writing anywhere on the note or document. New notes are staggered, and overlapping cards keep a stable creation order: editing an older note does not unexpectedly raise it over newer notes.

Use **Type on sticky note** or double-tap/double-click its content area, including empty space, to edit Markdown directly on the card. Finger double-tap editing is disabled when **Use finger as pen** is enabled; use the typing button/menu instead. Click outside (or Ctrl/Cmd+Enter) to apply the text; Escape cancels the text draft. Double-tap/double-click the title to rename it. Text and handwriting share the board; handwriting is drawn over typed content. The note's **…** menu contains typing, renaming, folding, links, keywords, colors, folded preview and deletion. Narrow frames move typing and, when necessary, folding into this menu to keep the title and options accessible. Long-press the title or right-click the card to open the same menu; clicking **…** again closes it. Text edited in another pane cannot silently overwrite an open draft.

Use the note's **+ / Add text box** button (also in **…**) to add multiple independent Markdown boxes. Drag a box with a finger to position it, double-tap it to edit, and drag its selected corner to resize. Selected boxes expose move, edit and delete buttons; tap outside to hide them. With a mouse or Pencil, choose **Pointer** to move a box by its content; drawing tools still write over it. Keyboard users can focus a box and use arrows to move, Shift+arrows for larger steps, Alt+arrows to resize, Enter to edit and Delete to remove it. Each box has its own saved layout, search text and paragraph links. Resizing a box changes text wrapping and its visible window without modifying its text or handwriting. Old note text remains the first box; deleting any box supports undo/redo.

**Fold** makes a compact label, optionally with a content preview. Tap its title/preview or **Expand** to restore the same frame dimensions. Long-press or right-click the label/preview to copy its Markdown link. Add a Markdown paragraph id such as `^definition-1` to typed content; the same menu offers a link to that paragraph. External links open the exact file, page and sticky inline; paragraph links highlight their target. Reading mode permits temporary folding/expansion without saving changes.

Use **Ink Notes: Find sticky notes** to search titles, typed text and manual keywords across Ink notebooks and PDF handwriting. Links contain the vault name and file path, so copy new links after renaming/moving the notebook or vault. Search uses open-view state and saved notes, including PDF sidecars.

Sticky notes appear in previews, Ink embeds and exported PDFs. PDF export renders Markdown text and handwriting in their current visible window/folded state; external Markdown images and dynamic embeds are excluded from the text snapshot. Page thumbnails/Ink embeds retain a plain-text overview. Offscreen content remains in the note data. Notes are stored in the `.ink` file or PDF sidecar; source PDFs are preserved. Keep a backup before downgrading to versions that do not understand sticky metadata.

Handwriting recognition is not bundled. An optional [handwriting index interface](docs/sticky-handwriting-index.md) allows another integration to provide recognized search terms. Without an integration, Ink Notes does not send handwriting anywhere or run recognition.

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
npm install
npm run typecheck
npm run build
```
