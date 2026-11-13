import { getStrokeBounds } from "./model";
import type { InkPage, InkPoint, InkStroke } from "./model";
import { drawInkStroke, drawInkStrokePreview, STROKE_WIDTH_REFERENCE } from "./rendering";

export interface RenderTileResult {
  pageId: string;
  cell: string;
  density: number;
  revision: number;
  x: number;
  y: number;
  width: number;
  height: number;
  renderGeneration: number;
  canvasWidth: number;
  canvasHeight: number;
  bitmap: ImageBitmap;
}

export interface RenderBackend {
  renderTile(pageId: string, cell: string, density: number, revision: number, width: number, height: number,
    renderGeneration?: number, priority?: "visible" | "prewarm", excludedStrokeIds?: readonly string[],
    candidateStrokeIds?: readonly string[]): Promise<RenderTileResult>;
  cancelGeneration?(renderGeneration: number): void;
  dispose(): void;
}

export interface Rect { x: number; y: number; width: number; height: number }
export interface TilePrewarmPage {
  page: InkPage;
  width: number;
  height: number;
  viewport: Rect;
  density: number;
}
const TILE = 128;
// Bleed is measured in logical page pixels. Keeping it independent from
// backing density prevents high-DPR tiles from exposing seams at boundaries.
const BLEED = 4;
const FIRST_FRAME_PREVIEW_STROKE_LIMIT = 64;
const MAX_PIXELS = 16_000_000;
const MAX_TILE_DENSITY = 9;

interface IndexedStroke {
  stroke: InkStroke;
  points: InkPoint[];
  count: number;
  revision: number;
  order: number;
  // Style snapshots as scalars: sync() compares them per stroke per frame, so
  // the check must detect in-place mutation (same stroke reference, edited
  // field) without building a join key string on every pass.
  tool: string;
  color: string;
  width: number;
  opacity: number;
  cells: string[];
}

type StrokeExclusion = InkStroke | ReadonlySet<string> | null | undefined;

function isStrokeSet(exclusion: StrokeExclusion): exclusion is ReadonlySet<string> {
  return exclusion instanceof Set;
}

// Uniform grid indexing matches the tiles and preserves compositing order.
export class StrokeIndex {
  private entries = new Map<string, IndexedStroke>();
  private cells = new Map<string, Set<IndexedStroke>>();
  readonly revisions = new Map<string, number>();
  constructor(readonly width: number, readonly height: number) {}

  sync(strokes: InkStroke[], exclude?: StrokeExclusion): void {
    const retained = new Set<string>();
    strokes.forEach((stroke, order) => {
      if (stroke === exclude || isStrokeSet(exclude) && exclude.has(stroke.id)) return;
      retained.add(stroke.id);
      this.upsert(stroke, order);
    });
    for (const [id, entry] of this.entries) if (!retained.has(id)) this.removeEntry(entry);
  }

  upsert(stroke: InkStroke, order: number): string[] {
    const previous = this.entries.get(stroke.id);
    // sync() runs per stroke on every animation frame, so the unchanged
    // majority short-circuits before any allocation; the scalar snapshots
    // still catch in-place style mutation, exactly like the old join key.
    if (previous?.stroke === stroke && previous.points === stroke.points && previous.count === stroke.points.length
      && previous.revision === stroke.updatedAt
      && previous.tool === stroke.tool && previous.color === stroke.color
      && previous.width === stroke.width && previous.opacity === stroke.opacity) {
      // Compositing order is metadata, not geometry. Updating it must not
      // invalidate every later tile when an early stroke is removed.
      previous.order = order;
      return [];
    }
    if (previous) this.removeEntry(previous);
    // Renderers stamp ink at stroke.width * (width / STROKE_WIDTH_REFERENCE)
    // with a half-width ceiling of 0.65x that scaled width, so the padding
    // must scale the same way: a fixed padding leaves the rendered ink
    // overflowing wide-page indexes (uncapped PDF panes) unregistered, and
    // those cells never repaint the overflow.
    const padding = stroke.width * (this.width / STROKE_WIDTH_REFERENCE) * 0.7 + BLEED;
    const bounds = getStrokeBounds(stroke);
    let minX = bounds.minX * this.width, minY = bounds.minY * this.height;
    let maxX = bounds.maxX * this.width, maxY = bounds.maxY * this.height;
    const keys = cellKeys({ x: minX - padding, y: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 }, this.width, this.height);
    const entry = { stroke, points: stroke.points, count: stroke.points.length, revision: stroke.updatedAt, order,
      tool: stroke.tool, color: stroke.color, width: stroke.width, opacity: stroke.opacity, cells: keys };
    this.entries.set(stroke.id, entry);
    for (const key of keys) {
      if (!this.cells.has(key)) this.cells.set(key, new Set());
      this.cells.get(key)!.add(entry);
      this.bump(key);
    }
    return keys;
  }

  // Reconciliation has compared every rendering field. Advance only an index
  // that represented that exact pre-merge revision; never hide unindexed edits.
  acknowledgeMetadata(stroke: InkStroke, previousUpdatedAt: number): void {
    const entry = this.entries.get(stroke.id);
    if (entry?.stroke === stroke && entry.revision === previousUpdatedAt) entry.revision = stroke.updatedAt;
  }

  patch(upsert: readonly InkStroke[], remove: readonly string[], order: readonly InkStroke[]): string[] {
    const changed = new Set<string>();
    for (const id of remove) {
      const entry = this.entries.get(id);
      if (entry) {
        for (const cell of entry.cells) changed.add(cell);
        this.removeEntry(entry);
      }
    }
    const positions = new Map(order.map((stroke, index) => [stroke.id, index]));
    for (const stroke of upsert) {
      const previous = this.entries.get(stroke.id);
      for (const cell of previous?.cells ?? []) changed.add(cell);
      for (const cell of this.upsert(stroke, positions.get(stroke.id) ?? Number.MAX_SAFE_INTEGER)) changed.add(cell);
    }
    for (const [id, entry] of this.entries) {
      const position = positions.get(id);
      if (position !== undefined) entry.order = position;
    }
    return [...changed];
  }

