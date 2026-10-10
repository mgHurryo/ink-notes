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
