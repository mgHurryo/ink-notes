// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { StrokeIndex, TileRenderer } from "../src/tiles";
import type { InkPage } from "../src/model";

/** The rail toggle and pane resizes change the page box, so setPage() retires
 *  every raster of the page. The resize ghost keeps those retired rasters on
 *  screen (uniformly scaled: ink geometry is linear in the box width) until
 *  each fresh tile mounts, so the page never visibly blanks and refills. */
describe("resize ghost", () => {
  const page = { id: "page", strokes: [], updatedAt: 1 } as unknown as InkPage;

  function makeRenderer(host: HTMLElement): any {
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      host, ghost: null, ghostBaseWidth: 0, states: new Map(), sequence: 0,
      renderGeneration: 0, backend: null, pendingTiles: new Map(), droppedRefine: false,
      cache: new Map(), active: null, workerExclude: undefined, cancelInkCommit: vi.fn(),
    });
    return renderer;
  }

  it("keeps the previous rasters mounted and scaled across a same-page relayout", () => {
    const host = document.createElement("div");
    const renderer = makeRenderer(host);
    renderer.setPage(page, 800, 1143);
    const painted = document.createElement("div");
    painted.dataset.cell = "0:0";
    host.appendChild(painted);

    // Same page, smaller box: what a rail toggle does to the page column.
    renderer.setPage(page, 624, 891);

    const ghost = renderer.ghost as HTMLDivElement;
    expect(host.querySelector(".ink-tile-resize-ghost")).toBe(ghost);
    expect(ghost.querySelector("[data-cell='0:0']")).toBe(painted);
    expect(ghost.style.transform).toBe("scale(0.78)");
    expect(ghost.style.transformOrigin).toBe("0 0");
  });

  it("hands each cell to its fresh tile and drops the ghost when it empties", () => {
    const host = document.createElement("div");
    const renderer = makeRenderer(host);
    renderer.setPage(page, 800, 1143);
    for (const cell of ["0:0", "1:0"]) {
      const node = document.createElement("div");
      node.dataset.cell = cell;
      host.appendChild(node);
    }
    renderer.setPage(page, 624, 891);
    expect(renderer.ghost.childElementCount).toBe(2);

    const fresh = document.createElement("div");
    fresh.dataset.cell = "0:0";
    renderer.attach({ node: fresh, cell: "0:0" });
    expect(renderer.ghost).not.toBeNull();
    expect(host.querySelector("[data-cell='0:0']")).toBe(fresh);

    const freshNeighbour = document.createElement("div");
    freshNeighbour.dataset.cell = "1:0";
    renderer.attach({ node: freshNeighbour, cell: "1:0" });
    expect(renderer.ghost).toBeNull();
  });

  it("survives update sweeps and clears once the fresh visible frame is complete", () => {
    const host = document.createElement("div");
    const ghost = document.createElement("div");
    const stale = document.createElement("div");
    stale.dataset.cell = "3:3";
    const current = document.createElement("div");
    current.dataset.cell = "0:0";
    host.append(ghost, stale, current);
    const renderer = makeRenderer(host);
    renderer.ghost = ghost;
    renderer.ghostBaseWidth = 256;
    renderer.active = { id: 1, page, index: new StrokeIndex(256, 256) };
    renderer.density = 1;
    renderer.visible = new Set(["0:0"]);
    renderer.viewport = { x: 0, y: 0, width: 100, height: 100 };
    const tile = { node: current, revision: 0 };
    renderer.get = vi.fn(() => tile);
    renderer.attach = vi.fn();
    renderer.schedule = vi.fn();

    // A viewport change sweeps nodes outside the visible cells; the ghost is
    // not a tile and must survive the sweep.
    renderer.update({ x: 0, y: 0, width: 300, height: 100 }, 1, false);
    expect(host.contains(ghost)).toBe(true);
    expect(host.contains(stale)).toBe(false);
    expect(host.contains(current)).toBe(false);

    // With the viewport settled back on cells whose fresh rasters are all
    // mounted, the refill is complete and the ghost goes.
    renderer.visible = new Set(["0:0"]);
    renderer.update({ x: 0, y: 0, width: 100, height: 100 }, 1, false);
    expect(renderer.ghost).toBeNull();
  });

  it("discards the ghost when the view switches pages", () => {
    const host = document.createElement("div");
    const renderer = makeRenderer(host);
    renderer.setPage(page, 800, 1143);
    const node = document.createElement("div");
    node.dataset.cell = "0:0";
    host.appendChild(node);
    renderer.setPage(page, 624, 891);
    expect(renderer.ghost).not.toBeNull();

    const other = { id: "other", strokes: [], updatedAt: 1 } as unknown as InkPage;
    renderer.setPage(other, 624, 891);
    expect(renderer.ghost).toBeNull();
    expect(host.querySelector(".ink-tile-resize-ghost")).toBeNull();
  });
});