  remove(ids: readonly string[]): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) this.removeEntry(entry);
    }
  }

  query(rect: Rect): InkStroke[] {
    const found = new Set<IndexedStroke>();
    for (const key of cellKeys(rect, this.width, this.height)) {
      for (const entry of this.cells.get(key) ?? []) found.add(entry);
    }
    return [...found].sort((a, b) => a.order - b.order).map(entry => entry.stroke);
  }

  queryNear(point: InkPoint, radius: number): InkStroke[] {
    return this.query({
      x: point.x * this.width - radius,
      y: point.y * this.height - radius,
      width: radius * 2,
      height: radius * 2,
    });
  }

  hasCell(cell: string): boolean { return (this.cells.get(cell)?.size ?? 0) > 0; }

  cellsFor(strokes: readonly InkStroke[]): string[] {
    const cells = new Set<string>();
    for (const stroke of strokes) for (const cell of this.entries.get(stroke.id)?.cells ?? []) cells.add(cell);
    return [...cells];
  }

  private removeEntry(entry: IndexedStroke): void {
    this.entries.delete(entry.stroke.id);
    for (const key of entry.cells) {
      const cell = this.cells.get(key);
      cell?.delete(entry);
      if (cell?.size === 0) this.cells.delete(key);
      this.bump(key);
    }
  }
  private bump(key: string): void { this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1); }
}

export function cellKeys(rect: Rect, width: number, height: number): string[] {
  if (!Number.isFinite(rect.x + rect.y + rect.width + rect.height) || rect.width <= 0 || rect.height <= 0
    || rect.x >= width || rect.y >= height || rect.x + rect.width <= 0 || rect.y + rect.height <= 0) return [];
  const keys: string[] = [];
  for (let y = Math.floor(Math.max(0, rect.y) / TILE); y < Math.ceil(Math.min(height, rect.y + rect.height) / TILE); y++) {
    for (let x = Math.floor(Math.max(0, rect.x) / TILE); x < Math.ceil(Math.min(width, rect.x + rect.width) / TILE); x++) keys.push(x + ":" + y);
  }
  return keys;
}

interface PageTiles {
  page: InkPage;
  index: StrokeIndex;
  id: number;
  syncedStrokes: InkStroke[] | null;
  syncedPageRevision: number;
}
interface Tile { node: HTMLDivElement; canvas: HTMLCanvasElement; revision: number; pixels: number; used: number; state: PageTiles; cell: string; density: number }
interface Job { state: PageTiles; cell: string; density: number; priority?: "visible" | "prewarm" }
interface InkCommit {
  state: PageTiles;
  strokes: readonly InkStroke[];
  cells: string[];
  clearCells: string[];
  jobs: Job[];
  tiles: Tile[];
  onComplete: (committed: boolean) => void;
  invalid: boolean;
  generation: number;
  // Worker renders dispatched by the batch below that have not settled yet;
  // a re-entrant scheduleInkCommit (resumeInkCommit) must not re-dispatch or
  // finish while they are outstanding.
  inFlight: number;
  // Snapshot of workerExclude at commit start: worker-rendered commit tiles
  // must skip still-pending strokes (the overlay draws them), while strokes
  // patched into the index for this commit have already left the set.
  excluded: readonly string[] | undefined;
  // History commits (undo/redo) keep no live preview layer, so each tile may
  // mount the moment its render settles. Holding them for the atomic swap
  // serializes the whole batch in front of one visible refresh, and the
  // worker renders cells one request at a time — a wide batch then reads as
  // a multi-second frozen frame on iPad instead of a cell-by-cell refresh.
  // Gesture commits (eraser/lasso) keep the swap: their preview layers must
  // not expose half-committed frames.
  progressive: boolean;
}

export function tileDensity(viewport: Rect, density: number): number {
  void viewport;
  // Tiles are small independent canvases, so a full-viewport pixel cap is not
  // needed here. Capping their density by viewport area undersampled zoomed
  // Pencil ink on high-DPR displays even though the visible logical area had
  // already shrunk with zoom. Cache eviction remains the memory bound.
  return Math.max(0.5, Math.min(MAX_TILE_DENSITY, Math.ceil(density * 4) / 4));
}

export class TileRenderer {
  private states = new Map<InkPage, PageTiles>();
  private cache = new Map<string, Tile>();
  private active: PageTiles | null = null;
  private viewport: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private density = 1;
  /** Diagnostics: current backing density vs the dpr x zoom target, so a
   *  stuck-low density (blurry zoomed page) is visible in the dev panel. */
  get currentDensity(): number { return this.density; }
  get currentDisplayScale(): number { return this.displayScale; }
  private visible = new Set<string>();
  private jobs: Job[] = [];
  private frame: number | null = null;
  private inkFrame: number | null = null;
  private inkCommit: InkCommit | null = null;
  private inkCommitPaused = false;
  // A gesture that does not pause the commit (eraser/lasso) still races the
  // worker mirror: compensating a dropped refine mid-gesture would render
  // tiles from the stale mirror at the freshly bumped revision and cache
  // them, reviving erased ink. Hold compensation until the gesture ends.
  private gestureActive = false;
  // beginInput() cancels queued full-density refine jobs so tiles never race
  // the pointer; remember that drop so resumeInkCommit() can rebuild them,
  // otherwise a page zoomed in right before a stroke stays blurry until the
  // next scroll, zoom, or page turn.
  private droppedRefine = false;
  private heldCells = new Set<string>();
  private sequence = 0;
  private pixels = 0;
  private disposed = false;
  private renderGeneration = 0;
  private backend: RenderBackend | null = null;
  private backendError: ((error: unknown) => void) | null = null;
  private pendingTiles = new Map<string, number>();
  private displayScale = 1;
  // Strokes the latest sync/setPage excluded from the main-thread index are
  // already in the worker index (complete-stroke fires at pen-up), so worker
  // tile renders must skip them too or they composite twice under the
  // retained preview overlay.
  private workerExclude: ReadonlySet<string> | undefined;
  // Retired rasters kept on screen across a same-page relayout (see
  // captureResizeGhost); ghostBaseWidth is the logical width they were
  // rasterized at, so repeat relayouts rescale the same original nodes.
  private ghost: HTMLElement | null = null;
  private ghostBaseWidth = 0;

  constructor(private host: HTMLElement) {}

