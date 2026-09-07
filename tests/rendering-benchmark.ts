import { canvasResolution, drawInkStroke, penOutline } from "../src/rendering";
import type { InkStroke } from "../src/model";

// Browser harness: bundle with esbuild and load in an HTML page.
const output = document.body.appendChild(document.createElement("pre"));
output.textContent = "Benchmark running...";
const makeStroke = (index: number, count = 80): InkStroke => ({
  id: String(index), pageId: "page", tool: "pen", color: "#171717", width: 3, opacity: 1, createdAt: 1, updatedAt: 1,
  points: Array.from({ length: count }, (_, i) => ({
    x: 0.03 + (index % 10) * 0.09 + i / count * 0.075,
    y: 0.03 + (Math.floor(index / 10) % 100) * 0.009 + Math.sin(i / count * Math.PI * 3) * 0.007,
    pressure: 0.5 + 0.3 * Math.sin(i / count * Math.PI), t: i,
  })),
});

function legacy(ctx: CanvasRenderingContext2D, stroke: InkStroke, w: number, h: number): void {
  ctx.save();
  ctx.globalAlpha = stroke.opacity;
  ctx.strokeStyle = stroke.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1], b = stroke.points[i], p = stroke.points[Math.max(0, i - 2)];
    const start = i === 1 ? a : { x: (p.x + a.x) / 2, y: (p.y + a.y) / 2 };
    const end = i === stroke.points.length - 1 ? b : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    ctx.lineWidth = stroke.width * (0.55 + (a.pressure + b.pressure) * 0.375);
    ctx.beginPath();
    ctx.moveTo(start.x * w, start.y * h);
    ctx.quadraticCurveTo(a.x * w, a.y * h, end.x * w, end.y * h);
    ctx.stroke();
  }
  ctx.restore();
}

const results: object[] = [];
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function run(): Promise<void> {
  const previewOnly = new URLSearchParams(location.search).has("preview");
  for (const count of (previewOnly ? [] : [100, 500, 1000])) {
    for (const zoom of [1, 3]) {
      for (const mode of ["legacy", "outline"]) {
        const strokes = Array.from({ length: count }, (_, i) => makeStroke(i));
        const canvas = document.createElement("canvas");
        const res = mode === "outline" ? canvasResolution(820, 1180, 2, zoom) : { width: 820 * Math.min(4, 2 * zoom), height: 1180 * Math.min(4, 2 * zoom) };
        canvas.width = res.width; canvas.height = res.height;
        const ctx = canvas.getContext("2d", { willReadFrequently: false })!;
        ctx.setTransform(res.width / 820, 0, 0, res.height / 1180, 0, 0);
        const times: number[] = [];
        for (let iteration = 0; iteration < 9; iteration++) {
          await frame();
          const start = performance.now();
          ctx.clearRect(0, 0, 820, 1180);
          for (const stroke of strokes) (mode === "outline" ? drawInkStroke : legacy)(ctx, stroke, 820, 1180);
          // Force queued raster work to finish. Readback adds overhead, so these are not pure GPU timings.
          ctx.getImageData(0, 0, 1, 1);
          times.push(performance.now() - start);
        }
        const warm = times.slice(2).sort((a, b) => a - b);
        results.push({ count, points: count * 80, zoom, mode, pixels: res.width * res.height,
          coldMs: +times[0].toFixed(2), medianMs: +warm[3].toFixed(2), maxMs: +warm[6].toFixed(2) });
        canvas.width = canvas.height = 1;
        output.textContent = JSON.stringify(results, null, 2);
      }
    }
  }
  for (const count of [1000, 10000]) {
    const stroke = makeStroke(0, count);
    const start = performance.now();
    for (let i = 0; i < 30; i++) penOutline(stroke, 820, 1180);
    results.push({ activeStrokePoints: count, geometryMs: +((performance.now() - start) / 30).toFixed(2) });
  }
  for (const zoom of [1, 3]) {
    const canvas = document.createElement("canvas");
    const res = canvasResolution(820, 1180, 2, zoom);
    canvas.width = res.width; canvas.height = res.height;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(res.width / 820, 0, 0, res.height / 1180, 0, 0);
    const ink = makeStroke(0, 1000);
    const times: number[] = [];
    for (let i = 0; i < 22; i++) {
      await frame();
      ink.points.push({ ...ink.points[ink.points.length - 1], x: 0.11 + i * 0.001 });
      const start = performance.now();
      ctx.clearRect(0, 0, 820, 1180);
      drawInkStroke(ctx, ink, 820, 1180);
      ctx.getImageData(0, 0, 1, 1);
      times.push(performance.now() - start);
    }
    const warm = times.slice(2).sort((a, b) => a - b);
    results.push({ previewPoints: ink.points.length, zoom, medianMs: +warm[10].toFixed(2), p95Ms: +warm[18].toFixed(2) });
    canvas.width = canvas.height = 1;
  }
  output.textContent = "DONE\n" + JSON.stringify(results, null, 2);
}

const preview = document.body.appendChild(document.createElement("div"));
for (const zoom of [0.5, 1, 2, 3]) {
  const label = preview.appendChild(document.createElement("div"));
  label.textContent = String(zoom * 100) + "%: old / new";
  for (const renderer of [legacy, drawInkStroke]) {
    const canvas = preview.appendChild(document.createElement("canvas"));
    const res = canvasResolution(220, 100, devicePixelRatio, zoom);
    canvas.width = res.width; canvas.height = res.height;
    canvas.style.width = String(220 * zoom) + "px";
    canvas.style.height = String(100 * zoom) + "px";
    canvas.style.display = "block";
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(res.width / 220, 0, 0, res.height / 100, 0, 0);
    const stroke = makeStroke(0, 250);
    stroke.opacity = 0.55;
    stroke.points = stroke.points.map((p, i) => ({ ...p, x: 0.08 + i / 250 * 0.84, y: 0.5 + 0.24 * Math.sin(i / 250 * Math.PI * 5) }));
    renderer(ctx, stroke, 220, 100);
  }
}
void run();
