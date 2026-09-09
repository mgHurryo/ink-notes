import { TileRenderer, StrokeIndex } from "../src/tiles";
import type { InkPage } from "../src/model";

document.body.style.cssText = "margin:0;background:#eee;font:14px sans-serif";
const output = document.body.appendChild(document.createElement("pre"));
const controls = document.body.appendChild(document.createElement("div"));
const scroller = document.body.appendChild(document.createElement("div"));
scroller.style.cssText = "height:600px;width:min(100%,900px);overflow:auto;background:white";
const page = scroller.appendChild(document.createElement("div"));
page.style.cssText = "position:relative;width:820px;height:1180px;transform-origin:top left";
const host = page.appendChild(document.createElement("div"));
const renderer = new TileRenderer(host);
const data: InkPage = { id: "page", title: "test", paper: "blank", createdAt: 1, updatedAt: 1, deletedStrokeIds: [],
  strokes: Array.from({ length: 1000 }, (_, s) => ({ id: String(s), pageId: "page", tool: "pen", color: s % 3 ? "#171717" : "#2563eb", width: 2, opacity: 1, createdAt: 1, updatedAt: 1,
    points: Array.from({ length: 80 }, (_, i) => ({ x: 0.01 + s % 10 * 0.095 + i / 80 * 0.08,
      y: 0.01 + Math.floor(s / 10) * 0.0095 + Math.sin(i / 80 * Math.PI * 3) * 0.003, pressure: 0.5, t: i })) })) };
// A continuous semi-transparent stroke crossing several tile edges.
data.strokes.push({ ...data.strokes[0], id: "cross", width: 6, opacity: 0.5,
  points: Array.from({ length: 400 }, (_, i) => ({ x: i / 400, y: 0.5 + Math.sin(i / 400 * Math.PI * 4) * 0.2, pressure: 0.5, t: i })) });
let zoom = 1;
function update(refine: boolean): void {
  renderer.update({ x: scroller.scrollLeft / zoom, y: scroller.scrollTop / zoom,
    width: Math.min(820, scroller.clientWidth / zoom), height: Math.min(1180, scroller.clientHeight / zoom) }, devicePixelRatio * zoom, refine);
}
renderer.setPage(data, 820, 1180);
update(true);
for (const value of [0.5, 1, 2, 3]) {
  const button = controls.appendChild(document.createElement("button"));
  button.textContent = value * 100 + "%";
  button.onclick = () => { zoom = value; page.style.transform = "scale(" + zoom + ")"; update(false); setTimeout(() => update(true), 100); };
}
const remove = controls.appendChild(document.createElement("button"));
remove.textContent = "Remove crossing stroke";
remove.onclick = () => {
  data.strokes.pop();
  renderer.sync(data.strokes);
  renderer.commitInteractive({ x: scroller.scrollLeft / zoom, y: scroller.scrollTop / zoom,
    width: Math.min(820, scroller.clientWidth / zoom), height: Math.min(1180, scroller.clientHeight / zoom) }, devicePixelRatio * zoom);
};
let timer: ReturnType<typeof setTimeout>;
scroller.onscroll = () => { update(false); clearTimeout(timer); timer = setTimeout(() => update(true), 100); };
async function benchmark(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 700));
  const results: object[] = [];
  const index = new StrokeIndex(820, 1180);
  let start = performance.now(); index.sync(data.strokes);
  results.push({ indexBuildMs: +(performance.now() - start).toFixed(2) });
  const times: number[] = [];
  for (let i = 0; i < 100; i++) {
    start = performance.now(); index.query({ x: 128, y: 128, width: 128, height: 128 });
    times.push(performance.now() - start);
  }
  results.push({ queryAverageMs: +(times.reduce((a, b) => a + b) / times.length).toFixed(3),
    localCandidates: index.query({ x: 128, y: 128, width: 128, height: 128 }).length, totalStrokes: data.strokes.length });
  const internal = renderer as any;
  for (const density of [2, 6]) {
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      await new Promise(requestAnimationFrame);
      start = performance.now();
      const tile = internal.paint({ state: internal.active, cell: "1:1", density });
      tile.canvas.getContext("2d").getImageData(0, 0, 1, 1);
      times.push(performance.now() - start);
    }
    const warm = times.slice(2).sort((a, b) => a - b);
    results.push({ density, tileMedianMs: +warm[5].toFixed(2), tileMaxMs: +warm[9].toFixed(2) });
  }
  update(true);
  await new Promise(resolve => setTimeout(resolve, 1400));
  const canvases = Array.from(host.querySelectorAll("canvas"));
  let inkPixels = 0;
  for (const canvas of canvases) {
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) inkPixels++;
  }
  results.push({ visibleTiles: canvases.length, inkPixels, cachedPixels: internal.pixels });
  const snapshot = () => new Map(Array.from(host.querySelectorAll<HTMLDivElement>("[data-cell]")).map(node =>
    [node.dataset.cell, node.querySelector("canvas")!.toDataURL()]));
  const before = snapshot();
  const crossing = data.strokes.pop()!;
  renderer.sync(data.strokes); renderer.commitInteractive({ x: 0, y: 0, width: 820, height: 600 }, devicePixelRatio * zoom);
  const deleted = snapshot();
  let changedTiles = 0;
  for (const [cell, pixels] of deleted) if (before.get(cell) !== pixels) changedTiles++;
  data.strokes.push(crossing);
  renderer.sync(data.strokes); renderer.commitInteractive({ x: 0, y: 0, width: 820, height: 600 }, devicePixelRatio * zoom);
  const restored = snapshot();
  const restoredExactly = [...before].every(([cell, pixels]) => restored.get(cell) === pixels);
  results.push({ deletionChangedTiles: changedTiles, undoRestoredExactly: restoredExactly });
  output.textContent = JSON.stringify(results, null, 2);
}
void benchmark();