  setBackend(backend: RenderBackend | null, onError?: (error: unknown) => void): void {
    this.renderGeneration += 1;
    this.backend?.cancelGeneration?.(this.renderGeneration);
    this.backend = backend;
    this.backendError = onError ?? null;
    this.jobs = [];
    this.pendingTiles.clear();
  }

  setPage(page: InkPage, width: number, height: number, exclude?: StrokeExclusion): void {
    this.renderGeneration += 1;
    this.backend?.cancelGeneration?.(this.renderGeneration);
    const state = this.state(page, width, height);
    this.pendingTiles.clear();
    // A page switch orphans the dropped refine queue: it described the
    // previous page's viewport, so the flag must not compensate here.
    this.droppedRefine = false;
    if (state !== this.active) {
      this.cancelInkCommit();
      if (this.active && this.active.page !== state.page) this.discardResizeGhost();
      this.host.replaceChildren();
      // Same-page relayout: the ghost parked by state() is the page's only
      // visible content right now and must survive the host clear.
      if (this.ghost) this.host.appendChild(this.ghost);
      this.active = state;
      this.jobs = [];
    }
    if (exclude || state.syncedStrokes !== page.strokes || state.syncedPageRevision !== page.updatedAt) {
      state.index.sync(page.strokes, exclude);
      state.syncedStrokes = exclude ? null : page.strokes;
      state.syncedPageRevision = page.updatedAt;
    }
    this.workerExclude = this.exclusionIds(exclude);
  }

  setDisplayScale(scale: number): void {
    this.displayScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    for (const tile of this.cache.values()) this.sizeTile(tile);
  }

  sync(strokes: InkStroke[], exclude?: StrokeExclusion): void {
    if (!this.active) return;
    this.active.index.sync(strokes, exclude);
    this.active.syncedStrokes = !exclude && strokes === this.active.page.strokes ? strokes : null;
    this.active.syncedPageRevision = this.active.page.updatedAt;
    this.workerExclude = this.exclusionIds(exclude);
  }

  /** Refreshes the worker-render exclusion without reconciling the index.
   *  Ink flows call it at pending-set transitions (stroke becomes preview,
   *  preview discarded, commit retried) because the per-frame sync pauses
   *  while pending ink owns the render loop. */
  setWorkerExclusion(exclude?: StrokeExclusion): void {
    this.workerExclude = this.exclusionIds(exclude);
  }

  private exclusionIds(exclude: StrokeExclusion): ReadonlySet<string> | undefined {
    if (!exclude) return undefined;
    if (isStrokeSet(exclude)) return exclude;
    return new Set([exclude.id]);
  }

  private workerExclusionSnapshot(): readonly string[] | undefined {
    return this.workerExclude ? [...this.workerExclude] : undefined;
  }

  acknowledgeStrokeMetadata(stroke: InkStroke, previousUpdatedAt: number): void {
    for (const state of this.states.values()) state.index.acknowledgeMetadata(stroke, previousUpdatedAt);
  }

  patchStrokes(upsert: readonly InkStroke[], remove: readonly string[], order: readonly InkStroke[]): string[] {
    const changed = this.active?.index.patch(upsert, remove, order) ?? [];
    // Patched strokes just entered the main-thread index, so tiles must now
    // include them; keeping them in the worker exclusion would commit tiles
    // that omit the very strokes being committed.
    if (this.workerExclude && upsert.length > 0) {
      const next = new Set(this.workerExclude);
      for (const stroke of upsert) next.delete(stroke.id);
      this.workerExclude = next.size > 0 ? next : undefined;
    }
    return changed;
  }

  removeStrokes(ids: readonly string[]): void {
    this.active?.index.remove(ids);
  }

  queryNear(point: InkPoint, radius: number): InkStroke[] {
    return this.active?.index.queryNear(point, radius) ?? [];
  }

  query(rect: Rect): InkStroke[] {
    return this.active?.index.query(rect) ?? [];
  }

  previewInteractiveCells(cells: readonly string[], viewport: Rect, density: number): void {
    if (!this.active || this.disposed || cells.length === 0) return;
    this.viewport = viewport;
    this.density = tileDensity(viewport, density);
    this.visible = new Set(cellKeys(viewport, this.active.index.width, this.active.index.height));
    for (const cell of new Set(cells)) {
      if (!this.visible.has(cell)) continue;
      if (!this.active.index.hasCell(cell)) {
        this.host.querySelector('[data-cell="' + cell + '"]')?.remove();
        continue;
      }
      const exact = this.get(this.active, cell, this.density);
      const tile = exact ?? this.paint({ state: this.active, cell, density: this.density, priority: "visible" });
      this.attach(tile);
    }
    this.evict();
  }

  flushVisible(): void {
    const jobs = this.jobs.filter(job => job.state === this.active && this.visible.has(job.cell) && !this.isHeld(job));
    this.jobs = this.jobs.filter(job => !jobs.includes(job));
    for (const job of jobs) {
      const tile = this.get(job.state, job.cell, job.density);
      if (tile) this.attach(tile);
      else if (this.backend) this.requestWorkerTile(job);
      else this.attach(this.paint(job));
    }
    this.evict();
  }

  commitInteractive(viewport: Rect, density: number, refine = true, onComplete: (committed: boolean) => void = () => undefined,
    progressive = false): void {
    this.cancelInkCommit();
    if (!this.active || this.disposed) { onComplete(false); return; }
    // Keep the previous complete frame mounted while every changed visible
    // tile is prepared. Attaching the batch only after all jobs finish avoids
    // the checkerboard/block-by-block effect during lasso and eraser commits.
    this.renderGeneration += 1;
    this.backend?.cancelGeneration?.(this.renderGeneration);
    this.viewport = viewport;
    this.density = tileDensity(viewport, refine ? density : Math.min(1, density));
    this.visible = new Set(cellKeys(viewport, this.active.index.width, this.active.index.height));
    for (const node of Array.from(this.host.children)) {
      if (node === this.ghost) continue;
      if (!this.visible.has((node as HTMLElement).dataset.cell ?? "")) node.remove();
    }
    const jobs: Job[] = [];
    const clearCells: string[] = [];
    for (const cell of this.visible) {
      if (!this.active.index.hasCell(cell)) { clearCells.push(cell); continue; }
      if (!this.get(this.active, cell, this.density)) jobs.push({ state: this.active, cell, density: this.density, priority: "visible" });
    }
    if (jobs.length === 0) {
      for (const cell of clearCells) this.host.querySelector('[data-cell="' + cell + '"]')?.remove();
      onComplete(true);
      return;
    }
    const cells = jobs.map((job) => job.cell);
    for (const cell of cells) this.heldCells.add(this.holdKey(this.active, cell));
    this.jobs = this.jobs.filter(job => !this.isHeld(job));
    this.inkCommit = { state: this.active, strokes: [], cells, clearCells, jobs, tiles: [], onComplete,
      invalid: false, generation: this.renderGeneration, inFlight: 0, excluded: this.workerExclusionSnapshot(),
      progressive };
    this.scheduleInkCommit();
  }

