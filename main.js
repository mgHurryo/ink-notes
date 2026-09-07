var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => InkNotesPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/view.ts
var import_obsidian = require("obsidian");

// src/model.ts
var DEFAULT_PAGE_WIDTH = 1600;
var DEFAULT_PAGE_HEIGHT = 2200;
function newId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
function createNotebook(title = "Ink Notebook") {
  const now = Date.now();
  return {
    schema: 1,
    title,
    pageWidth: DEFAULT_PAGE_WIDTH,
    pageHeight: DEFAULT_PAGE_HEIGHT,
    pages: [createPage("Page 1", "ruled", now)],
    updatedAt: now
  };
}
function createPage(title, paper = "ruled", now = Date.now()) {
  return { id: newId("page"), title, paper, strokes: [], deletedStrokeIds: [], createdAt: now, updatedAt: now };
}
function normalizeNotebook(value) {
  if (!value || typeof value !== "object") return createNotebook();
  const raw = value;
  const pages = Array.isArray(raw.pages) ? raw.pages : [];
  return {
    schema: 1,
    title: typeof raw.title === "string" ? raw.title : "Ink Notebook",
    pageWidth: finitePositive(raw.pageWidth, DEFAULT_PAGE_WIDTH),
    pageHeight: finitePositive(raw.pageHeight, DEFAULT_PAGE_HEIGHT),
    pages: pages.map(normalizePage).filter((page) => page !== null),
    updatedAt: finitePositive(raw.updatedAt, Date.now())
  };
}
function mergeNotebooks(base, incoming) {
  const pages = /* @__PURE__ */ new Map();
  for (const page of base.pages) pages.set(page.id, page);
  for (const page of incoming.pages) {
    const existing = pages.get(page.id);
    pages.set(page.id, existing ? mergePages(existing, page) : page);
  }
  const ordered = [...pages.values()].sort((a2, b2) => a2.createdAt - b2.createdAt);
  return {
    ...incoming,
    title: incoming.updatedAt >= base.updatedAt ? incoming.title : base.title,
    pageWidth: incoming.pageWidth || base.pageWidth,
    pageHeight: incoming.pageHeight || base.pageHeight,
    pages: ordered.length ? ordered : [createPage("Page 1")],
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt)
  };
}
function mergePages(base, incoming) {
  var _a, _b;
  const strokes = /* @__PURE__ */ new Map();
  for (const stroke of base.strokes) strokes.set(stroke.id, stroke);
  for (const stroke of incoming.strokes) {
    const existing = strokes.get(stroke.id);
    if (!existing || stroke.updatedAt >= existing.updatedAt) strokes.set(stroke.id, stroke);
  }
  const deletedStrokeIds = [.../* @__PURE__ */ new Set([...(_a = base.deletedStrokeIds) != null ? _a : [], ...(_b = incoming.deletedStrokeIds) != null ? _b : []])];
  for (const id of deletedStrokeIds) strokes.delete(id);
  return {
    ...base,
    ...incoming,
    title: incoming.updatedAt >= base.updatedAt ? incoming.title : base.title,
    paper: incoming.updatedAt >= base.updatedAt ? incoming.paper : base.paper,
    strokes: [...strokes.values()].sort((a2, b2) => a2.createdAt - b2.createdAt),
    deletedStrokeIds,
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt)
  };
}
function normalizePage(value) {
  if (!value || typeof value !== "object") return null;
  const raw = value;
  const strokes = Array.isArray(raw.strokes) ? raw.strokes : [];
  const deletedStrokeIds = Array.isArray(raw.deletedStrokeIds) ? raw.deletedStrokeIds.filter((id) => typeof id === "string") : [];
  const deleted = new Set(deletedStrokeIds);
  return {
    id: typeof raw.id === "string" ? raw.id : newId("page"),
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    paper: isPaperStyle(raw.paper) ? raw.paper : "ruled",
    strokes: strokes.map(normalizeStroke).filter((stroke) => stroke !== null && !deleted.has(stroke.id)),
    deletedStrokeIds,
    createdAt: finitePositive(raw.createdAt, Date.now()),
    updatedAt: finitePositive(raw.updatedAt, Date.now())
  };
}
function normalizeStroke(value) {
  if (!value || typeof value !== "object") return null;
  const raw = value;
  if (typeof raw.id !== "string" || typeof raw.pageId !== "string") return null;
  const points = Array.isArray(raw.points) ? raw.points : [];
  return {
    id: raw.id,
    pageId: raw.pageId,
    tool: raw.tool === "highlighter" ? "highlighter" : "pen",
    color: typeof raw.color === "string" ? raw.color : "#1b1b1b",
    width: finitePositive(raw.width, 3),
    opacity: clamp(finitePositive(raw.opacity, 1), 0.05, 1),
    points: points.map(normalizePoint).filter((point) => point !== null),
    createdAt: finitePositive(raw.createdAt, Date.now()),
    updatedAt: finitePositive(raw.updatedAt, Date.now())
  };
}
function normalizePoint(value) {
  if (!value || typeof value !== "object") return null;
  const raw = value;
  if (typeof raw.x !== "number" || typeof raw.y !== "number") return null;
  return {
    x: clamp(raw.x, 0, 1),
    y: clamp(raw.y, 0, 1),
    pressure: clamp(typeof raw.pressure === "number" ? raw.pressure : 0.5, 0.05, 1),
    tiltX: typeof raw.tiltX === "number" ? raw.tiltX : void 0,
    tiltY: typeof raw.tiltY === "number" ? raw.tiltY : void 0,
    t: finitePositive(raw.t, Date.now())
  };
}
function finitePositive(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function isPaperStyle(value) {
  return value === "blank" || value === "ruled" || value === "grid" || value === "dot";
}

// node_modules/perfect-freehand/dist/esm/index.mjs
var { PI: e } = Math;
var t = e + 1e-4;
var n = 0.5;
var r = [1, 1];
function i(e2, t2, n2, r2 = (e3) => e3) {
  return e2 * r2(0.5 - t2 * (0.5 - n2));
}
var { min: a } = Math;
function o(e2, t2, n2) {
  let r2 = a(1, t2 / n2);
  return a(1, e2 + (a(1, 1 - r2) - e2) * (r2 * 0.275));
}
function s(e2) {
  return [-e2[0], -e2[1]];
}
function c(e2, t2) {
  return [e2[0] + t2[0], e2[1] + t2[1]];
}
function l(e2, t2, n2) {
  return e2[0] = t2[0] + n2[0], e2[1] = t2[1] + n2[1], e2;
}
function u(e2, t2) {
  return [e2[0] - t2[0], e2[1] - t2[1]];
}
function d(e2, t2, n2) {
  return e2[0] = t2[0] - n2[0], e2[1] = t2[1] - n2[1], e2;
}
function f(e2, t2) {
  return [e2[0] * t2, e2[1] * t2];
}
function p(e2, t2, n2) {
  return e2[0] = t2[0] * n2, e2[1] = t2[1] * n2, e2;
}
function m(e2, t2) {
  return [e2[0] / t2, e2[1] / t2];
}
function h(e2) {
  return [e2[1], -e2[0]];
}
function g(e2, t2) {
  let n2 = t2[0];
  return e2[0] = t2[1], e2[1] = -n2, e2;
}
function ee(e2, t2) {
  return e2[0] * t2[0] + e2[1] * t2[1];
}
function _(e2, t2) {
  return e2[0] === t2[0] && e2[1] === t2[1];
}
function v(e2) {
  return Math.hypot(e2[0], e2[1]);
}
function y(e2, t2) {
  let n2 = e2[0] - t2[0], r2 = e2[1] - t2[1];
  return n2 * n2 + r2 * r2;
}
function b(e2) {
  return m(e2, v(e2));
}
function x(e2, t2) {
  return Math.hypot(e2[1] - t2[1], e2[0] - t2[0]);
}
function S(e2, t2, n2) {
  let r2 = Math.sin(n2), i2 = Math.cos(n2), a2 = e2[0] - t2[0], o2 = e2[1] - t2[1], s2 = a2 * i2 - o2 * r2, c2 = a2 * r2 + o2 * i2;
  return [s2 + t2[0], c2 + t2[1]];
}
function C(e2, t2, n2, r2) {
  let i2 = Math.sin(r2), a2 = Math.cos(r2), o2 = t2[0] - n2[0], s2 = t2[1] - n2[1], c2 = o2 * a2 - s2 * i2, l2 = o2 * i2 + s2 * a2;
  return e2[0] = c2 + n2[0], e2[1] = l2 + n2[1], e2;
}
function w(e2, t2, n2) {
  return c(e2, f(u(t2, e2), n2));
}
function te(e2, t2, n2, r2) {
  let i2 = n2[0] - t2[0], a2 = n2[1] - t2[1];
  return e2[0] = t2[0] + i2 * r2, e2[1] = t2[1] + a2 * r2, e2;
}
function T(e2, t2, n2) {
  return c(e2, f(t2, n2));
}
var E = [0, 0];
var D = [0, 0];
var O = [0, 0];
function k(e2, n2) {
  let r2 = T(e2, b(h(u(e2, c(e2, [1, 1])))), -n2), i2 = [], a2 = 1 / 13;
  for (let n3 = a2; n3 <= 1; n3 += a2) i2.push(S(r2, e2, t * 2 * n3));
  return i2;
}
function A(e2, n2, r2) {
  let i2 = [], a2 = 1 / r2;
  for (let r3 = a2; r3 <= 1; r3 += a2) i2.push(S(n2, e2, t * r3));
  return i2;
}
function j(e2, t2, n2) {
  let r2 = u(t2, n2), i2 = f(r2, 0.5), a2 = f(r2, 0.51);
  return [u(e2, i2), u(e2, a2), c(e2, a2), c(e2, i2)];
}
function M(e2, n2, r2, i2) {
  let a2 = [], o2 = T(e2, n2, r2), s2 = 1 / i2;
  for (let n3 = s2; n3 < 1; n3 += s2) a2.push(S(o2, e2, t * 3 * n3));
  return a2;
}
function ne(e2, t2, n2) {
  return [c(e2, f(t2, n2)), c(e2, f(t2, n2 * 0.99)), u(e2, f(t2, n2 * 0.99)), u(e2, f(t2, n2))];
}
function N(e2, t2, n2) {
  return e2 === false || e2 === void 0 ? 0 : e2 === true ? Math.max(t2, n2) : e2;
}
function re(e2, t2, n2) {
  return e2.slice(0, 10).reduce((e3, r2) => {
    let i2 = r2.pressure;
    return t2 && (i2 = o(e3, r2.distance, n2)), (e3 + i2) / 2;
  }, e2[0].pressure);
}
function P(e2, n2 = {}) {
  let { size: r2 = 16, smoothing: a2 = 0.5, thinning: f2 = 0.5, simulatePressure: m2 = true, easing: _2 = (e3) => e3, start: v2 = {}, end: b2 = {}, last: x2 = false } = n2, { cap: S2 = true, easing: w2 = (e3) => e3 * (2 - e3) } = v2, { cap: T2 = true, easing: P2 = (e3) => --e3 * e3 * e3 + 1 } = b2;
  if (e2.length === 0 || r2 <= 0) return [];
  let F2 = e2[e2.length - 1].runningLength, I2 = N(v2.taper, r2, F2), L2 = N(b2.taper, r2, F2), R2 = (r2 * a2) ** 2, z = [], B = [], V = re(e2, m2, r2), H = i(r2, f2, e2[e2.length - 1].pressure, _2), U, W = e2[0].vector, G = e2[0].point, K = G, q = G, J = K, Y = false;
  for (let n3 = 0; n3 < e2.length; n3++) {
    let { pressure: a3 } = e2[n3], { point: s2, vector: h2, distance: v3, runningLength: b3 } = e2[n3], x3 = n3 === e2.length - 1;
    if (!x3 && F2 - b3 < 3) continue;
    f2 ? (m2 && (a3 = o(V, v3, r2)), H = i(r2, f2, a3, _2)) : H = r2 / 2, U === void 0 && (U = H);
    let S3 = b3 < I2 ? w2(b3 / I2) : 1, T3 = F2 - b3 < L2 ? P2((F2 - b3) / L2) : 1;
    H = Math.max(0.01, H * Math.min(S3, T3));
    let k2 = (x3 ? e2[n3] : e2[n3 + 1]).vector, A2 = x3 ? 1 : ee(h2, k2), j2 = ee(h2, W) < 0 && !Y, M2 = A2 !== null && A2 < 0;
    if (j2 || M2) {
      g(E, W), p(E, E, H);
      for (let e3 = 0; e3 <= 1; e3 += 0.07692307692307693) d(D, s2, E), C(D, D, s2, t * e3), q = [D[0], D[1]], z.push(q), l(O, s2, E), C(O, O, s2, t * -e3), J = [O[0], O[1]], B.push(J);
      G = q, K = J, M2 && (Y = true);
      continue;
    }
    if (Y = false, x3) {
      g(E, h2), p(E, E, H), z.push(u(s2, E)), B.push(c(s2, E));
      continue;
    }
    te(E, k2, h2, A2), g(E, E), p(E, E, H), d(D, s2, E), q = [D[0], D[1]], (n3 <= 1 || y(G, q) > R2) && (z.push(q), G = q), l(O, s2, E), J = [O[0], O[1]], (n3 <= 1 || y(K, J) > R2) && (B.push(J), K = J), V = a3, W = h2;
  }
  let X = [e2[0].point[0], e2[0].point[1]], Z = e2.length > 1 ? [e2[e2.length - 1].point[0], e2[e2.length - 1].point[1]] : c(e2[0].point, [1, 1]), Q = [], $ = [];
  if (e2.length === 1) {
    if (!(I2 || L2) || x2) return k(X, U || H);
  } else {
    I2 || L2 && e2.length === 1 || (S2 ? Q.push(...A(X, B[0], 13)) : Q.push(...j(X, z[0], B[0])));
    let t2 = h(s(e2[e2.length - 1].vector));
    L2 || I2 && e2.length === 1 ? $.push(Z) : T2 ? $.push(...M(Z, t2, H, 29)) : $.push(...ne(Z, t2, H));
  }
  return z.concat($, B.reverse(), Q);
}
var F = [0, 0];
function I(e2) {
  return e2 != null && e2 >= 0;
}
function L(e2, t2 = {}) {
  var _a;
  let { streamline: i2 = 0.5, size: a2 = 16, last: o2 = false } = t2;
  if (e2.length === 0) return [];
  let s2 = 0.15 + (1 - i2) * 0.85, l2 = Array.isArray(e2[0]) ? e2 : e2.map(({ x: e3, y: t3, pressure: r2 = n }) => [e3, t3, r2]);
  if (l2.length === 2) {
    let e3 = l2[1];
    l2 = l2.slice(0, -1);
    for (let t3 = 1; t3 < 5; t3++) l2.push(w(l2[0], e3, t3 / 4));
  }
  l2.length === 1 && (l2 = [...l2, [...c(l2[0], r), ...l2[0].slice(2)]]);
  let u2 = [{ point: [l2[0][0], l2[0][1]], pressure: I(l2[0][2]) ? l2[0][2] : 0.25, vector: [...r], distance: 0, runningLength: 0 }], f2 = false, p2 = 0, m2 = u2[0], h2 = l2.length - 1;
  for (let e3 = 1; e3 < l2.length; e3++) {
    let t3 = o2 && e3 === h2 ? [l2[e3][0], l2[e3][1]] : w(m2.point, l2[e3], s2);
    if (_(m2.point, t3)) continue;
    let r2 = x(t3, m2.point);
    if (p2 += r2, e3 < h2 && !f2) {
      if (p2 < a2) continue;
      f2 = true;
    }
    d(F, m2.point, t3), m2 = { point: t3, pressure: I(l2[e3][2]) ? l2[e3][2] : n, vector: b(F), distance: r2, runningLength: p2 }, u2.push(m2);
  }
  return u2[0].vector = ((_a = u2[1]) == null ? void 0 : _a.vector) || [0, 0], u2;
}
function R(e2, t2 = {}) {
  return P(L(e2, t2), t2);
}

// src/rendering.ts
var paths = /* @__PURE__ */ new WeakMap();
function canvasResolution(width, height, dpr, zoom, maxPixels = 16e6) {
  const scale = Math.min(dpr * zoom, 8192 / width, 8192 / height, Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
function penOutline(stroke, width, height) {
  return R(stroke.points.map((point) => [point.x * width, point.y * height, point.pressure]), {
    // Preserve the existing diameter: width * (0.55 + pressure * 0.75).
    size: stroke.width * 0.925,
    thinning: 0.75 / 1.85,
    simulatePressure: false,
    streamline: 0,
    smoothing: 0.35,
    last: true,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 }
  });
}
function drawInkStroke(ctx, stroke, width, height) {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.globalAlpha = stroke.opacity;
  ctx.fillStyle = stroke.color;
  ctx.strokeStyle = stroke.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalCompositeOperation = stroke.tool === "highlighter" ? "multiply" : "source-over";
  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    const diameter = stroke.tool === "highlighter" ? stroke.width : stroke.width * (0.55 + point.pressure * 0.75);
    ctx.beginPath();
    ctx.arc(point.x * width, point.y * height, diameter / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (stroke.tool === "highlighter") {
    ctx.lineWidth = stroke.width;
    drawSmoothPath(ctx, stroke.points, width, height);
    ctx.stroke();
  } else {
    let cached = paths.get(stroke);
    if (!cached || cached.points !== stroke.points || cached.count !== stroke.points.length || cached.updatedAt !== stroke.updatedAt || cached.size !== stroke.width || cached.width !== width || cached.height !== height) {
      cached = {
        points: stroke.points,
        count: stroke.points.length,
        updatedAt: stroke.updatedAt,
        size: stroke.width,
        width,
        height,
        path: createPenPath(stroke, width, height)
      };
      paths.set(stroke, cached);
    }
    ctx.fill(cached.path);
  }
  ctx.restore();
}
function createPenPath(stroke, width, height) {
  const path = new Path2D();
  const outline = penOutline(stroke, width, height);
  if (outline.length > 0) {
    const first = outline[0];
    const last = outline[outline.length - 1];
    path.moveTo((last[0] + first[0]) / 2, (last[1] + first[1]) / 2);
    for (let index = 0; index < outline.length; index++) {
      const point = outline[index];
      const next = outline[(index + 1) % outline.length];
      path.quadraticCurveTo(point[0], point[1], (point[0] + next[0]) / 2, (point[1] + next[1]) / 2);
    }
    path.closePath();
  }
  return path;
}
function drawSmoothPath(ctx, points, width, height) {
  ctx.beginPath();
  ctx.moveTo(points[0].x * width, points[0].y * height);
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const point = points[index];
    const end = index === points.length - 1 ? point : { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
    ctx.quadraticCurveTo(previous.x * width, previous.y * height, end.x * width, end.y * height);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x * width, last.y * height);
}

// src/tiles.ts
var TILE = 128;
var BLEED = 2;
var MAX_PIXELS = 16e6;
var StrokeIndex = class {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.entries = /* @__PURE__ */ new Map();
    this.cells = /* @__PURE__ */ new Map();
    this.revisions = /* @__PURE__ */ new Map();
  }
  sync(strokes, exclude) {
    const retained = /* @__PURE__ */ new Set();
    strokes.forEach((stroke, order) => {
      if (stroke === exclude) return;
      retained.add(stroke.id);
      const previous = this.entries.get(stroke.id);
      const style = [stroke.tool, stroke.color, stroke.width, stroke.opacity].join(":");
      if ((previous == null ? void 0 : previous.stroke) === stroke && previous.points === stroke.points && previous.count === stroke.points.length && previous.revision === stroke.updatedAt && previous.order === order && previous.style === style) return;
      if (previous) this.remove(previous);
      const padding = stroke.width * 0.7 + BLEED / 0.5;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p2 of stroke.points) {
        minX = Math.min(minX, p2.x * this.width);
        maxX = Math.max(maxX, p2.x * this.width);
        minY = Math.min(minY, p2.y * this.height);
        maxY = Math.max(maxY, p2.y * this.height);
      }
      const keys = cellKeys({ x: minX - padding, y: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 }, this.width, this.height);
      const entry = { stroke, points: stroke.points, count: stroke.points.length, revision: stroke.updatedAt, order, style, cells: keys };
      this.entries.set(stroke.id, entry);
      for (const key of keys) {
        if (!this.cells.has(key)) this.cells.set(key, /* @__PURE__ */ new Set());
        this.cells.get(key).add(entry);
        this.bump(key);
      }
    });
    for (const [id, entry] of this.entries) if (!retained.has(id)) this.remove(entry);
  }
  query(rect) {
    var _a;
    const found = /* @__PURE__ */ new Set();
    for (const key of cellKeys(rect, this.width, this.height)) {
      for (const entry of (_a = this.cells.get(key)) != null ? _a : []) found.add(entry);
    }
    return [...found].sort((a2, b2) => a2.order - b2.order).map((entry) => entry.stroke);
  }
  remove(entry) {
    this.entries.delete(entry.stroke.id);
    for (const key of entry.cells) {
      const cell = this.cells.get(key);
      cell == null ? void 0 : cell.delete(entry);
      if ((cell == null ? void 0 : cell.size) === 0) this.cells.delete(key);
      this.bump(key);
    }
  }
  bump(key) {
    var _a;
    this.revisions.set(key, ((_a = this.revisions.get(key)) != null ? _a : 0) + 1);
  }
};
function cellKeys(rect, width, height) {
  if (!Number.isFinite(rect.x + rect.y + rect.width + rect.height) || rect.width <= 0 || rect.height <= 0 || rect.x >= width || rect.y >= height || rect.x + rect.width <= 0 || rect.y + rect.height <= 0) return [];
  const keys = [];
  for (let y2 = Math.floor(Math.max(0, rect.y) / TILE); y2 < Math.ceil(Math.min(height, rect.y + rect.height) / TILE); y2++) {
    for (let x2 = Math.floor(Math.max(0, rect.x) / TILE); x2 < Math.ceil(Math.min(width, rect.x + rect.width) / TILE); x2++) keys.push(x2 + ":" + y2);
  }
  return keys;
}
var TileRenderer = class {
  constructor(host) {
    this.host = host;
    this.states = /* @__PURE__ */ new Map();
    this.cache = /* @__PURE__ */ new Map();
    this.active = null;
    this.viewport = { x: 0, y: 0, width: 1, height: 1 };
    this.density = 1;
    this.visible = /* @__PURE__ */ new Set();
    this.jobs = [];
    this.frame = null;
    this.sequence = 0;
    this.pixels = 0;
    this.disposed = false;
  }
  setPage(page, width, height, exclude) {
    const state = this.state(page, width, height);
    if (state !== this.active) {
      this.host.replaceChildren();
      this.active = state;
      this.jobs = [];
    }
    state.index.sync(page.strokes, (exclude == null ? void 0 : exclude.tool) === "pen" ? exclude : null);
  }
  sync(strokes, exclude) {
    var _a;
    (_a = this.active) == null ? void 0 : _a.index.sync(strokes, exclude);
  }
  flushVisible() {
    var _a;
    const jobs = this.jobs.filter((job) => job.state === this.active && this.visible.has(job.cell));
    this.jobs = this.jobs.filter((job) => !jobs.includes(job));
    for (const job of jobs) this.attach((_a = this.get(job.state, job.cell, job.density)) != null ? _a : this.paint(job));
    this.evict();
  }
  update(viewport, density, refine) {
    var _a;
    if (!this.active || this.disposed) return;
    this.viewport = viewport;
    this.density = Math.max(0.5, Math.min(
      Math.ceil(density * 4) / 4,
      Math.sqrt(8e6 / Math.max(1, (viewport.width + TILE * 2) * (viewport.height + TILE * 2)))
    ));
    this.visible = new Set(cellKeys(viewport, this.active.index.width, this.active.index.height));
    this.jobs = [];
    for (const node of Array.from(this.host.children)) {
      if (!this.visible.has((_a = node.dataset.cell) != null ? _a : "")) node.remove();
    }
    for (const cell of this.visible) {
      const exact = this.get(this.active, cell, this.density);
      const fallback = exact != null ? exact : this.fallback(this.active, cell);
      if (fallback) this.attach(fallback);
      if (!exact && (refine || !fallback)) this.jobs.push({ state: this.active, cell, density: refine ? this.density : Math.min(1, this.density) });
    }
    this.schedule();
  }
  prewarm(pages) {
    if (!this.active) return;
    const keep = /* @__PURE__ */ new Set([this.active.page, ...pages]);
    for (const [page, state] of this.states) if (!keep.has(page)) {
      this.states.delete(page);
      for (const [key, tile] of this.cache) if (tile.state === state) this.drop(key, tile);
    }
    this.jobs = this.jobs.filter((job) => keep.has(job.state.page));
    for (const page of pages) {
      const state = this.state(page, this.active.index.width, this.active.index.height);
      state.index.sync(page.strokes);
      for (const cell of cellKeys(this.viewport, state.index.width, state.index.height)) {
        if (!this.get(state, cell, this.density)) this.jobs.push({ state, cell, density: this.density });
      }
    }
    this.schedule();
  }
  dispose() {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    for (const [key, tile] of this.cache) this.drop(key, tile);
    this.states.clear();
    this.jobs = [];
    this.host.replaceChildren();
  }
  state(page, width, height) {
    let state = this.states.get(page);
    if (!state || state.index.width !== width || state.index.height !== height) {
      if (state) {
        for (const [key, tile] of this.cache) if (tile.state === state) this.drop(key, tile);
      }
      state = { page, index: new StrokeIndex(width, height), id: ++this.sequence };
      state.index.sync(page.strokes);
      this.states.set(page, state);
    }
    return state;
  }
  key(state, cell, density) {
    return state.id + "/" + cell + "/" + density;
  }
  get(state, cell, density) {
    var _a;
    const tile = this.cache.get(this.key(state, cell, density));
    return (tile == null ? void 0 : tile.revision) === ((_a = state.index.revisions.get(cell)) != null ? _a : 0) ? tile : void 0;
  }
  fallback(state, cell) {
    var _a;
    let best;
    for (const tile of this.cache.values()) {
      if (tile.state === state && tile.cell === cell && tile.revision === ((_a = state.index.revisions.get(cell)) != null ? _a : 0) && (!best || Math.abs(tile.density - this.density) < Math.abs(best.density - this.density))) best = tile;
    }
    return best;
  }
  attach(tile) {
    var _a;
    if (tile.node.parentElement === this.host) {
      tile.used = ++this.sequence;
      return;
    }
    (_a = this.host.querySelector('[data-cell="' + tile.cell + '"]')) == null ? void 0 : _a.remove();
    tile.used = ++this.sequence;
    this.host.appendChild(tile.node);
  }
  schedule() {
    if (this.frame !== null || !this.jobs.length || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      var _a;
      this.frame = null;
      const job = this.jobs.shift();
      if (job) {
        const tile = (_a = this.get(job.state, job.cell, job.density)) != null ? _a : this.paint(job);
        if (job.state === this.active && this.visible.has(job.cell)) this.attach(tile);
        this.evict();
      }
      this.schedule();
    });
  }
  paint(job) {
    var _a;
    const { state, cell, density } = job;
    const [column, row] = cell.split(":").map(Number);
    const x2 = column * TILE, y2 = row * TILE;
    const width = Math.min(TILE, state.index.width - x2), height = Math.min(TILE, state.index.height - y2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(width * density) + BLEED * 2;
    canvas.height = Math.ceil(height * density) + BLEED * 2;
    canvas.style.cssText = "position:absolute;left:" + -BLEED / density + "px;top:" + -BLEED / density + "px;width:" + canvas.width / density + "px;height:" + canvas.height / density + "px";
    const node = document.createElement("div");
    node.dataset.cell = cell;
    node.style.cssText = "position:absolute;overflow:hidden;left:" + x2 + "px;top:" + y2 + "px;width:" + width + "px;height:" + height + "px";
    node.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(density, 0, 0, density, BLEED - x2 * density, BLEED - y2 * density);
    const rect = { x: x2, y: y2, width, height };
    for (const stroke of state.index.query(rect)) drawInkStroke(ctx, stroke, state.index.width, state.index.height);
    const tile = {
      node,
      canvas,
      revision: (_a = state.index.revisions.get(cell)) != null ? _a : 0,
      pixels: canvas.width * canvas.height,
      used: ++this.sequence,
      state,
      cell,
      density
    };
    const key = this.key(state, cell, density);
    const old = this.cache.get(key);
    if (old) this.drop(key, old);
    this.cache.set(key, tile);
    this.pixels += tile.pixels;
    return tile;
  }
  evict() {
    if (this.pixels <= MAX_PIXELS) return;
    for (const [key, tile] of [...this.cache].sort((a2, b2) => a2[1].used - b2[1].used)) {
      if (tile.node.parentElement === this.host) continue;
      this.drop(key, tile);
      if (this.pixels <= MAX_PIXELS) break;
    }
  }
  drop(key, tile) {
    tile.node.remove();
    tile.canvas.width = tile.canvas.height = 1;
    this.pixels -= tile.pixels;
    this.cache.delete(key);
  }
};

// src/view.ts
var VIEW_TYPE_INK = "ink-notes-view";
var INK_COLORS = [
  { value: "#1b1b1b", label: "Black" },
  { value: "#2563eb", label: "Blue" },
  { value: "#dc2626", label: "Red" },
  { value: "#15803d", label: "Green" },
  { value: "#ca8a04", label: "Yellow" }
];
var InkView = class extends import_obsidian.FileView {
  constructor(leaf, store) {
    super(leaf);
    this.notebook = createNotebook();
    this.pageIndex = 0;
    this.state = { tool: "pen", color: "#1b1b1b", width: 3, opacity: 1 };
    this.viewport = { x: 0, y: 0, width: 1, height: 1 };
    this.overlayScaleX = 1;
    this.overlayScaleY = 1;
    this.canvasLogicalWidth = 1;
    this.canvasLogicalHeight = 1;
    this.syncing = false;
    this.saveRequested = false;
    this.activeSave = null;
    this.pendingMergedNotebook = null;
    this.activeStroke = null;
    this.activePointerId = null;
    this.lastPoint = null;
    this.pinchStart = null;
    this.zoom = 1;
    this.viewReady = false;
    this.undoStack = [];
    this.redoStack = [];
    this.erasedStrokeIds = /* @__PURE__ */ new Set();
    this.erasedStrokes = [];
    this.lassoPath = [];
    this.selectedStrokeIds = /* @__PURE__ */ new Set();
    this.lassoDrag = null;
    this.sizePopover = null;
    this.sizePopoverButton = null;
    this.sizePopoverOpen = false;
    this.renderFrame = null;
    this.resizeRequested = false;
    this.store = store;
    this.scope = new import_obsidian.Scope(this.app.scope);
    this.scope.register(["Mod"], "z", () => {
      this.undo();
      return false;
    });
    this.scope.register(["Mod", "Shift"], "z", () => {
      this.redo();
      return false;
    });
  }
  getViewType() {
    return VIEW_TYPE_INK;
  }
  getDisplayText() {
    var _a, _b;
    return (_b = (_a = this.file) == null ? void 0 : _a.basename) != null ? _b : this.notebook.title;
  }
  getIcon() {
    return "pen-line";
  }
  async onOpen() {
    this.root = this.containerEl.children[1];
    this.root.empty();
    this.root.addClass("ink-notes-view");
    this.root.setAttribute("aria-label", "Ink Notes");
    this.root.createDiv({ cls: "ink-toolbar", attr: { role: "toolbar", "aria-label": "Ink tools" } });
    this.renderToolbar();
    this.renderCanvas();
    this.viewReady = true;
    this.renderAll();
  }
  async onClose() {
    var _a;
    if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    if (this.zoomRenderTimer !== void 0) window.clearTimeout(this.zoomRenderTimer);
    (_a = this.tiles) == null ? void 0 : _a.dispose();
    if (this.saveTimer !== void 0 && this.file) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
      await this.save(this.file);
    }
    if (this.activeSave) await this.activeSave;
    this.viewReady = false;
  }
  async onLoadFile(file) {
    this.notebook = await this.store.read(file);
    this.pageIndex = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.resetInteraction();
    this.renderAll();
  }
  async onUnloadFile(file) {
    if (this.saveTimer !== void 0) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
      await this.save(file);
    }
    if (this.activeSave) await this.activeSave;
  }
  async reloadFromDisk() {
    if (this.syncing || this.activePointerId !== null || !this.file) return;
    const latest = await this.store.read(this.file);
    this.notebook = mergeNotebooks(latest, this.notebook);
    this.pageIndex = Math.max(0, Math.min(this.pageIndex, this.notebook.pages.length - 1));
    this.renderAll();
  }
  renderToolbar() {
    const toolbar = this.root.querySelector(".ink-toolbar");
    toolbar.empty();
    const group = toolbar.createDiv({ cls: "ink-toolbar-group" });
    const navigation = this.addToolbarSection(group, "Pages");
    this.addIconButton(navigation, "arrow-left", "Previous", () => this.changePage(-1));
    this.addIconButton(navigation, "arrow-right", "Next", () => this.changePage(1));
    this.addIconButton(navigation, "panel-left-open", "Pages", () => this.root.toggleClass("ink-rail-hidden", !this.root.hasClass("ink-rail-hidden")));
    const history = this.addToolbarSection(group, "History");
    this.addIconButton(history, "undo-2", "Undo", () => this.undo(), this.undoStack.length === 0);
    this.addIconButton(history, "redo-2", "Redo", () => this.redo(), this.redoStack.length === 0);
    const tools = this.addToolbarSection(group, "Draw");
    this.addToolButton(tools, "pen-line", "Pen", "pen");
    this.addToolButton(tools, "highlighter", "Highlight", "highlighter");
    this.addToolButton(tools, "eraser", "Erase", "eraser");
    this.addToolButton(tools, "lasso-select", "Select", "lasso");
    const brush = this.addToolbarSection(group, "Style");
    this.addColorPicker(brush);
    this.addSizePopover(brush);
    this.addRange(brush, "Opacity", 0.1, 1, 0.05, this.state.opacity, (value) => {
      this.state.opacity = value;
    });
    const pages = this.addToolbarSection(group, "Document");
    this.addIconButton(pages, "plus", "Add", () => this.addPage());
    this.addIconButton(pages, "more-horizontal", "Options", (event) => this.openPageMenu(event));
  }
  addSizePopover(parent) {
    const container = parent.createDiv({ cls: "ink-size-popover-control" });
    const button = container.createEl("button", {
      cls: "ink-size-button",
      attr: {
        type: "button",
        "aria-label": "Brush size",
        "aria-haspopup": "dialog",
        "aria-expanded": "false"
      }
    });
    const icon = button.createSpan({ cls: "ink-button-icon" });
    (0, import_obsidian.setIcon)(icon, "circle-dot");
    const text = button.createSpan({ cls: "ink-button-text", text: "Size" });
    const valueText = button.createSpan({ cls: "ink-size-button-value", text: formatControlValue("Size", this.state.width) });
    const popover = container.createDiv({
      cls: "ink-size-popover",
      attr: { role: "dialog", "aria-label": "Brush size", "aria-hidden": "true" }
    });
    const header = popover.createDiv({ cls: "ink-size-popover-header" });
    header.createSpan({ cls: "ink-size-popover-title", text: "Brush size" });
    const popoverValue = header.createSpan({ cls: "ink-control-value", text: formatControlValue("Size", this.state.width) });
    const input = popover.createEl("input", {
      attr: {
        type: "range",
        min: "1",
        max: "24",
        step: "0.5",
        value: String(this.state.width),
        "aria-label": "Brush size"
      }
    });
    popover.createDiv({ cls: "ink-size-popover-hint", text: "1\u201324 px" });
    const close = () => this.setSizePopoverOpen(false);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setSizePopoverOpen(!this.sizePopoverOpen);
    });
    input.addEventListener("input", () => {
      const next = Number(input.value);
      this.state.width = next;
      const formatted = formatControlValue("Size", next);
      valueText.textContent = formatted;
      popoverValue.textContent = formatted;
    });
    this.registerDomEvent(document, "pointerdown", (event) => {
      if (this.sizePopoverOpen && !container.contains(event.target)) close();
    });
    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key === "Escape" && this.sizePopoverOpen) {
        close();
        button.focus();
      }
    });
    this.registerDomEvent(window, "resize", () => this.positionSizePopover());
    this.registerDomEvent(window, "scroll", () => this.positionSizePopover(), true);
    this.sizePopover = popover;
    this.sizePopoverButton = button;
  }
  setSizePopoverOpen(open) {
    if (!this.sizePopover || !this.sizePopoverButton) return;
    this.sizePopoverOpen = open;
    this.sizePopover.toggleClass("is-open", open);
    this.sizePopover.setAttribute("aria-hidden", String(!open));
    this.sizePopoverButton.setAttribute("aria-expanded", String(open));
    if (open) {
      this.positionSizePopover();
      window.requestAnimationFrame(() => this.positionSizePopover());
    }
  }
  positionSizePopover() {
    if (!this.sizePopoverOpen || !this.sizePopover || !this.sizePopoverButton) return;
    const buttonRect = this.sizePopoverButton.getBoundingClientRect();
    const popoverRect = this.sizePopover.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(margin, Math.min(window.innerWidth - popoverRect.width - margin, buttonRect.left + buttonRect.width / 2 - popoverRect.width / 2));
    const below = buttonRect.bottom + 10;
    const top = below + popoverRect.height <= window.innerHeight - margin ? below : Math.max(margin, buttonRect.top - popoverRect.height - 10);
    this.sizePopover.style.left = `${left}px`;
    this.sizePopover.style.top = `${top}px`;
  }
  addToolbarSection(parent, label) {
    const section = parent.createDiv({ cls: "ink-toolbar-section" });
    section.addClass(`ink-toolbar-section-${label.toLowerCase()}`);
    section.createSpan({ cls: "ink-toolbar-section-label", text: label });
    return section.createDiv({ cls: "ink-toolbar-section-controls" });
  }
  renderCanvas() {
    const workspace = this.root.createDiv({ cls: "ink-workspace" });
    this.pageScroller = workspace.createDiv({ cls: "ink-page-scroller" });
    this.pageElement = this.pageScroller.createDiv({ cls: "ink-page" });
    const tileHost = this.pageElement.createDiv({ cls: "ink-tile-layer" });
    tileHost.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    this.tiles = new TileRenderer(tileHost);
    this.canvas = this.pageElement.createEl("canvas", { cls: "ink-canvas" });
    this.ctx = this.canvas.getContext("2d");
    this.previewCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-preview-canvas" });
    this.previewCanvas.style.pointerEvents = "none";
    this.previewCtx = this.previewCanvas.getContext("2d");
    this.canvas.style.pointerEvents = "none";
    this.pageElement.style.touchAction = "none";
    this.registerDomEvent(this.pageElement, "pointerdown", (event) => this.onPointerDown(event));
    this.registerDomEvent(this.pageElement, "pointermove", (event) => this.onPointerMove(event));
    this.registerDomEvent(this.pageElement, "pointerup", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.pageElement, "pointercancel", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.pageElement, "lostpointercapture", (event) => this.onLostPointerCapture(event));
    this.registerDomEvent(this.pageElement, "wheel", (event) => this.onWheel(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "scroll", () => this.onViewportMotion(), { passive: true });
    this.registerDomEvent(this.pageScroller, "touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchend", () => {
      this.pinchStart = null;
    });
    this.registerDomEvent(window, "resize", () => this.resizeCanvas());
  }
  renderPageRail() {
    let rail = this.root.querySelector(".ink-page-rail");
    if (!rail) rail = this.root.createDiv({ cls: "ink-page-rail" });
    rail.empty();
    this.notebook.pages.forEach((page, index) => {
      const button = rail.createEl("button", { cls: "ink-page-thumb", attr: { type: "button", title: page.title } });
      if (index === this.pageIndex) button.addClass("is-active");
      button.createDiv({ cls: `ink-page-thumb-paper ink-paper-${page.paper}` });
      button.createSpan({ text: String(index + 1), cls: "ink-page-thumb-number" });
      button.addEventListener("click", () => {
        this.pageIndex = index;
        this.renderPageRail();
        this.renderPage();
      });
    });
  }
  renderPage() {
    if (!this.viewReady || this.notebook.pages.length === 0) return;
    const page = this.currentPage();
    this.pageElement.className = `ink-page ink-paper-${page.paper}`;
    this.pageElement.style.aspectRatio = `${this.notebook.pageWidth} / ${this.notebook.pageHeight}`;
    this.resizeCanvas();
    this.root.querySelectorAll(".ink-tool-button").forEach((el) => {
      const active = el.getAttribute("data-tool") === this.state.tool;
      el.toggleClass("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  }
  resizeCanvas() {
    if (!this.canvas || !this.pageElement) return;
    const rect = this.pageElement.getBoundingClientRect();
    this.canvasLogicalWidth = Math.max(1, Math.round(rect.width / this.zoom * 64) / 64);
    this.canvasLogicalHeight = Math.max(1, Math.round(rect.height / this.zoom * 64) / 64);
    this.tiles.setPage(this.currentPage(), this.canvasLogicalWidth, this.canvasLogicalHeight, this.activeStroke);
    this.updateViewport(true);
  }
  updateViewport(refine) {
    var _a;
    const page = this.pageElement.getBoundingClientRect();
    const screen = this.pageScroller.getBoundingClientRect();
    const x2 = Math.max(0, (screen.left - page.left) / this.zoom);
    const y2 = Math.max(0, (screen.top - page.top) / this.zoom);
    this.viewport = {
      x: x2,
      y: y2,
      width: Math.max(1, Math.min(this.canvasLogicalWidth - x2, (screen.right - page.left) / this.zoom - x2)),
      height: Math.max(1, Math.min(this.canvasLogicalHeight - y2, (screen.bottom - page.top) / this.zoom - y2))
    };
    this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, refine);
    if (refine || this.activeStroke) {
      this.resizeOverlay(this.canvas, this.ctx);
      this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
      this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
      if (((_a = this.activeStroke) == null ? void 0 : _a.tool) === "pen") {
        this.resizePreview();
        this.drawPreview();
      }
    }
    if (refine) this.tiles.prewarm(this.notebook.pages.filter((_2, index) => Math.abs(index - this.pageIndex) === 1));
  }
  drawStrokes(strokes) {
    var _a;
    if (!this.ctx || !this.pageElement) return;
    this.tiles.sync(strokes, ((_a = this.activeStroke) == null ? void 0 : _a.tool) === "pen" ? this.activeStroke : null);
    this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true);
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.drawPreview();
  }
  onViewportMotion() {
    this.updateViewport(false);
    if (this.zoomRenderTimer !== void 0) window.clearTimeout(this.zoomRenderTimer);
    this.zoomRenderTimer = window.setTimeout(() => {
      this.zoomRenderTimer = void 0;
      this.updateViewport(true);
    }, 100);
  }
  requestRender(resize = false) {
    this.resizeRequested || (this.resizeRequested = resize);
    if (this.renderFrame !== null) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      var _a;
      this.renderFrame = null;
      const shouldResize = this.resizeRequested;
      this.resizeRequested = false;
      if (shouldResize) this.resizeCanvas();
      else if (((_a = this.activeStroke) == null ? void 0 : _a.tool) === "pen") this.drawPreview();
      else this.drawStrokes(this.currentPage().strokes);
    });
  }
  resizeOverlay(canvas, ctx) {
    const { x: x2, y: y2, width, height } = this.viewport;
    const resolution = canvasResolution(width, height, window.devicePixelRatio || 1, this.zoom, 4e6);
    if (canvas.width !== resolution.width) canvas.width = resolution.width;
    if (canvas.height !== resolution.height) canvas.height = resolution.height;
    canvas.style.left = x2 + "px";
    canvas.style.top = y2 + "px";
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    canvas.style.right = "auto";
    canvas.style.bottom = "auto";
    this.overlayScaleX = resolution.width / width;
    this.overlayScaleY = resolution.height / height;
    ctx.setTransform(this.overlayScaleX, 0, 0, this.overlayScaleY, -x2 * this.overlayScaleX, -y2 * this.overlayScaleY);
  }
  resizePreview() {
    this.resizeOverlay(this.previewCanvas, this.previewCtx);
  }
  drawPreview() {
    var _a;
    if (((_a = this.activeStroke) == null ? void 0 : _a.tool) !== "pen") return;
    this.previewCtx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    drawInkStroke(this.previewCtx, this.activeStroke, this.canvasLogicalWidth, this.canvasLogicalHeight);
  }
  commitPreview() {
    var _a;
    if (((_a = this.activeStroke) == null ? void 0 : _a.tool) !== "pen") return;
    this.tiles.sync(this.currentPage().strokes);
    this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true);
    this.tiles.flushVisible();
    this.previewCanvas.width = this.previewCanvas.height = 1;
  }
  drawSelection(width, height) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = "#2f80ed";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    if (this.lassoPath.length > 1) {
      ctx.beginPath();
      ctx.moveTo(this.lassoPath[0].x * width, this.lassoPath[0].y * height);
      for (const point of this.lassoPath.slice(1)) ctx.lineTo(point.x * width, point.y * height);
      ctx.closePath();
      ctx.stroke();
    }
    const bounds = selectionBounds(this.selectedStrokes());
    if (bounds) ctx.strokeRect(bounds.minX * width, bounds.minY * height, (bounds.maxX - bounds.minX) * width, (bounds.maxY - bounds.minY) * height);
    ctx.restore();
  }
  onPointerDown(event) {
    if (event.pointerType === "touch") return;
    if (this.activePointerId !== null) this.finishPointerInput();
    this.updateViewport(true);
    if (this.saveTimer !== void 0) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    this.activePointerId = event.pointerId;
    this.pageElement.setPointerCapture(event.pointerId);
    const point = this.toPoint(event);
    this.erasedStrokeIds.clear();
    this.erasedStrokes = [];
    if (this.state.tool === "eraser") {
      this.eraseAt(point);
      return;
    }
    if (this.state.tool === "lasso") {
      if (this.isPointInSelection(point)) {
        this.lassoDrag = {
          start: point,
          before: new Map(this.selectedStrokes().map((stroke) => [stroke.id, clonePoints(stroke.points)]))
        };
      } else {
        this.selectedStrokeIds.clear();
        this.lassoPath = [point];
        this.drawStrokes(this.currentPage().strokes);
      }
      return;
    }
    this.activeStroke = {
      id: newId("stroke"),
      pageId: this.currentPage().id,
      tool: this.state.tool,
      color: this.state.color,
      width: this.state.width,
      opacity: this.state.opacity,
      points: [point],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.lastPoint = point;
    this.currentPage().strokes.push(this.activeStroke);
    if (this.activeStroke.tool === "pen") {
      this.resizePreview();
      this.drawPreview();
    } else this.drawStrokes(this.currentPage().strokes);
  }
  onPointerMove(event) {
    if (this.activePointerId !== event.pointerId || event.pointerType === "touch") return;
    this.applyPointerSamples(event);
  }
  onPointerUp(event) {
    if (this.activePointerId !== event.pointerId) return;
    this.applyPointerSamples(event);
    this.finishPointerInput();
    if (this.pageElement.hasPointerCapture(event.pointerId)) this.pageElement.releasePointerCapture(event.pointerId);
  }
  applyPointerSamples(event) {
    let changed = false;
    for (const sample of this.pointerSamples(event)) {
      const point = this.toPoint(sample);
      if (this.state.tool === "eraser") {
        changed = this.eraseAt(point) || changed;
      } else if (this.state.tool === "lasso") {
        changed = this.applyLassoPoint(point) || changed;
      } else if (this.activeStroke && this.lastPoint && distance(point, this.lastPoint) >= 2e-4) {
        this.activeStroke.points.push(point);
        this.activeStroke.updatedAt = Date.now();
        this.lastPoint = point;
        changed = true;
      }
    }
    if (changed) this.requestRender();
  }
  pointerSamples(event) {
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    return coalesced.length > 0 ? [...coalesced, event] : [event];
  }
  applyLassoPoint(point) {
    var _a, _b, _c, _d;
    if (this.lassoDrag) {
      const bounds = boundsForPointSets([...this.lassoDrag.before.values()]);
      const dx = constrainDelta(point.x - this.lassoDrag.start.x, (_a = bounds == null ? void 0 : bounds.minX) != null ? _a : 0, (_b = bounds == null ? void 0 : bounds.maxX) != null ? _b : 1);
      const dy = constrainDelta(point.y - this.lassoDrag.start.y, (_c = bounds == null ? void 0 : bounds.minY) != null ? _c : 0, (_d = bounds == null ? void 0 : bounds.maxY) != null ? _d : 1);
      for (const stroke of this.selectedStrokes()) {
        const original = this.lassoDrag.before.get(stroke.id);
        if (original) stroke.points = translatePoints(original, dx, dy);
      }
      return true;
    }
    const previous = this.lassoPath[this.lassoPath.length - 1];
    if (!previous || distance(point, previous) < 1e-3) return false;
    this.lassoPath.push(point);
    return true;
  }
  finishPointerInput() {
    var _a;
    const page = this.currentPage();
    this.commitPreview();
    if (((_a = this.activeStroke) == null ? void 0 : _a.tool) === "pen" && this.renderFrame !== null && !this.resizeRequested) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
    if (this.state.tool === "lasso") {
      this.finishLasso(page);
      this.activePointerId = null;
      this.applyPendingMergedNotebook();
      return;
    }
    if (this.state.tool === "eraser" && this.erasedStrokes.length > 0) {
      this.pushCommand(this.deletedStrokesCommand(page.id, this.erasedStrokes));
    } else if (this.activeStroke) {
      this.markChanged(page);
      this.pushCommand(this.addedStrokeCommand(page.id, this.activeStroke));
    }
    this.activePointerId = null;
    this.activeStroke = null;
    this.lastPoint = null;
    this.applyPendingMergedNotebook();
    this.scheduleSave();
  }
  applyPendingMergedNotebook() {
    if (!this.pendingMergedNotebook) return;
    this.notebook = mergeNotebooks(this.pendingMergedNotebook, this.notebook);
    this.pendingMergedNotebook = null;
    this.renderAll();
  }
  onLostPointerCapture(event) {
    if (this.activePointerId !== event.pointerId) return;
    this.applyPointerSamples(event);
    this.finishPointerInput();
  }
  onWheel(event) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.setZoom(this.zoom * (event.deltaY > 0 ? 0.92 : 1.08));
  }
  onTouchStart(event) {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    const a2 = event.touches.item(0);
    const b2 = event.touches.item(1);
    if (!a2 || !b2) return;
    this.pinchStart = { distance: Math.hypot(a2.clientX - b2.clientX, a2.clientY - b2.clientY), zoom: this.zoom, x: (a2.clientX + b2.clientX) / 2, y: (a2.clientY + b2.clientY) / 2 };
  }
  onTouchMove(event) {
    if (event.touches.length !== 2 || !this.pinchStart) return;
    event.preventDefault();
    const a2 = event.touches.item(0);
    const b2 = event.touches.item(1);
    if (!a2 || !b2) return;
    const distanceNow = Math.hypot(a2.clientX - b2.clientX, a2.clientY - b2.clientY);
    this.setZoom(this.pinchStart.zoom * distanceNow / this.pinchStart.distance);
  }
  toPoint(event) {
    const rect = this.pageElement.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      pressure: event.pressure > 0 ? event.pressure : 0.5,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      t: Date.now()
    };
  }
  eraseAt(point) {
    const page = this.currentPage();
    const removed = page.strokes.filter((stroke) => !this.erasedStrokeIds.has(stroke.id) && stroke.points.some((candidate) => distance(candidate, point) < this.state.width / 500));
    if (removed.length === 0) return false;
    for (const stroke of removed) {
      this.erasedStrokeIds.add(stroke.id);
      this.erasedStrokes.push(cloneStroke(stroke));
    }
    this.deleteStrokes(page, removed.map((stroke) => stroke.id));
    this.markChanged(page);
    return true;
  }
  addPage() {
    const now = Date.now();
    const page = { id: newId("page"), title: `Page ${this.notebook.pages.length + 1}`, paper: "ruled", strokes: [], deletedStrokeIds: [], createdAt: now, updatedAt: now };
    this.notebook.pages.push(page);
    this.pageIndex = this.notebook.pages.length - 1;
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }
  changePage(delta) {
    this.pageIndex = Math.max(0, Math.min(this.notebook.pages.length - 1, this.pageIndex + delta));
    this.renderPageRail();
    this.renderPage();
  }
  openPageMenu(event) {
    const menu = new import_obsidian.Menu();
    for (const paper of ["blank", "ruled", "grid", "dot"]) menu.addItem((item) => item.setTitle(`Paper: ${paper}`).setChecked(this.currentPage().paper === paper).onClick(() => {
      this.currentPage().paper = paper;
      this.currentPage().updatedAt = Date.now();
      this.renderPageRail();
      this.renderPage();
      this.scheduleSave();
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Rename page").onClick(() => this.renamePage()));
    menu.showAtMouseEvent(event);
  }
  renamePage() {
    var _a;
    const title = (_a = window.prompt("Page title", this.currentPage().title)) == null ? void 0 : _a.trim();
    if (!title) return;
    this.currentPage().title = title;
    this.currentPage().updatedAt = Date.now();
    this.renderPageRail();
    this.scheduleSave();
  }
  addToolButton(parent, icon, label, tool) {
    const button = parent.createEl("button", { cls: "ink-tool-button", attr: { type: "button", title: label, "aria-label": label, "aria-pressed": String(this.state.tool === tool), "data-tool": tool } });
    const iconHolder = button.createSpan({ cls: "ink-button-icon" });
    (0, import_obsidian.setIcon)(iconHolder, icon);
    button.createSpan({ cls: "ink-button-text", text: label });
    button.addEventListener("click", () => {
      this.state.tool = tool;
      if (tool !== "lasso") this.clearSelection();
      this.updateToolButtons();
      this.renderPage();
    });
  }
  addIconButton(parent, icon, label, callback, disabled = false) {
    const button = parent.createEl("button", { cls: "ink-icon-button", attr: { type: "button", title: label, "aria-label": label } });
    button.disabled = disabled;
    const iconHolder = button.createSpan({ cls: "ink-button-icon" });
    (0, import_obsidian.setIcon)(iconHolder, icon);
    button.createSpan({ cls: "ink-button-text", text: label });
    button.addEventListener("click", callback);
  }
  addColorPicker(parent) {
    const control = parent.createDiv({ cls: "ink-color-control" });
    control.createSpan({ cls: "ink-control-name", text: "Color" });
    const swatches = control.createDiv({ cls: "ink-color-swatches" });
    for (const color of INK_COLORS) {
      const swatch = swatches.createEl("button", { cls: "ink-color-swatch", attr: { type: "button", title: color.label, "aria-label": color.label, "aria-pressed": String(this.state.color.toLowerCase() === color.value), "data-color": color.value } });
      swatch.style.backgroundColor = color.value;
      if (this.state.color.toLowerCase() === color.value) swatch.addClass("is-active");
      swatch.addEventListener("click", () => {
        this.state.color = color.value;
        this.updateColorSwatches();
      });
    }
    const custom = control.createEl("label", { cls: "ink-custom-color", attr: { title: "Custom color" } });
    custom.createSpan({ cls: "ink-button-text", text: "Custom" });
    const input = custom.createEl("input", { attr: { type: "color", value: this.state.color, "aria-label": "Custom color" } });
    input.addEventListener("input", () => {
      this.state.color = input.value;
      swatches.querySelectorAll(".ink-color-swatch").forEach((swatch) => swatch.toggleClass("is-active", swatch.dataset.color === this.state.color.toLowerCase()));
    });
  }
  addRange(parent, name, min, max, step, value, onChange) {
    const label = parent.createEl("label", { cls: "ink-range-control", attr: { title: name } });
    const header = label.createDiv({ cls: "ink-range-header" });
    header.createSpan({ text: name });
    const valueText = header.createSpan({ cls: "ink-control-value", text: formatControlValue(name, value) });
    const input = label.createEl("input", { attr: { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": name } });
    input.addEventListener("input", () => {
      const next = Number(input.value);
      onChange(next);
      valueText.textContent = formatControlValue(name, next);
    });
  }
  setZoom(value) {
    this.zoom = Math.max(0.5, Math.min(3, value));
    this.pageElement.style.transform = `scale(${this.zoom})`;
    this.onViewportMotion();
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = void 0;
      void this.save();
    }, 250);
  }
  async save(file = this.file) {
    if (!file) return;
    if (this.activeSave) {
      this.saveRequested = true;
      await this.activeSave;
      return;
    }
    this.activeSave = this.performSave(file);
    try {
      await this.activeSave;
    } catch (error) {
      new import_obsidian.Notice(`Ink Notes could not save: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.activeSave = null;
    }
  }
  async performSave(file) {
    this.syncing = true;
    try {
      do {
        this.saveRequested = false;
        const snapshot = cloneNotebook(this.notebook);
        const merged = await this.store.save(file, snapshot);
        if (this.activePointerId !== null) {
          this.pendingMergedNotebook = merged;
        } else {
          this.notebook = mergeNotebooks(merged, this.notebook);
          this.renderAll();
        }
      } while (this.saveRequested);
    } finally {
      this.syncing = false;
    }
  }
  undo() {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.afterCommand();
  }
  redo() {
    const command = this.redoStack.pop();
    if (!command) return;
    command.redo();
    this.undoStack.push(command);
    this.afterCommand();
  }
  pushCommand(command) {
    this.undoStack.push(command);
    this.redoStack = [];
    this.updateHistoryButtons();
  }
  afterCommand() {
    this.clearSelection();
    this.updateHistoryButtons();
    this.renderPage();
    this.scheduleSave();
  }
  updateHistoryButtons() {
    const undo = this.root.querySelector("[aria-label='Undo']");
    const redo = this.root.querySelector("[aria-label='Redo']");
    if (undo) undo.disabled = this.undoStack.length === 0;
    if (redo) redo.disabled = this.redoStack.length === 0;
  }
  updateToolButtons() {
    this.root.querySelectorAll(".ink-tool-button").forEach((el) => {
      const active = el.getAttribute("data-tool") === this.state.tool;
      el.toggleClass("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  }
  updateColorSwatches() {
    this.root.querySelectorAll(".ink-color-swatch").forEach((swatch) => {
      const active = swatch.dataset.color === this.state.color.toLowerCase();
      swatch.toggleClass("is-active", active);
      swatch.setAttribute("aria-pressed", String(active));
    });
  }
  addedStrokeCommand(pageId, original) {
    let currentId = original.id;
    const template = cloneStroke(original);
    return {
      undo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        this.deleteStrokes(page, [currentId]);
        this.markChanged(page);
      },
      redo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        const restored = restoredStroke(template);
        currentId = restored.id;
        page.strokes.push(restored);
        this.markChanged(page);
      }
    };
  }
  deletedStrokesCommand(pageId, originals) {
    let current = originals.map(cloneStroke);
    return {
      undo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        current = originals.map(restoredStroke);
        page.strokes.push(...current.map(cloneStroke));
        this.markChanged(page);
      },
      redo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        this.deleteStrokes(page, current.map((stroke) => stroke.id));
        this.markChanged(page);
      }
    };
  }
  finishLasso(page) {
    if (this.lassoDrag) {
      const before = this.lassoDrag.before;
      const movedStrokes = this.selectedStrokes();
      const after = new Map(movedStrokes.map((stroke) => [stroke.id, clonePoints(stroke.points)]));
      const moved = [...after].some(([id, points]) => !samePoints(before.get(id), points));
      this.lassoDrag = null;
      if (moved) {
        const now = Date.now();
        for (const stroke of movedStrokes) stroke.updatedAt = now;
        const pageId = page.id;
        this.pushCommand({
          undo: () => this.applyStrokePoints(pageId, before),
          redo: () => this.applyStrokePoints(pageId, after)
        });
        this.markChanged(page);
        this.scheduleSave();
      }
      this.drawStrokes(page.strokes);
      return;
    }
    if (this.lassoPath.length >= 3) {
      this.selectedStrokeIds = new Set(page.strokes.filter((stroke) => stroke.points.some((point) => pointInPolygon(point, this.lassoPath))).map((stroke) => stroke.id));
    }
    this.lassoPath = [];
    this.drawStrokes(page.strokes);
  }
  applyStrokePoints(pageId, pointsById) {
    const page = this.pageById(pageId);
    if (!page) return;
    for (const stroke of page.strokes) {
      const points = pointsById.get(stroke.id);
      if (points) {
        stroke.points = clonePoints(points);
        stroke.updatedAt = Date.now();
      }
    }
    this.markChanged(page);
  }
  deleteStrokes(page, ids) {
    const deleted = new Set(ids);
    page.strokes = page.strokes.filter((stroke) => !deleted.has(stroke.id));
    page.deletedStrokeIds = [.../* @__PURE__ */ new Set([...page.deletedStrokeIds, ...ids])];
  }
  markChanged(page) {
    var _a;
    const now = Date.now();
    page.updatedAt = now;
    this.notebook.updatedAt = now;
    if (page === this.currentPage()) (_a = this.tiles) == null ? void 0 : _a.sync(page.strokes);
  }
  selectedStrokes() {
    return this.currentPage().strokes.filter((stroke) => this.selectedStrokeIds.has(stroke.id));
  }
  isPointInSelection(point) {
    const bounds = selectionBounds(this.selectedStrokes());
    const padding = 8e-3;
    return bounds !== null && point.x >= bounds.minX - padding && point.x <= bounds.maxX + padding && point.y >= bounds.minY - padding && point.y <= bounds.maxY + padding;
  }
  clearSelection() {
    this.selectedStrokeIds.clear();
    this.lassoPath = [];
    this.lassoDrag = null;
  }
  resetInteraction() {
    if (this.previewCanvas) this.previewCanvas.width = this.previewCanvas.height = 1;
    this.activeStroke = null;
    this.activePointerId = null;
    this.lastPoint = null;
    this.erasedStrokeIds.clear();
    this.erasedStrokes = [];
    this.clearSelection();
  }
  renderAll() {
    if (!this.viewReady) return;
    this.renderPageRail();
    this.renderPage();
  }
  pageById(id) {
    return this.notebook.pages.find((page) => page.id === id);
  }
  currentPage() {
    return this.notebook.pages[this.pageIndex];
  }
};
function distance(a2, b2) {
  return Math.hypot(a2.x - b2.x, a2.y - b2.y);
}
function cloneNotebook(notebook) {
  return {
    ...notebook,
    pages: notebook.pages.map((page) => ({
      ...page,
      strokes: page.strokes.map(cloneStroke),
      deletedStrokeIds: [...page.deletedStrokeIds]
    }))
  };
}
function cloneStroke(stroke) {
  return { ...stroke, points: clonePoints(stroke.points) };
}
function clonePoints(points) {
  return points.map((point) => ({ ...point }));
}
function restoredStroke(stroke) {
  const now = Date.now();
  return { ...cloneStroke(stroke), id: newId("stroke"), createdAt: now, updatedAt: now };
}
function translatePoints(points, dx, dy) {
  return points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy, t: Date.now() }));
}
function selectionBounds(strokes) {
  return boundsForPointSets(strokes.map((stroke) => stroke.points));
}
function boundsForPointSets(pointSets) {
  const points = pointSets.flat();
  if (points.length === 0) return null;
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y))
  };
}
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i2 = 0, j2 = polygon.length - 1; i2 < polygon.length; j2 = i2++) {
    const a2 = polygon[i2];
    const b2 = polygon[j2];
    const crosses = a2.y > point.y !== b2.y > point.y && point.x < (b2.x - a2.x) * (point.y - a2.y) / (b2.y - a2.y) + a2.x;
    if (crosses) inside = !inside;
  }
  return inside;
}
function samePoints(left, right) {
  return left !== void 0 && left.length === right.length && left.every((point, index) => point.x === right[index].x && point.y === right[index].y);
}
function constrainDelta(delta, minimum, maximum) {
  return Math.max(-minimum, Math.min(1 - maximum, delta));
}
function formatControlValue(name, value) {
  return name === "Opacity" ? `${Math.round(value * 100)}%` : `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)} px`;
}

// src/storage.ts
var import_obsidian2 = require("obsidian");
var INK_EXTENSION = "ink";
var INK_FOLDER = "Ink Notes";
var NotebookStore = class {
  constructor(app) {
    this.app = app;
    this.vault = app.vault;
  }
  async create(title) {
    await this.ensureFolder();
    const safeTitle = title.trim().replace(/[\\/:*?"<>|#^\[\]]/g, "-").slice(0, 80) || "Ink Notebook";
    let path = `${INK_FOLDER}/${safeTitle}.${INK_EXTENSION}`;
    let count = 2;
    while (this.vault.getAbstractFileByPath(path)) path = `${INK_FOLDER}/${safeTitle} ${count++}.${INK_EXTENSION}`;
    const notebook = createNotebook(safeTitle);
    return this.vault.create(path, serialize(notebook));
  }
  async read(file) {
    const raw = await this.vault.read(file);
    return normalizeNotebook(JSON.parse(raw));
  }
  async save(file, notebook) {
    const next = { ...notebook, updatedAt: Date.now() };
    let merged = next;
    await this.vault.process(file, (raw) => {
      let latest;
      try {
        latest = normalizeNotebook(JSON.parse(raw));
      } catch (e2) {
        latest = createNotebook(next.title);
      }
      merged = mergeNotebooks(latest, next);
      return serialize(merged);
    });
    return merged;
  }
  async list() {
    return this.vault.getFiles().filter((file) => file.extension === INK_EXTENSION && file.path.startsWith(`${INK_FOLDER}/`));
  }
  observe(onChange) {
    const handler = (file) => {
      if (file instanceof import_obsidian2.TFile && file.extension === INK_EXTENSION && file.path.startsWith(`${INK_FOLDER}/`)) onChange(file);
    };
    const ref = this.vault.on("modify", handler);
    return () => this.vault.offref(ref);
  }
  async ensureFolder() {
    if (!this.vault.getAbstractFileByPath(INK_FOLDER)) await this.vault.createFolder(INK_FOLDER);
  }
};
function serialize(notebook) {
  return `${JSON.stringify(notebook, null, 2)}
`;
}

// src/main.ts
var InkNotesPlugin = class extends import_obsidian3.Plugin {
  async onload() {
    this.store = new NotebookStore(this.app);
    this.registerView(VIEW_TYPE_INK, (leaf) => this.createView(leaf));
    this.registerExtensions([INK_EXTENSION], VIEW_TYPE_INK);
    this.addRibbonIcon("pen-line", "Open Ink Notes", () => void this.openNotebook());
    this.addCommand({ id: "open-ink-notebook", name: "Open Ink Notebook", callback: () => void this.openNotebook() });
    this.addCommand({ id: "create-ink-notebook", name: "Create Ink Notebook", callback: () => void this.createNotebook() });
    this.registerInterval(window.setInterval(() => void this.refreshViews(), 2500));
  }
  createView(leaf) {
    return new InkView(leaf, this.store);
  }
  async openNotebook() {
    const files = await this.store.list();
    if (files.length === 0) {
      await this.createNotebook();
      return;
    }
    await this.openFile(files[0]);
  }
  async createNotebook() {
    const file = await this.store.create("Ink Notebook");
    await this.openFile(file);
  }
  async openFile(file) {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }
  async refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
      if (leaf.view instanceof InkView) await leaf.view.reloadFromDisk();
    }
  }
};
//# sourceMappingURL=main.js.map
