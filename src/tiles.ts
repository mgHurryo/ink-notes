import type { InkPage, InkPoint, InkStroke } from "./model";
import { drawInkStroke } from "./rendering";

export interface Rect { x: number; y: number; width: number; height: number }
const TILE = 128;
const BLEED = 2;
const MAX_PIXELS = 16_000_000;

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
      const padding = stroke.width * 0.7 + BLEED / 0.5;
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

export class TileRenderer {
  private states = new Map<InkPage, PageTiles>();
  private cache = new Map<string, Tile>();
  private active: PageTiles | null = null;
  private viewport: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private density = 1;
  private visible = new Set<string>();
  private jobs: Job[] = [];
  private frame: number | null = null;
  private sequence = 0;
  private pixels = 0;
  private disposed = false;

  constructor(private host: HTMLElement) {}

  setPage(page: InkPage, width: number, height: number, exclude?: StrokeExclusion): void {
    const state = this.state(page, width, height);
    if (state !== this.active) {
      this.host.replaceChildren();
      this.active = state;
      this.jobs = [];
    }
    state.index.sync(page.strokes, isStrokeSet(exclude) || exclude?.tool === "pen" ? exclude : null);
  }

  sync(strokes: InkStroke[], exclude?: StrokeExclusion): void {
    this.active?.index.sync(strokes, exclude);
  }

  queryNear(point: InkPoint, radius: number): InkStroke[] {
    return this.active?.index.queryNear(point, radius) ?? [];
  }

  flushVisible(): void {
    const jobs = this.jobs.filter(job => job.state === this.active && this.visible.has(job.cell));
    this.jobs = this.jobs.filter(job => !jobs.includes(job));
    for (const job of jobs) this.attach(this.get(job.state, job.cell, job.density) ?? this.paint(job));
    this.evict();
  }

  commitInteractive(viewport: Rect, density: number, refine = true): void {
    // Make all visible content changes coherent at a bounded 1x density. A
    // second pass keeps that complete frame attached while high-density tiles
    // are refined incrementally in the background.
    this.update(viewport, Math.min(1, density), false);
    this.flushVisible();
    if (refine) this.update(viewport, density, true);
  }

  update(viewport: Rect, density: number, refine: boolean): void {
    if (!this.active || this.disposed) return;
    this.viewport = viewport;
    // Density is budgeted against the visible region, never the full page.
    this.density = Math.max(0.5, Math.min(Math.ceil(density * 4) / 4,
      Math.sqrt(8_000_000 / Math.max(1, (viewport.width + TILE * 2) * (viewport.height + TILE * 2)))));
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
      if (!exact && (refine || !fallback)) this.jobs.push({ state: this.active, cell, density: refine ? this.density : Math.min(1, this.density) });
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
    for (const [key, tile] of this.cache) this.drop(key, tile);
    this.states.clear(); this.jobs = []; this.host.replaceChildren();
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
    if (this.frame !== null || !this.jobs.length || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      // One tile per frame bounds scheduling work and gives input priority.
      const job = this.jobs.shift();
      if (job) {
        const tile = this.get(job.state, job.cell, job.density) ?? this.paint(job);
        if (job.state === this.active && this.visible.has(job.cell)) this.attach(tile);
        this.evict();
      }
      this.schedule();
    });
  }

  private paint(job: Job): Tile {
    const { state, cell, density } = job;
    const [column, row] = cell.split(":").map(Number);
    const x = column * TILE, y = row * TILE;
    const width = Math.min(TILE, state.index.width - x), height = Math.min(TILE, state.index.height - y);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * density) + BLEED * 2;
    canvas.height = Math.ceil(height * density) + BLEED * 2;
    canvas.style.cssText = "position:absolute;left:" + (-BLEED / density) + "px;top:" + (-BLEED / density)
      + "px;width:" + canvas.width / density + "px;height:" + canvas.height / density + "px";
    const node = document.createElement("div");
    node.dataset.cell = cell;
    node.style.cssText = "position:absolute;overflow:hidden;left:" + x + "px;top:" + y + "px;width:" + width + "px;height:" + height + "px";
    node.appendChild(canvas);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(density, 0, 0, density, BLEED - x * density, BLEED - y * density);
    // Index bounds already include the bleed; querying adjacent cells again duplicates work.
    const rect = { x, y, width, height };
    for (const stroke of state.index.query(rect)) drawInkStroke(ctx, stroke, state.index.width, state.index.height);
    const tile = { node, canvas, revision: state.index.revisions.get(cell) ?? 0, pixels: canvas.width * canvas.height,
      used: ++this.sequence, state, cell, density };
    const key = this.key(state, cell, density);
    const old = this.cache.get(key);
    if (old) this.drop(key, old);
    this.cache.set(key, tile); this.pixels += tile.pixels;
    return tile;
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