  commitInk(strokes: readonly InkStroke[], viewport: Rect, density: number, onComplete: (committed: boolean) => void): void {
    if (!this.active || this.disposed || this.inkCommit) { onComplete(false); return; }
    this.viewport = viewport;
    this.density = tileDensity(viewport, density);
    this.visible = new Set(cellKeys(viewport, this.active.index.width, this.active.index.height));
    const cells = this.active.index.cellsFor(strokes).filter(cell => this.visible.has(cell));
    const jobs: Job[] = [];
    const tiles: Tile[] = [];
    for (const cell of cells) {
      this.heldCells.add(this.holdKey(this.active, cell));
      const exact = this.get(this.active, cell, this.density);
      if (exact) tiles.push(exact);
      else jobs.push({ state: this.active, cell, density: this.density });
    }
    this.jobs = this.jobs.filter(job => !this.isHeld(job));
    this.inkCommit = { state: this.active, strokes, cells, clearCells: [], jobs, tiles, onComplete, invalid: false,
      generation: this.renderGeneration, inFlight: 0, excluded: this.workerExclusionSnapshot(), progressive: false };
    if (jobs.length === 0) this.finishInkCommit(true);
    else this.scheduleInkCommit();
  }

  pauseInkCommit(): void {
    this.inkCommitPaused = true;
    // beginInput() already invalidates ordinary tile jobs and advances the
    // render generation. Avoid posting a second cancellation for the same
    // pointerdown; only the coherent ink transaction still needs pausing.
    if (this.inkFrame !== null) cancelAnimationFrame(this.inkFrame);
    this.inkFrame = null;
    if (this.inkCommit) this.abortInkCommit(true);
  }

  beginInput(): void {
    // Interactive commits park their jobs on the commit itself, not on the
    // ordinary queue below, so a live commit counts as dropped refine work.
    this.droppedRefine ||= this.jobs.length > 0 || this.pendingTiles.size > 0 || !!this.inkCommit;
    this.renderGeneration += 1;
    this.backend?.cancelGeneration?.(this.renderGeneration);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.jobs = [];
    this.pendingTiles.clear();
    this.gestureActive = true;
  }

  resumeInkCommit(): void {
    this.inkCommitPaused = false;
    this.gestureActive = false;
    // Consume the flag only when the rebuild can actually run: an eraser
    // gesture that erased nothing never replaces an in-flight interactive
    // commit, and clearing the flag here would swallow the refine work
    // until finishInkCommit() settles the commit and compensates.
    if (this.droppedRefine && this.active && !this.disposed && !this.inkCommit) {
      this.droppedRefine = false;
      this.update(this.viewport, this.density, true);
    }
    this.scheduleInkCommit();
    this.schedule();
  }

  cancelInkCommit(): void { this.abortInkCommit(true); }

  update(viewport: Rect, density: number, refine: boolean): void {
    if (!this.active || this.disposed) return;
    const nextDensity = tileDensity(viewport, density);
    const sameDensity = this.density === nextDensity;
    const visible = new Set(cellKeys(viewport, this.active.index.width, this.active.index.height));
    const sameVisible = visible.size === this.visible.size && [...visible].every(cell => this.visible.has(cell));
    this.viewport = viewport;
    // Density is budgeted against the visible region, never the full page.
    this.density = nextDensity;
    this.visible = visible;
    // Once every visible cell holds its fresh raster the relayout's refill is
    // done; any ghost nodes left cover cells the viewport no longer shows.
    if (this.ghost && sameDensity && sameVisible && this.visibleCurrent()) this.discardResizeGhost();
    // Scrolling within the current tile range only changes the viewport crop.
    // Keep both mounted tiles and in-flight tile jobs; rebuilding the queue on
    // every scroll event repeatedly cancels work and remounts the same frame.
    if (!refine && sameDensity && sameVisible) return;
    // Refine callers run every animation frame while a render loop is active.
    // Once the frame is settled, content edits are the only remaining trigger,
    // and they advance the cell revision so the exact-cache probe below fails;
    // skipping the rebuild then also keeps queued prewarm jobs alive instead
    // of clearing and re-deriving them every frame.
    if (sameDensity && sameVisible && this.visibleCurrent()) return;
    this.jobs = [];
    const mountedCells = new Set(Array.from(this.host.children, (node) => (node as HTMLElement).dataset.cell ?? ""));
    for (const node of Array.from(this.host.children)) {
      if (node === this.ghost) continue;
      const cell = (node as HTMLElement).dataset.cell ?? "";
      if (!this.visible.has(cell) || !this.active.index.hasCell(cell)) node.remove();
    }
    let immediatePreviewPainted = false;
    for (const cell of this.visible) {
      if (!this.active.index.hasCell(cell)) continue;
      const exact = this.get(this.active, cell, this.density);
      const fallback = exact ?? this.fallback(this.active, cell);
      if (fallback) this.attach(fallback);
      // Paint the first visible cell even while the Worker is still opening
      // the notebook. A low-density main-thread preview makes first ink
      // independent of Worker startup; the full-density Worker tile replaces
      // it when ready. Limiting this to one cell bounds the synchronous work.
      if (!exact && !fallback && !mountedCells.has(cell) && refine && this.density >= 1 && !immediatePreviewPainted
        && typeof this.active.index.query === "function") {
        const preview = this.preview({ state: this.active, cell, density: Math.min(0.5, this.density), priority: "visible" });
        this.attach(preview);
        immediatePreviewPainted = true;
      }
      // Missing newly exposed tiles get a cheap preview during motion.
      if (!exact && (refine || !fallback)) {
        const job = { state: this.active, cell, density: refine ? this.density : Math.min(1, this.density), priority: "visible" as const };
        if (!this.isHeld(job)) this.jobs.push(job);
      }
    }
    this.schedule();
  }

