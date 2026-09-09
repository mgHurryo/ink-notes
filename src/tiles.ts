import type { InkPage, InkPoint, InkStroke } from "./model";
import { drawInkStroke } from "./rendering";

export interface RenderTileResult {
  pageId: string;
  cell: string;
  density: number;
  revision: number;
  x: number;
  y: number;
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
  bitmap: ImageBitmap;
}

export interface RenderBackend {
  renderTile(pageId: string, cell: string, density: number, revision: number, width: number, height: number): Promise<RenderTileResult>;
}

export interface Rect { x: number; y: number; width: number; height: number }
const TILE = 128;
// Bleed is measured in logical page pixels. Keeping it independent from
// backing density prevents high-DPR tiles from exposing seams at boundaries.
const BLEED = 4;
const MAX_PIXELS = 16_000_000;
const MAX_TILE_DENSITY = 9;

interface IndexedStroke {
  stroke: InkStroke;
  points: InkPoint[];
  count: number;
  revision: number;
  order: number;
  style: string;
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
      const previous = this.entries.get(stroke.id);
      const style = [stroke.tool, stroke.color, stroke.width, stroke.opacity].join(":");
      if (previous?.stroke === stroke && previous.points === stroke.points && previous.count === stroke.points.length
        && previous.revision === stroke.updatedAt && previous.style === style) {
        // Compositing order is metadata, not geometry. Updating it must not
        // invalidate every later tile when an early stroke is removed.
        previous.order = order;
        return;
      }
      if (previous) this.remove(previous);
      const padding = stroke.width * 0.7 + BLEED;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of stroke.points) {
        minX = Math.min(minX, p.x * this.width); maxX = Math.max(maxX, p.x * this.width);
        minY = Math.min(minY, p.y * this.height); maxY = Math.max(maxY, p.y * this.height);
      }
      const keys = cellKeys({ x: minX - padding, y: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 }, this.width, this.height);
      const entry = { stroke, points: stroke.points, count: stroke.points.length, revision: stroke.updatedAt, order, style, cells: keys };
      this.entries.set(stroke.id, entry);
      for (const key of keys) {
        if (!this.cells.has(key)) this.cells.set(key, new Set());
        this.cells.get(key)!.add(entry);
        this.bump(key);
      }
    });
    for (const [id, entry] of this.entries) if (!retained.has(id)) this.remove(entry);
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

  cellsFor(strokes: readonly InkStroke[]): string[] {
    const cells = new Set<string>();
    for (const stroke of strokes) for (const cell of this.entries.get(stroke.id)?.cells ?? []) cells.add(cell);
    return [...cells];
  }

  private remove(entry: IndexedStroke): void {
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

interface PageTiles { page: InkPage; index: StrokeIndex; id: number }
interface Tile { node: HTMLDivElement; canvas: HTMLCanvasElement; revision: number; pixels: number; used: number; state: PageTiles; cell: string; density: number }
interface Job { state: PageTiles; cell: string; density: number }
interface InkCommit {
  state: PageTiles;
  strokes: readonly InkStroke[];
  cells: string[];
  jobs: Job[];
  tiles: Tile[];
  onComplete: (committed: boolean) => void;
  invalid: boolean;
  generation: number;
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
  private visible = new Set<string>();
  private jobs: Job[] = [];
  private frame: number | null = null;
  private inkFrame: number | null = null;
  private inkCommit: InkCommit | null = null;
  private inkCommitPaused = false;
  private heldCells = new Set<string>();
  private sequence = 0;
  private pixels = 0;
  private disposed = false;
  private renderGeneration = 0;
  private backend: RenderBackend | null = null;
  private backendError: ((error: unknown) => void) | null = null;
  private pendingTiles = new Set<string>();

  constructor(private host: HTMLElement) {}

  setBackend(backend: RenderBackend | null, onError?: (error: unknown) => void): void {
    this.backend = backend;
    this.backendError = onError ?? null;
    this.jobs = [];
    if (!backend) this.pendingTiles.clear();
  }

  setPage(page: InkPage, width: number, height: number, exclude?: StrokeExclusion): void {
    const state = this.state(page, width, height);
    if (state !== this.active) {
      this.cancelInkCommit();
      this.host.replaceChildren();
      this.active = state;
      this.jobs = [];
    }
    state.index.sync(page.strokes, exclude);
  }

  sync(strokes: InkStroke[], exclude?: StrokeExclusion): void {
    this.active?.index.sync(strokes, exclude);
  }

  queryNear(point: InkPoint, radius: number): InkStroke[] {
    return this.active?.index.queryNear(point, radius) ?? [];
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

  commitInteractive(viewport: Rect, density: number, refine = true): void {
    this.cancelInkCommit();
    // Make all visible content changes coherent at a bounded 1x density. A
    // second pass keeps that complete frame attached while high-density tiles
    // are refined incrementally in the background.
    this.update(viewport, Math.min(1, density), false);
    this.flushVisible();
    if (refine) this.update(viewport, density, true);
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
    this.inkCommit = { state: this.active, strokes, cells, jobs, tiles, onComplete, invalid: false, generation: this.renderGeneration };
    if (jobs.length === 0) this.finishInkCommit(true);
    else this.scheduleInkCommit();
  }

  pauseInkCommit(): void {
    this.renderGeneration += 1;
    this.inkCommitPaused = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    if (this.inkFrame !== null) cancelAnimationFrame(this.inkFrame);
    this.inkFrame = null;
    if (this.inkCommit) this.abortInkCommit(true);
  }

  resumeInkCommit(): void {
    this.inkCommitPaused = false;
    this.scheduleInkCommit();
    this.schedule();
  }

  cancelInkCommit(): void { this.abortInkCommit(true); }

  update(viewport: Rect, density: number, refine: boolean): void {
    if (!this.active || this.disposed) return;
    this.viewport = viewport;
    // Density is budgeted against the visible region, never the full page.
    this.density = tileDensity(viewport, density);
    this.visible = new Set(cellKeys(viewport, this.active.index.width, this.active.index.height));
    this.jobs = [];
    for (const node of Array.from(this.host.children)) {
      if (!this.visible.has((node as HTMLElement).dataset.cell ?? "")) node.remove();
    }
    for (const cell of this.visible) {
      const exact = this.get(this.active, cell, this.density);
      const fallback = exact ?? this.fallback(this.active, cell);
      if (fallback) this.attach(fallback);
      // Missing newly exposed tiles get a cheap preview during motion.
      if (!exact && (refine || !fallback)) {
        const job = { state: this.active, cell, density: refine ? this.density : Math.min(1, this.density) };
        if (!this.isHeld(job)) this.jobs.push(job);
      }
    }
    this.schedule();
  }

  prewarm(pages: InkPage[]): void {
    if (!this.active) return;
    const keep = new Set([this.active.page, ...pages]);
    for (const [page, state] of this.states) if (!keep.has(page)) {
      this.states.delete(page);
      for (const [key, tile] of this.cache) if (tile.state === state) this.drop(key, tile);
    }
    this.jobs = this.jobs.filter(job => keep.has(job.state.page));
    for (const page of pages) {
      const state = this.state(page, this.active.index.width, this.active.index.height);
      state.index.sync(page.strokes);
      // Preload only the same visible region, not entire neighboring pages.
      for (const cell of cellKeys(this.viewport, state.index.width, state.index.height)) {
        if (!this.get(state, cell, this.density)) this.jobs.push({ state, cell, density: this.density });
      }
    }
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.abortInkCommit(false);
    for (const [key, tile] of this.cache) this.drop(key, tile);
    this.states.clear(); this.jobs = []; this.pendingTiles.clear(); this.host.replaceChildren();
  }

  private state(page: InkPage, width: number, height: number): PageTiles {
    let state = this.states.get(page);
    if (!state || state.index.width !== width || state.index.height !== height) {
      if (state) for (const [key, tile] of this.cache) if (tile.state === state) this.drop(key, tile);
      state = { page, index: new StrokeIndex(width, height), id: ++this.sequence };
      state.index.sync(page.strokes);
      this.states.set(page, state);
    }
    return state;
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
  private attach(tile: Tile): void {
    if (tile.node.parentElement === this.host) { tile.used = ++this.sequence; return; }
    this.host.querySelector('[data-cell="' + tile.cell + '"]')?.remove();
    tile.used = ++this.sequence;
    this.host.appendChild(tile.node);
  }

  private schedule(): void {
    if (this.frame !== null || !this.jobs.length || this.disposed || this.inkCommitPaused || this.inkCommit) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      // One tile per frame bounds scheduling work and gives input priority.
      const job = this.jobs.shift();
      if (job && !this.isHeld(job)) {
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
      const job = commit.jobs.shift();
      if (!job) { this.finishInkCommit(true); return; }
      if (this.backend) {
        this.backend.renderTile(job.state.page.id, job.cell, job.density, job.state.index.revisions.get(job.cell) ?? 0,
          job.state.index.width, job.state.index.height)
          .then((result) => {
            if (this.inkCommit !== commit || commit.generation !== this.renderGeneration || this.disposed) { result.bitmap.close(); return; }
            if (result.revision === (job.state.index.revisions.get(job.cell) ?? 0)) commit.tiles.push(this.tileFromBitmap(job, result));
            else commit.invalid = true;
            if (commit.jobs.length > 0) this.scheduleInkCommit();
            else this.finishInkCommit(true);
          })
          .catch((error) => {
            if (this.inkCommit === commit) {
              this.backendError?.(error);
              this.finishInkCommit(false);
            }
          });
        return;
      }
      commit.tiles.push(this.createInkTile(job, commit.strokes));
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

  private requestWorkerTile(job: Job): void {
    if (!this.backend || this.disposed) return;
    const key = this.key(job.state, job.cell, job.density);
    if (this.pendingTiles.has(key)) return;
    this.pendingTiles.add(key);
    const revision = job.state.index.revisions.get(job.cell) ?? 0;
    const generation = this.renderGeneration;
    this.backend.renderTile(job.state.page.id, job.cell, job.density, revision, job.state.index.width, job.state.index.height)
      .then((result) => {
        this.pendingTiles.delete(key);
        if (this.disposed || generation !== this.renderGeneration) { result.bitmap.close(); return; }
        const currentRevision = job.state.index.revisions.get(job.cell) ?? 0;
        if (result.revision !== currentRevision || result.density !== job.density) { result.bitmap.close(); this.schedule(); return; }
        const tile = this.tileFromBitmap(job, result);
        this.cacheTile(tile);
        if (job.state === this.active && this.visible.has(job.cell)) this.attach(tile);
        this.evict();
        this.schedule();
      })
      .catch((error) => {
        this.pendingTiles.delete(key);
        this.backendError?.(error);
        this.schedule();
      });
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
    canvas.style.cssText = `position:absolute;left:${-BLEED}px;top:${-BLEED}px;width:${result.canvasWidth / result.density}px;height:${result.canvasHeight / result.density}px`;
    const node = document.createElement("div");
    node.dataset.cell = result.cell;
    node.style.cssText = `position:absolute;overflow:hidden;left:${result.x}px;top:${result.y}px;width:${result.width}px;height:${result.height}px`;
    node.appendChild(canvas);
    return { node, canvas, revision: result.revision, pixels: result.canvasWidth * result.canvasHeight,
      used: ++this.sequence, state: job.state, cell: result.cell, density: result.density };
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

  private createTileFrom(job: Job, base?: Tile, additions: readonly InkStroke[] = []): Tile {
    const { state, cell, density } = job;
    const [column, row] = cell.split(":").map(Number);
    const x = column * TILE, y = row * TILE;
    const width = Math.min(TILE, state.index.width - x), height = Math.min(TILE, state.index.height - y);
    const canvas = document.createElement("canvas");
    const bleedPixels = Math.ceil(BLEED * density);
    canvas.width = Math.ceil(width * density) + bleedPixels * 2;
    canvas.height = Math.ceil(height * density) + bleedPixels * 2;
    canvas.style.cssText = "position:absolute;left:" + (-BLEED) + "px;top:" + (-BLEED)
      + "px;width:" + canvas.width / density + "px;height:" + canvas.height / density + "px";
    const node = document.createElement("div");
    node.dataset.cell = cell;
    node.style.cssText = "position:absolute;overflow:hidden;left:" + x + "px;top:" + y + "px;width:" + width + "px;height:" + height + "px";
    node.appendChild(canvas);
    const ctx = canvas.getContext("2d")!;
    if (base) ctx.drawImage(base.canvas, 0, 0);
    ctx.setTransform(density, 0, 0, density, bleedPixels - x * density, bleedPixels - y * density);
    // Index bounds already include the bleed; querying adjacent cells again duplicates work.
    const rect = { x, y, width, height };
    const strokes = base ? additions : state.index.query(rect);
    for (const stroke of strokes) drawInkStroke(ctx, stroke, state.index.width, state.index.height);
    return { node, canvas, revision: state.index.revisions.get(cell) ?? 0, pixels: canvas.width * canvas.height,
      used: ++this.sequence, state, cell, density };
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
    tile.node.remove(); tile.canvas.width = tile.canvas.height = 1;
    this.pixels -= tile.pixels; this.cache.delete(key);
  }
}