  prewarm(pages: InkPage[]): void {
    if (!this.active) return;
    const { width, height } = this.active.index;
    this.prewarmPages(pages.map((page) => ({ page, width, height, viewport: this.viewport, density: this.density })));
  }

  /** Schedule neighbor tiles before a page-turn input needs to paint them. */
  prewarmPages(pages: TilePrewarmPage[]): void {
    if (!this.active) return;
    const keep = new Set([this.active.page, ...pages.map(({ page }) => page)]);
    for (const [page, state] of this.states) if (!keep.has(page)) {
      this.states.delete(page);
      for (const [key, tile] of this.cache) if (tile.state === state) this.drop(key, tile);
    }
    this.jobs = this.jobs.filter(job => keep.has(job.state.page));
    for (const request of pages) {
      const { page, width, height, viewport } = request;
      const density = tileDensity(viewport, request.density);
      const state = this.state(page, width, height);
      if (state.syncedStrokes !== page.strokes || state.syncedPageRevision !== page.updatedAt) {
        state.index.sync(page.strokes);
      }
      state.syncedStrokes = page.strokes;
      state.syncedPageRevision = page.updatedAt;
      for (const cell of cellKeys(viewport, state.index.width, state.index.height)) {
        if (!state.index.hasCell(cell)) continue;
        if (this.get(state, cell, density)) continue;
        // Repeated prewarm passes must not queue a cell twice: the schedule
        // loop drains one job per frame, so duplicates would linger behind
        // and re-render work that an earlier pass already has in flight.
        if (this.jobs.some(job => job.state === state && job.cell === cell && job.density === density)) continue;
        this.jobs.push({ state, cell, density, priority: "prewarm" });
      }
    }
    this.schedule();
  }

  /** Copy exact-density cached tiles into a page preview without re-running stroke geometry on input. */
  drawCachedPreview(request: TilePrewarmPage, context: CanvasRenderingContext2D): boolean {
    const { page, width, height, viewport } = request;
    const state = this.states.get(page);
    if (!state || state.index.width !== width || state.index.height !== height
      || state.syncedStrokes !== page.strokes || state.syncedPageRevision !== page.updatedAt) return false;
    const density = tileDensity(viewport, request.density);
    const cells = cellKeys(viewport, width, height).filter((cell) => state.index.hasCell(cell));
    const tiles = cells.map((cell) => this.get(state, cell, density));
    if (tiles.some((tile) => tile === undefined)) return false;
    for (const tile of tiles as Tile[]) {
      const [column, row] = tile.cell.split(":").map(Number);
      const x = column * TILE, y = row * TILE;
      const cellWidth = Math.min(TILE, width - x), cellHeight = Math.min(TILE, height - y);
      const bleed = Math.ceil(BLEED * tile.density);
      const sourceWidth = Math.ceil(cellWidth * tile.density), sourceHeight = Math.ceil(cellHeight * tile.density);
      context.drawImage(tile.canvas, bleed, bleed, sourceWidth, sourceHeight, x, y, cellWidth, cellHeight);
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.renderGeneration += 1;
    this.backend?.cancelGeneration?.(this.renderGeneration);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.abortInkCommit(false);
    this.discardResizeGhost();
    for (const [key, tile] of this.cache) this.drop(key, tile);
    this.states.clear(); this.jobs = []; this.pendingTiles.clear(); this.host.replaceChildren();
  }

  private state(page: InkPage, width: number, height: number): PageTiles {
    let state = this.states.get(page);
    if (!state || state.index.width !== width || state.index.height !== height) {
      if (state) {
        // Park the old rasters before the cache drop retires their nodes: the
        // relayout must not blank the page.
        this.captureResizeGhost(state.index.width, width);
        for (const [key, tile] of this.cache) if (tile.state === state) this.drop(key, tile);
      }
      state = { page, index: new StrokeIndex(width, height), id: ++this.sequence,
        syncedStrokes: null, syncedPageRevision: -1 };
      this.states.set(page, state);
    }
    return state;
  }

  /** Keeps the previous page rasters visible across a same-page relayout.
   *  Ink geometry scales linearly with the page box (normalized coordinates
   *  map through the logical width), so the retired rasters scaled by the box
   *  ratio are pixel-equivalent to the re-rendered ones - they only differ in
   *  resolution. Without this, setPage() empties the layer on every rail
   *  toggle and pane resize and the whole page visibly blanks and refills.
   *  Nodes leave the ghost as their fresh tiles mount (attach), and the ghost
   *  goes once the visible frame is complete (update). */
  private captureResizeGhost(previousWidth: number, nextWidth: number): void {
    if (!this.ghost) {
      if (previousWidth <= 0) return;
      const ghost = this.host.ownerDocument.createElement("div");
      ghost.className = "ink-tile-resize-ghost";
      for (const node of Array.from(this.host.children)) {
        if ((node as HTMLElement).dataset.cell) ghost.appendChild(node);
      }
      if (!ghost.childElementCount) return;
      ghost.style.position = "absolute";
      ghost.style.transformOrigin = "0 0";
      this.ghostBaseWidth = previousWidth;
      this.ghost = ghost;
      this.host.appendChild(ghost);
    }
    // Repeat relayouts (the rail's width animation) rescale the original
    // rasters instead of re-wrapping an already-scaled ghost.
    this.ghost.style.transform = `scale(${nextWidth / this.ghostBaseWidth})`;
  }

  private discardResizeGhost(): void {
    this.ghost?.remove();
    this.ghost = null;
  }

  private key(state: PageTiles, cell: string, density: number): string { return state.id + "/" + cell + "/" + density; }
  private get(state: PageTiles, cell: string, density: number): Tile | undefined {
    const tile = this.cache.get(this.key(state, cell, density));
    return tile?.revision === (state.index.revisions.get(cell) ?? 0) ? tile : undefined;
  }
  private fallback(state: PageTiles, cell: string): Tile | undefined {
    let best: Tile | undefined;
    for (const tile of this.cache.values()) {
      if (tile.state === state && tile.cell === cell && tile.revision === (state.index.revisions.get(cell) ?? 0)
        && (!best || Math.abs(tile.density - this.density) < Math.abs(best.density - this.density))) best = tile;
    }
    return best;
  }
  /** True when every visible cell already holds an up-to-date tile at the
   *  exact current density, so a refine pass would only re-attach identical
   *  rasters. get() revalidates the revision, so edited cells fail here, and
   *  the mount check fails after setPage(): it clears the host without
   *  resetting visible/density, so cached-but-detached tiles must rebuild. */
  private visibleCurrent(): boolean {
    if (!this.active) return false;
    for (const cell of this.visible) {
      if (!this.active.index.hasCell(cell)) {
        if (this.host.querySelector('[data-cell="' + cell + '"]')) return false;
        continue;
      }
      const tile = this.get(this.active, cell, this.density);
      if (!tile || tile.node.parentElement !== this.host) return false;
    }
    return true;
  }
  private attach(tile: Tile): void {
    if (tile.node.parentElement === this.host) { tile.used = ++this.sequence; return; }
    this.host.querySelector('[data-cell="' + tile.cell + '"]')?.remove();
    tile.used = ++this.sequence;
    this.host.appendChild(tile.node);
    if (this.ghost && !this.ghost.childElementCount) this.discardResizeGhost();
  }

  private schedule(): void {
    if (!this.jobs.length || this.disposed || this.inkCommitPaused || this.inkCommit) return;
    if (this.backend && this.frame === null) {
      const firstVisible = this.jobs.findIndex((job) => job.priority !== "prewarm");
      if (firstVisible >= 0) this.requestWorkerTile(this.jobs.splice(firstVisible, 1)[0]);
    }
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      // The worker owns a priority queue, so feed it the visible batch at once
      // instead of limiting its throughput to one request per animation frame.
      // Main-thread rasterization stays one tile per frame to bound input work.
      const limit = this.backend ? this.jobs.length : 1;
      for (let count = 0; count < limit; count++) {
        const job = this.jobs.shift();
        if (!job || this.isHeld(job)) continue;
        const tile = this.get(job.state, job.cell, job.density);
        if (tile) {
          if (job.state === this.active && this.visible.has(job.cell)) this.attach(tile);
          this.evict();
        } else if (this.backend) this.requestWorkerTile(job);
        else {
          const painted = this.paint(job);
          if (job.state === this.active && this.visible.has(job.cell)) this.attach(painted);
          this.evict();
        }
      }
      this.schedule();
    });
  }

  private scheduleInkCommit(): void {
    if (this.inkFrame !== null || !this.inkCommit || this.inkCommitPaused || this.disposed) return;
    this.inkFrame = requestAnimationFrame(() => {
      this.inkFrame = null;
      const commit = this.inkCommit;
      if (!commit) return;
      // A batch dispatched below is still rendering: re-entrant schedules
      // (resumeInkCommit) must not re-dispatch the drained queue or finish
      // the commit while its renders are outstanding.
      if (commit.inFlight > 0) return;
      if (this.backend && !this.gestureActive && commit.jobs.length > 0) {
        // Gesture-free commits (undo/redo history steps, deferred pen-up ink)
        // hold the previous frame until the whole batch lands, so pacing the
        // renders one per animation frame made every history step wait one
        // frame per affected cell before anything repainted - the reported
        // iPad undo/redo lag. The worker owns the same priority queue
        // schedule() already feeds its visible batch, so hand it the entire
        // commit at once and let the atomic swap attach when all settle.
        // A gesture keeps the paced path below: Pencil mirror operations must
        // never queue behind a burst of tile renders.
        commit.inFlight = commit.jobs.length;
        const jobs = commit.jobs.splice(0);
        for (const job of jobs) {
          const generation = this.renderGeneration;
          this.backend.renderTile(job.state.page.id, job.cell, job.density, job.state.index.revisions.get(job.cell) ?? 0,
            job.state.index.width, job.state.index.height, generation, job.priority ?? "visible", commit.excluded,
            this.candidateStrokeIds(job.state, job.cell))
            .then((result) => {
              // The commit was aborted or replaced: finishing it here would
              // release holds or fire the replacement's callback, so only the
              // stale bitmap may be closed.
              if (this.inkCommit !== commit) { result.bitmap.close(); return; }
              // Still the live commit, but beginInput()/setPage()/dispose()
              // advanced the generation while the request was in flight (the
              // worker cannot abort it). Settle as an invalid commit so
              // onComplete(false) fires, holds release, and schedule() unblocks
              // instead of stranding the commit loop until the next gesture.
              if (commit.generation !== this.renderGeneration || result.renderGeneration !== generation
                || result.pageId !== job.state.page.id || result.cell !== job.cell || this.disposed) {
                result.bitmap.close();
                this.finishInkCommit(false);
                return;
              }
              if (result.revision === (job.state.index.revisions.get(job.cell) ?? 0)) {
                const tile = this.tileFromBitmap(job, result);
                commit.tiles.push(tile);
                // Progressive history commits mount the moment their tile
                // settles (see InkCommit.progressive). finishInkCommit repeats
                // the cache/attach pair idempotently, and its invalid path
                // keeps individually settled tiles because cacheTile already
                // holds them.
                if (commit.progressive) {
                  this.cacheTile(tile);
                  if (this.visible.has(tile.cell)) this.attach(tile);
                }
              } else commit.invalid = true;
              commit.inFlight -= 1;
              if (commit.inFlight === 0) this.finishInkCommit(true);
            })
            .catch((error) => {
              if (this.inkCommit !== commit) return;
              if (isStaleRenderError(error)) { this.finishInkCommit(false); return; }
              this.backendError?.(error);
              this.finishInkCommit(false);
            });
        }
        return;
      }
      const job = commit.jobs.shift();
      if (!job) { this.finishInkCommit(true); return; }
      if (this.backend) {
        const generation = this.renderGeneration;
        this.backend.renderTile(job.state.page.id, job.cell, job.density, job.state.index.revisions.get(job.cell) ?? 0,
          job.state.index.width, job.state.index.height, generation, job.priority ?? "visible", commit.excluded,
          this.candidateStrokeIds(job.state, job.cell))
          .then((result) => {
            if (this.inkCommit !== commit) { result.bitmap.close(); return; }
            if (commit.generation !== this.renderGeneration || result.renderGeneration !== generation
              || result.pageId !== job.state.page.id || result.cell !== job.cell || this.disposed) {
              result.bitmap.close();
              this.finishInkCommit(false);
              return;
            }
            if (result.revision === (job.state.index.revisions.get(job.cell) ?? 0)) commit.tiles.push(this.tileFromBitmap(job, result));
            else commit.invalid = true;
            if (commit.jobs.length > 0) this.scheduleInkCommit();
            else this.finishInkCommit(true);
          })
          .catch((error) => {
            if (this.inkCommit === commit) {
              if (isStaleRenderError(error)) { this.finishInkCommit(false); return; }
              this.backendError?.(error);
              this.finishInkCommit(false);
            }
          });
        return;
      }
      const painted = this.createInkTile(job, commit.strokes);
      commit.tiles.push(painted);
      if (commit.progressive) {
        this.cacheTile(painted);
        if (this.visible.has(painted.cell)) this.attach(painted);
      }
      if (commit.jobs.length > 0) this.scheduleInkCommit();
      else this.finishInkCommit(true);
    });
  }

  private finishInkCommit(requested: boolean): void {
    const commit = this.inkCommit;
    if (!commit) return;
    const valid = requested && !commit.invalid && !this.disposed && this.active === commit.state
      && commit.tiles.every(tile => tile.revision === (tile.state.index.revisions.get(tile.cell) ?? 0));
    this.inkCommit = null;
    for (const cell of commit.cells) this.heldCells.delete(this.holdKey(commit.state, cell));
    if (valid) {
      for (const cell of commit.clearCells) this.host.querySelector('[data-cell="' + cell + '"]')?.remove();
      for (const tile of commit.tiles) {
        this.cacheTile(tile);
        if (this.visible.has(tile.cell)) this.attach(tile);
      }
      this.evict();
    } else {
      for (const tile of commit.tiles) if (this.cache.get(this.key(tile.state, tile.cell, tile.density)) !== tile) {
        tile.node.remove(); tile.canvas.width = tile.canvas.height = 1;
      }
    }
    commit.onComplete(valid);
    // The commit that made resumeInkCommit() defer its dropped-refine rebuild
    // has just settled; compensate now unless a pause already owns the flag
    // for the gesture's own resume (pen path), or a non-pausing gesture
    // (eraser/lasso) is mid-flight: the worker mirror still trails the locally
    // bumped cell revisions until patch-strokes lands at gesture end, so a
    // compensating tile here would cache stale mirror content and revive
    // erased ink.
    if (this.droppedRefine && this.active && !this.disposed && !this.inkCommitPaused && !this.gestureActive) {
      this.droppedRefine = false;
      this.update(this.viewport, this.density, true);
    }
    this.schedule();
  }

  private abortInkCommit(notify: boolean): void {
    const commit = this.inkCommit;
    if (!commit) { this.inkFrame = null; return; }
    if (this.inkFrame !== null) cancelAnimationFrame(this.inkFrame);
    this.inkFrame = null;
    if (notify) this.finishInkCommit(false);
    else {
      this.inkCommit = null;
      for (const cell of commit.cells) this.heldCells.delete(this.holdKey(commit.state, cell));
      for (const tile of commit.tiles) if (this.cache.get(this.key(tile.state, tile.cell, tile.density)) !== tile) {
        tile.node.remove(); tile.canvas.width = tile.canvas.height = 1;
      }
    }
  }

  private holdKey(state: PageTiles, cell: string): string { return state.id + "/" + cell; }
  private isHeld(job: Job): boolean { return this.heldCells.has(this.holdKey(job.state, job.cell)); }

  private paint(job: Job): Tile {
    const tile = this.createTile(job);
    this.cacheTile(tile);
    return tile;
  }

  private preview(job: Job): Tile {
    return this.createTileFrom(job, undefined, [], true);
  }

  private requestWorkerTile(job: Job): void {
    if (!this.backend || this.disposed) return;
    const key = this.key(job.state, job.cell, job.density);
    if (this.pendingTiles.get(key) === this.renderGeneration) return;
    const revision = job.state.index.revisions.get(job.cell) ?? 0;
    const generation = this.renderGeneration;
    this.pendingTiles.set(key, generation);
    this.backend.renderTile(job.state.page.id, job.cell, job.density, revision, job.state.index.width, job.state.index.height,
      generation, job.priority ?? "visible", this.workerExclusionSnapshot(), this.candidateStrokeIds(job.state, job.cell))
      .then((result) => {
        if (this.pendingTiles.get(key) === generation) this.pendingTiles.delete(key);
        if (this.disposed || generation !== this.renderGeneration || result.pageId !== job.state.page.id || result.cell !== job.cell) {
          result.bitmap.close();
          return;
        }
        const currentRevision = job.state.index.revisions.get(job.cell) ?? 0;
        if (result.revision !== currentRevision || result.density !== job.density || result.renderGeneration !== generation) { result.bitmap.close(); this.schedule(); return; }
        const tile = this.tileFromBitmap(job, result);
        this.cacheTile(tile);
        if (job.state === this.active && this.visible.has(job.cell)) {
          // Requests at different zoom densities may resolve out of order.
          // A late result must not replace a better raster for the current zoom.
          this.attach(this.get(job.state, job.cell, this.density) ?? this.fallback(job.state, job.cell) ?? tile);
        }
        this.evict();
        this.schedule();
      })
      .catch((error) => {
        if (this.pendingTiles.get(key) === generation) this.pendingTiles.delete(key);
        if (isStaleRenderError(error)) { this.schedule(); return; }
        this.backendError?.(error);
        this.schedule();
      });
  }

  private candidateStrokeIds(state: PageTiles, cell: string): string[] {
    const [column, row] = cell.split(":").map(Number);
    const x = column * TILE, y = row * TILE;
    return state.index.query({ x, y, width: Math.min(TILE, state.index.width - x),
      height: Math.min(TILE, state.index.height - y) }).map((stroke) => stroke.id);
  }

  private tileFromBitmap(job: Job, result: RenderTileResult): Tile {
    const canvas = document.createElement("canvas");
    canvas.width = result.canvasWidth;
    canvas.height = result.canvasHeight;
    const bitmapContext = canvas.getContext("bitmaprenderer") as ImageBitmapRenderingContext | null;
    if (bitmapContext) bitmapContext.transferFromImageBitmap(result.bitmap);
    else {
      const context = canvas.getContext("2d");
      if (context) context.drawImage(result.bitmap, 0, 0);
      result.bitmap.close();
    }
    canvas.setCssStyles({ position: "absolute" });
    const node = document.createElement("div");
    node.dataset.cell = result.cell;
    node.setCssStyles({ position: "absolute", overflow: "hidden" });
    node.appendChild(canvas);
    const tile = { node, canvas, revision: result.revision, pixels: result.canvasWidth * result.canvasHeight,
      used: ++this.sequence, state: job.state, cell: result.cell, density: result.density };
    this.sizeTile(tile);
    return tile;
  }

  private createTile(job: Job): Tile {
    return this.createTileFrom(job);
  }

  private createInkTile(job: Job, strokes: readonly InkStroke[]): Tile {
    const revision = job.state.index.revisions.get(job.cell) ?? 0;
    const additions = strokes.filter((stroke) => job.state.index.cellsFor([stroke]).includes(job.cell));
    const previous = this.cache.get(this.key(job.state, job.cell, job.density));
    // A revision advances once for every newly indexed stroke touching this
    // cell. Only use the delta path when that fully explains the difference;
    // edits/deletes/remote merges safely fall back to a complete repaint.
    const base = previous && previous.revision + additions.length === revision ? previous : undefined;
    return this.createTileFrom(job, base, additions);
  }

  private createTileFrom(job: Job, base?: Tile, additions: readonly InkStroke[] = [], preview = false): Tile {
    const { state, cell, density } = job;
    const [column, row] = cell.split(":").map(Number);
    const x = column * TILE, y = row * TILE;
    const width = Math.min(TILE, state.index.width - x), height = Math.min(TILE, state.index.height - y);
    const canvas = document.createElement("canvas");
    const bleedPixels = Math.ceil(BLEED * density);
    canvas.width = Math.ceil(width * density) + bleedPixels * 2;
    canvas.height = Math.ceil(height * density) + bleedPixels * 2;
    canvas.setCssStyles({ position: "absolute" });
    const node = document.createElement("div");
    node.dataset.cell = cell;
    node.setCssStyles({ position: "absolute", overflow: "hidden" });
    node.appendChild(canvas);
    const ctx = canvas.getContext("2d")!;
    if (base) ctx.drawImage(base.canvas, 0, 0);
    ctx.setTransform(density, 0, 0, density, bleedPixels - x * density, bleedPixels - y * density);
    // Index bounds already include the bleed; querying adjacent cells again duplicates work.
    const rect = { x, y, width, height };
    const candidates = base ? additions : state.index.query(rect);
    const strokes = preview ? samplePreviewStrokes(candidates) : candidates;
    for (const stroke of strokes) {
      if (preview) drawInkStrokePreview(ctx, stroke, state.index.width, state.index.height);
      else drawInkStroke(ctx, stroke, state.index.width, state.index.height);
    }
    const tile = { node, canvas, revision: state.index.revisions.get(cell) ?? 0, pixels: canvas.width * canvas.height,
      used: ++this.sequence, state, cell, density };
    this.sizeTile(tile);
    return tile;
  }

  private sizeTile(tile: Tile): void {
    const [column, row] = tile.cell.split(":").map(Number);
    const x = column * TILE, y = row * TILE;
    const width = Math.min(TILE, tile.state.index.width - x), height = Math.min(TILE, tile.state.index.height - y);
    const scale = this.displayScale ?? 1;
    tile.canvas.style.left = `${-BLEED * scale}px`;
    tile.canvas.style.top = `${-BLEED * scale}px`;
    tile.canvas.style.width = `${tile.canvas.width / tile.density * scale}px`;
    tile.canvas.style.height = `${tile.canvas.height / tile.density * scale}px`;
    tile.node.style.left = `${x * scale}px`;
    tile.node.style.top = `${y * scale}px`;
    tile.node.style.width = `${width * scale}px`;
    tile.node.style.height = `${height * scale}px`;
  }

  private cacheTile(tile: Tile): void {
    const { state, cell, density } = tile;
    const key = this.key(state, cell, density);
    const old = this.cache.get(key);
    if (old === tile) return;
    if (old) this.drop(key, old);
    this.cache.set(key, tile); this.pixels += tile.pixels;
  }

  private evict(): void {
    if (this.pixels <= MAX_PIXELS) return;
    for (const [key, tile] of [...this.cache].sort((a, b) => a[1].used - b[1].used)) {
      if (tile.node.parentElement === this.host) continue;
      this.drop(key, tile);
      if (this.pixels <= MAX_PIXELS) break;
    }
  }
  private drop(key: string, tile: Tile): void {
    // Rasters parked in the resize ghost stay on screen: clearing their
    // canvas or detaching their node would blank the page during a relayout.
    if (tile.node.parentElement === this.ghost) {
      this.pixels -= tile.pixels; this.cache.delete(key);
      return;
    }
    tile.node.remove(); tile.canvas.width = tile.canvas.height = 1;
    this.pixels -= tile.pixels; this.cache.delete(key);
  }
}

function isStaleRenderError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "stale-generation";
}

function samplePreviewStrokes(strokes: readonly InkStroke[]): readonly InkStroke[] {
  if (strokes.length <= FIRST_FRAME_PREVIEW_STROKE_LIMIT) return strokes;
  const sampled: InkStroke[] = [];
  const last = strokes.length - 1;
  for (let index = 0; index < FIRST_FRAME_PREVIEW_STROKE_LIMIT; index++) {
    sampled.push(strokes[Math.floor(index * last / (FIRST_FRAME_PREVIEW_STROKE_LIMIT - 1))]);
  }
  return sampled;
}
