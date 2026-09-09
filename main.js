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
var import_obsidian4 = require("obsidian");

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
  const page = createPage("Page 1", "ruled", now);
  return {
    schema: 2,
    title,
    pageWidth: DEFAULT_PAGE_WIDTH,
    pageHeight: DEFAULT_PAGE_HEIGHT,
    pages: [page],
    pageOrder: [page.id],
    deletedPages: {},
    pageOrderUpdatedAt: now,
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
  const normalizedPages = pages.map(normalizePage).filter((page) => page !== null);
  const pageIds = new Set(normalizedPages.map((page) => page.id));
  const legacyOrder = [...normalizedPages].sort((a2, b2) => a2.createdAt - b2.createdAt).map((page) => page.id);
  const requestedOrder = Array.isArray(raw.pageOrder) ? raw.pageOrder.filter((id) => typeof id === "string") : legacyOrder;
  const pageOrder = [.../* @__PURE__ */ new Set([...requestedOrder.filter((id) => pageIds.has(id)), ...legacyOrder.filter((id) => !requestedOrder.includes(id))])];
  const deletedPages = raw.deletedPages && typeof raw.deletedPages === "object" ? Object.fromEntries(Object.entries(raw.deletedPages).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "number" && Number.isFinite(entry[1]))) : {};
  const visiblePages = normalizedPages.filter((page) => !(page.id in deletedPages));
  const visibleIds = new Set(visiblePages.map((page) => page.id));
  const byId = new Map(visiblePages.map((page) => [page.id, page]));
  const orderedPages = pageOrder.map((id) => byId.get(id)).filter((page) => page !== void 0);
  if (orderedPages.length === 0) orderedPages.push(createPage("Page 1"));
  return {
    schema: 2,
    title: typeof raw.title === "string" ? raw.title : "Ink Notebook",
    pageWidth: finitePositive(raw.pageWidth, DEFAULT_PAGE_WIDTH),
    pageHeight: finitePositive(raw.pageHeight, DEFAULT_PAGE_HEIGHT),
    pages: orderedPages,
    pageOrder: orderedPages.map((page) => page.id).filter((id) => visibleIds.has(id) || orderedPages.length === 1),
    deletedPages,
    pageOrderUpdatedAt: finitePositive(raw.pageOrderUpdatedAt, finitePositive(raw.updatedAt, Date.now())),
    updatedAt: finitePositive(raw.updatedAt, Date.now())
  };
}
function mergeNotebooks(base, incoming) {
  var _a, _b, _c, _d, _e, _f, _g;
  const pages = /* @__PURE__ */ new Map();
  for (const page of base.pages) pages.set(page.id, page);
  for (const page of incoming.pages) {
    const existing = pages.get(page.id);
    pages.set(page.id, existing ? mergePages(existing, page) : page);
  }
  const deletedPages = { ...(_a = base.deletedPages) != null ? _a : {} };
  for (const [id, timestamp] of Object.entries((_b = incoming.deletedPages) != null ? _b : {})) deletedPages[id] = Math.max((_c = deletedPages[id]) != null ? _c : 0, timestamp);
  for (const id of Object.keys(deletedPages)) pages.delete(id);
  const orderSource = incoming.pageOrderUpdatedAt > base.pageOrderUpdatedAt || incoming.pageOrderUpdatedAt === base.pageOrderUpdatedAt && compareNotebookOrder(incoming, base) >= 0 ? incoming : base;
  const preferred = (_d = orderSource.pageOrder) != null ? _d : [];
  const known = preferred.map((id) => pages.get(id)).filter((page) => page !== void 0);
  const additions = [...pages.values()].filter((page) => !preferred.includes(page.id)).sort((a2, b2) => a2.createdAt - b2.createdAt);
  const ordered = [...known];
  for (const page of additions) {
    const inBase = ((_e = base.pageOrder) != null ? _e : []).includes(page.id);
    const inIncoming = ((_f = incoming.pageOrder) != null ? _f : []).includes(page.id);
    const source = inBase && !inIncoming ? base : incoming;
    const sourceOrder = (_g = source.pageOrder) != null ? _g : source.pages.map((candidate) => candidate.id);
    const sourceIndex = sourceOrder.indexOf(page.id);
    let inserted = false;
    for (let index = sourceIndex - 1; index >= 0; index--) {
      const anchor = ordered.findIndex((candidate) => candidate.id === sourceOrder[index]);
      if (anchor >= 0) {
        ordered.splice(anchor + 1, 0, page);
        inserted = true;
        break;
      }
    }
    if (!inserted) for (let index = sourceIndex + 1; index < sourceOrder.length; index++) {
      const anchor = ordered.findIndex((candidate) => candidate.id === sourceOrder[index]);
      if (anchor >= 0) {
        ordered.splice(anchor, 0, page);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      const at = ordered.findIndex((candidate) => page.createdAt < candidate.createdAt);
      ordered.splice(at < 0 ? ordered.length : at, 0, page);
    }
  }
  const safePages = ordered.length ? ordered : [createPage("Page 1")];
  const pageOrder = safePages.map((page) => page.id);
  return {
    ...incoming,
    schema: 2,
    title: incoming.updatedAt >= base.updatedAt ? incoming.title : base.title,
    pageWidth: incoming.pageWidth || base.pageWidth,
    pageHeight: incoming.pageHeight || base.pageHeight,
    pages: safePages,
    pageOrder,
    deletedPages,
    pageOrderUpdatedAt: Math.max(base.pageOrderUpdatedAt, incoming.pageOrderUpdatedAt),
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt)
  };
}
function compareNotebookOrder(left, right) {
  var _a, _b;
  const leftOrder = JSON.stringify((_a = left.pageOrder) != null ? _a : []);
  const rightOrder = JSON.stringify((_b = right.pageOrder) != null ? _b : []);
  return leftOrder < rightOrder ? -1 : leftOrder > rightOrder ? 1 : 0;
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
    streamline: 0.35,
    smoothing: 0.65,
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
function isStrokeSet(exclusion) {
  return exclusion instanceof Set;
}
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
      if (stroke === exclude || isStrokeSet(exclude) && exclude.has(stroke.id)) return;
      retained.add(stroke.id);
      const previous = this.entries.get(stroke.id);
      const style = [stroke.tool, stroke.color, stroke.width, stroke.opacity].join(":");
      if ((previous == null ? void 0 : previous.stroke) === stroke && previous.points === stroke.points && previous.count === stroke.points.length && previous.revision === stroke.updatedAt && previous.style === style) {
        previous.order = order;
        return;
      }
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
  queryNear(point, radius) {
    return this.query({
      x: point.x * this.width - radius,
      y: point.y * this.height - radius,
      width: radius * 2,
      height: radius * 2
    });
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
    state.index.sync(page.strokes, isStrokeSet(exclude) || (exclude == null ? void 0 : exclude.tool) === "pen" ? exclude : null);
  }
  sync(strokes, exclude) {
    var _a;
    (_a = this.active) == null ? void 0 : _a.index.sync(strokes, exclude);
  }
  queryNear(point, radius) {
    var _a, _b;
    return (_b = (_a = this.active) == null ? void 0 : _a.index.queryNear(point, radius)) != null ? _b : [];
  }
  flushVisible() {
    var _a;
    const jobs = this.jobs.filter((job) => job.state === this.active && this.visible.has(job.cell));
    this.jobs = this.jobs.filter((job) => !jobs.includes(job));
    for (const job of jobs) this.attach((_a = this.get(job.state, job.cell, job.density)) != null ? _a : this.paint(job));
    this.evict();
  }
  commitInteractive(viewport, density, refine = true) {
    this.update(viewport, Math.min(1, density), false);
    this.flushVisible();
    if (refine) this.update(viewport, density, true);
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
var STROKE_ERASER_HIT_RADIUS = 10;
var INK_COLORS = [
  { value: "#1b1b1b", label: "Black" },
  { value: "#195bff", label: "Blue" },
  { value: "#f23c42", label: "Red" },
  { value: "#42c449", label: "Green" },
  { value: "#f2c94c", label: "Yellow" }
];
var InkView = class extends import_obsidian.FileView {
  constructor(leaf, store) {
    super(leaf);
    this.notebook = createNotebook();
    this.pageIndex = 0;
    this.state = { tool: "pen", color: "#1b1b1b", width: 3, opacity: 1, eraserMode: "stroke", eraserSize: 32 };
    this.viewport = { x: 0, y: 0, width: 1, height: 1 };
    this.overlayScaleX = 1;
    this.overlayScaleY = 1;
    this.canvasLogicalWidth = 1;
    this.canvasLogicalHeight = 1;
    this.eraserHoverPoint = null;
    this.eraserPointerInside = false;
    this.syncing = false;
    this.saveRequested = false;
    this.activeSave = null;
    this.dirtyRevision = 0;
    this.savedRevision = 0;
    this.pendingMergedNotebook = null;
    this.externalRefreshPending = false;
    this.activeStroke = null;
    this.activePointerId = null;
    this.interaction = null;
    this.interactionGeneration = 0;
    this.lastPoint = null;
    this.touchGesture = null;
    this.pendingLassoPoint = null;
    this.zoom = 1;
    this.viewReady = false;
    this.undoStack = [];
    this.redoStack = [];
    this.erasedStrokeIds = /* @__PURE__ */ new Set();
    this.erasedCandidateIds = /* @__PURE__ */ new Set();
    this.erasedStrokes = [];
    this.eraserReplacementIds = /* @__PURE__ */ new Set();
    this.eraserReplacements = [];
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
  revealPage(pageId) {
    this.finishPointerInput(false);
    const index = this.notebook.pages.findIndex((page) => page.id === pageId);
    if (index < 0) return;
    this.pageIndex = index;
    this.renderPageRail();
    this.renderPage();
  }
  async onOpen() {
    this.root = this.containerEl.children[1];
    this.root.empty();
    this.root.addClass("ink-notes-view");
    this.root.addClass("ink-rail-hidden");
    this.root.setAttribute("aria-label", "Ink Notes");
    this.root.createDiv({ cls: "ink-document-bar" });
    this.root.createDiv({ cls: "ink-toolbar", attr: { role: "toolbar", "aria-label": "Ink tools" } });
    this.root.createDiv({ cls: "ink-brush-bar" });
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
    this.finishPointerInput(false);
    if (this.saveTimer !== void 0) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    if (this.file && (this.dirtyRevision > this.savedRevision || this.activeSave)) await this.save(this.file);
    (_a = this.tiles) == null ? void 0 : _a.dispose();
    this.viewReady = false;
  }
  async onLoadFile(file) {
    this.notebook = await this.store.read(file);
    this.pageIndex = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.resetInteraction();
    this.dirtyRevision = 0;
    this.savedRevision = 0;
    this.renderAll();
  }
  async onUnloadFile(file) {
    this.finishPointerInput(false);
    if (this.saveTimer !== void 0) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    if (this.dirtyRevision > this.savedRevision || this.activeSave) await this.save(file);
  }
  async reloadFromDisk() {
    if (this.syncing || this.activePointerId !== null) {
      this.externalRefreshPending = true;
      return;
    }
    if (!this.file) return;
    const file = this.file;
    const latest = await this.store.read(file);
    if (this.file !== file) return;
    if (notebooksEqual(latest, this.notebook)) return;
    this.receiveMergedNotebook(latest);
  }
  renderToolbar() {
    const documentBar = this.root.querySelector(".ink-document-bar");
    documentBar.empty();
    (0, import_obsidian.setIcon)(documentBar.createSpan({ cls: "ink-brand", attr: { "aria-label": "Ink Notes" } }), "notebook-pen");
    const tab = documentBar.createDiv({ cls: "ink-document-tab" });
    tab.createSpan({ cls: "ink-document-title", text: this.getDisplayText() });
    documentBar.createSpan({ cls: "ink-current-page-title", text: this.currentPage().title });
    const toolbar = this.root.querySelector(".ink-toolbar");
    toolbar.empty();
    const group = toolbar;
    const navigation = this.addToolbarSection(group, "Pages");
    const toggle = this.addIconButton(navigation, "panel-left", "Pages", () => {
      const hidden = !this.root.hasClass("ink-rail-hidden");
      this.root.toggleClass("ink-rail-hidden", hidden);
      toggle.setAttribute("aria-pressed", String(!hidden));
      this.resizeCanvas();
    });
    toggle.setAttribute("aria-pressed", String(!this.root.hasClass("ink-rail-hidden")));
    const tools = this.addToolbarSection(group, "Draw");
    this.addToolButton(tools, "pen-line", "Pen", "pen");
    this.addToolButton(tools, "highlighter", "Highlight", "highlighter");
    this.addToolButton(tools, "eraser", "Erase", "eraser");
    this.addToolButton(tools, "lasso-select", "Select", "lasso");
    const history = this.addToolbarSection(group, "History");
    this.addIconButton(history, "undo-2", "Undo", () => this.undo(), this.undoStack.length === 0);
    this.addIconButton(history, "redo-2", "Redo", () => this.redo(), this.redoStack.length === 0);
    const pages = this.addToolbarSection(group, "Document");
    this.addIconButton(pages, "more-horizontal", "Page options", (event) => this.openPageMenu(event));
    this.renderBrushBar();
    this.updateToolButtons();
  }
  renderBrushBar() {
    const bar = this.root.querySelector(".ink-brush-bar");
    bar.empty();
    const brush = bar.createDiv({ cls: "ink-brush-palette", attr: { role: "group", "aria-label": "Brush settings" } });
    this.addSizePopover(brush);
  }
  addSizePopover(parent) {
    const container = parent.createDiv({ cls: "ink-size-popover-control" });
    const button = container.createEl("button", {
      cls: "ink-size-button",
      attr: {
        type: "button",
        "aria-label": "Brush size",
        "aria-hidden": "true",
        tabindex: "-1"
      }
    });
    const icon = button.createSpan({ cls: "ink-button-icon" });
    (0, import_obsidian.setIcon)(icon, "sliders-horizontal");
    button.title = "Brush size and opacity";
    const popover = container.createDiv({
      cls: "ink-size-popover",
      attr: { role: "dialog", "aria-label": "Tool settings", "aria-hidden": "true" }
    });
    const header = popover.createDiv({ cls: "ink-size-popover-header" });
    header.createSpan({ cls: "ink-size-popover-title", text: "Tool settings" });
    header.createSpan({ cls: "ink-control-value", text: formatControlValue("Size", this.state.width) });
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
    const widths = this.addToolbarSection(popover, "Widths");
    for (const width of [2, 4, 8]) {
      const preset = widths.createEl("button", { cls: "ink-width-preset", attr: { type: "button", title: width + " px", "aria-label": width + " px", "data-width": String(width), "aria-pressed": String(this.state.width === width) } });
      preset.createSpan({ cls: "ink-width-line" }).style.height = width + "px";
      preset.addEventListener("click", () => {
        this.state.width = width;
        this.updateBrushControls();
      });
    }
    this.addColorPicker(popover);
    this.addRange(popover, "Opacity", 0.1, 1, 0.05, this.state.opacity, (value) => {
      this.state.opacity = value;
    });
    const eraser = popover.createDiv({ cls: "ink-eraser-settings" });
    eraser.createDiv({ cls: "ink-size-popover-title", text: "Eraser" });
    const modes = eraser.createDiv({ cls: "ink-eraser-modes", attr: { role: "radiogroup", "aria-label": "Eraser mode" } });
    for (const [mode, label, iconName] of [["stroke", "Stroke eraser", "eraser"], ["circle", "Circle eraser", "circle"], ["square", "Square eraser", "square"]]) {
      const modeButton = modes.createEl("button", { cls: "ink-eraser-mode", attr: { type: "button", role: "radio", title: label, "aria-label": label, "aria-checked": String(this.state.eraserMode === mode), "data-eraser-mode": mode } });
      (0, import_obsidian.setIcon)(modeButton.createSpan({ cls: "ink-button-icon" }), iconName);
      modeButton.addEventListener("click", () => {
        this.state.eraserMode = mode;
        this.updateEraserControls();
      });
    }
    eraser.createDiv({ cls: "ink-stroke-eraser-hint", text: "Erases the entire touched stroke. Size is fixed." });
    this.addRange(eraser, "Eraser size", 8, 160, 2, this.state.eraserSize, (value) => {
      this.state.eraserSize = value;
      this.refreshEraserCursor();
    });
    const close = () => this.setSizePopoverOpen(false);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setSizePopoverOpen(!this.sizePopoverOpen);
    });
    input.addEventListener("input", () => {
      const next = Number(input.value);
      this.state.width = next;
      this.updateBrushControls();
    });
    this.registerDomEvent(document, "pointerdown", (event) => {
      if (this.sizePopoverOpen && !container.contains(event.target)) close();
    });
    this.registerDomEvent(document, "keydown", (event) => {
      var _a;
      if (event.key === "Escape" && this.sizePopoverOpen) {
        close();
        (_a = this.activeToolButton()) == null ? void 0 : _a.focus();
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
    this.root.querySelectorAll(".ink-tool-button[aria-haspopup='dialog']").forEach((button) => {
      button.setAttribute("aria-expanded", String(open && button.dataset.tool === this.state.tool));
    });
    if (open) {
      this.positionSizePopover();
      window.requestAnimationFrame(() => this.positionSizePopover());
      window.requestAnimationFrame(() => {
        var _a, _b;
        return (_b = (_a = this.sizePopover) == null ? void 0 : _a.querySelector(this.state.tool === "eraser" ? ".ink-eraser-mode" : "input, button")) == null ? void 0 : _b.focus();
      });
    }
  }
  positionSizePopover() {
    var _a;
    if (!this.sizePopoverOpen || !this.sizePopover || !this.sizePopoverButton) return;
    const anchor = (_a = this.activeToolButton()) != null ? _a : this.sizePopoverButton;
    const buttonRect = anchor.getBoundingClientRect();
    const popoverRect = this.sizePopover.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(margin, Math.min(window.innerWidth - popoverRect.width - margin, buttonRect.left + buttonRect.width / 2 - popoverRect.width / 2));
    const below = buttonRect.bottom + 10;
    const top = below + popoverRect.height <= window.innerHeight - margin ? below : Math.max(margin, buttonRect.top - popoverRect.height - 10);
    this.sizePopover.style.left = `${left}px`;
    this.sizePopover.style.top = `${top}px`;
  }
  activeToolButton() {
    return this.root.querySelector(`.ink-toolbar [data-tool="${this.state.tool}"]`);
  }
  addToolbarSection(parent, label) {
    const section = parent.createDiv({ cls: "ink-toolbar-section" });
    section.addClass(`ink-toolbar-section-${label.toLowerCase()}`);
    section.setAttribute("role", "group");
    section.setAttribute("aria-label", label);
    return section.createDiv({ cls: "ink-toolbar-section-controls" });
  }
  updateBrushControls() {
    var _a, _b;
    this.root.querySelectorAll(".ink-width-preset").forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.width) === this.state.width));
    });
    const input = (_a = this.sizePopover) == null ? void 0 : _a.querySelector("input[aria-label='Brush size']");
    if (input) input.value = String(this.state.width);
    const value = (_b = this.sizePopover) == null ? void 0 : _b.querySelector(".ink-size-popover-header .ink-control-value");
    if (value) value.textContent = this.state.tool === "eraser" ? formatControlValue("Size", this.state.eraserSize) : formatControlValue("Size", this.state.width);
    this.updateEraserControls();
  }
  updateEraserControls() {
    if (!this.sizePopover) return;
    this.sizePopover.toggleClass("is-stroke-eraser", this.state.eraserMode === "stroke");
    this.sizePopover.querySelectorAll(".ink-eraser-mode").forEach((button) => {
      button.setAttribute("aria-checked", String(button.dataset.eraserMode === this.state.eraserMode));
    });
    this.refreshEraserCursor();
  }
  renderCanvas() {
    const workspace = this.root.createDiv({ cls: "ink-workspace" });
    workspace.createDiv({ cls: "ink-page-rail", attr: { "aria-label": "Notebook pages" } });
    this.pageScroller = workspace.createDiv({ cls: "ink-page-scroller" });
    this.pageExtent = this.pageScroller.createDiv({ cls: "ink-page-extent" });
    this.pageElement = this.pageExtent.createDiv({ cls: "ink-page" });
    this.eraserCursor = this.pageElement.createDiv({ cls: "ink-eraser-cursor", attr: { "aria-hidden": "true" } });
    this.eraserCursor.createSpan({ cls: "ink-eraser-reference-point" });
    const tileHost = this.pageElement.createDiv({ cls: "ink-tile-layer" });
    tileHost.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    this.tiles = new TileRenderer(tileHost);
    this.canvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-selection-canvas" });
    this.ctx = this.canvas.getContext("2d");
    this.canvas.setAttribute("aria-label", "Handwriting canvas");
    this.lassoCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-lasso-preview-canvas" });
    this.lassoCanvas.style.display = "none";
    this.lassoCanvas.style.pointerEvents = "none";
    this.lassoCtx = this.lassoCanvas.getContext("2d");
    const footer = this.root.createDiv({ cls: "ink-statusbar" });
    footer.createSpan({ cls: "ink-page-status", attr: { "aria-live": "polite" } });
    const zoom = footer.createDiv({ cls: "ink-zoom-controls", attr: { role: "group", "aria-label": "Zoom" } });
    this.addIconButton(zoom, "minus", "Zoom out", () => this.setZoom(this.zoom - 0.1));
    const reset = zoom.createEl("button", { cls: "ink-zoom-value", text: "100%", attr: { type: "button", title: "Reset zoom", "aria-label": "Reset zoom" } });
    reset.addEventListener("click", () => this.setZoom(1));
    this.addIconButton(zoom, "plus", "Zoom in", () => this.setZoom(this.zoom + 0.1));
    this.previewCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-preview-canvas" });
    this.previewCanvas.style.pointerEvents = "none";
    this.previewCtx = this.previewCanvas.getContext("2d");
    this.canvas.style.pointerEvents = "none";
    this.pageElement.style.touchAction = "none";
    this.registerDomEvent(this.pageElement, "pointerenter", (event) => this.onPointerEnter(event));
    this.registerDomEvent(this.pageElement, "pointerdown", (event) => this.onPointerDown(event));
    this.registerDomEvent(this.pageElement, "pointermove", (event) => this.onPointerMove(event));
    this.registerDomEvent(this.pageElement, "pointerleave", () => {
      this.eraserPointerInside = false;
      this.refreshEraserCursor();
    });
    this.registerDomEvent(this.pageElement, "pointerup", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.pageElement, "pointercancel", (event) => this.onPointerCancel(event));
    this.registerDomEvent(this.pageElement, "lostpointercapture", (event) => this.onLostPointerCapture(event));
    this.registerDomEvent(this.pageElement, "wheel", (event) => this.onWheel(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "scroll", () => this.onViewportMotion(), { passive: true });
    this.registerDomEvent(this.pageScroller, "touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchend", (event) => this.onTouchStart(event));
    this.registerDomEvent(this.pageScroller, "touchcancel", () => {
      this.touchGesture = null;
    });
    const observer = new ResizeObserver(() => this.resizeCanvas());
    observer.observe(this.pageScroller);
    this.register(() => observer.disconnect());
  }
  renderPageRail() {
    let rail = this.root.querySelector(".ink-page-rail");
    if (!rail) return;
    rail.empty();
    rail.createDiv({ cls: "ink-rail-heading", text: "Pages" });
    this.notebook.pages.forEach((page, index) => {
      const button = rail.createEl("button", { cls: "ink-page-thumb", attr: { type: "button", title: page.title } });
      if (index === this.pageIndex) button.addClass("is-active");
      button.setAttribute("aria-label", String(index + 1) + ": " + page.title);
      button.setAttribute("aria-current", String(index === this.pageIndex));
      button.createDiv({ cls: `ink-page-thumb-paper ink-paper-${page.paper}` });
      button.createSpan({ text: String(index + 1), cls: "ink-page-thumb-number" });
      button.createSpan({ text: page.title, cls: "ink-page-thumb-title" });
      button.addEventListener("click", () => {
        this.finishPointerInput(false);
        this.pageIndex = index;
        this.renderPageRail();
        this.renderPage();
      });
    });
  }
  renderPage() {
    if (!this.viewReady || this.notebook.pages.length === 0) return;
    const page = this.currentPage();
    this.root.querySelector(".ink-document-title").textContent = this.getDisplayText();
    this.root.querySelector(".ink-current-page-title").textContent = page.title;
    this.root.querySelector(".ink-page-status").textContent = this.pageIndex + 1 + " / " + this.notebook.pages.length;
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
    this.layoutPage();
    const rect = this.pageElement.getBoundingClientRect();
    this.canvasLogicalWidth = Math.max(1, Math.round(rect.width / this.zoom * 64) / 64);
    this.canvasLogicalHeight = Math.max(1, Math.round(rect.height / this.zoom * 64) / 64);
    this.refreshEraserCursor();
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
  drawInteractiveStrokes(strokes, refine = false) {
    if (!this.ctx || !this.pageElement) return;
    this.tiles.sync(strokes);
    this.tiles.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom, refine);
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
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
      var _a, _b;
      this.renderFrame = null;
      this.flushPendingLassoPoint();
      const shouldResize = this.resizeRequested;
      this.resizeRequested = false;
      if (shouldResize) this.resizeCanvas();
      else if (this.lassoDrag) this.drawLassoInteraction();
      else if (((_a = this.interaction) == null ? void 0 : _a.tool) === "eraser") this.drawInteractiveStrokes(this.currentPage().strokes);
      else if (((_b = this.activeStroke) == null ? void 0 : _b.tool) === "pen") this.drawPreview();
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
  beginLassoPreview(page) {
    const drag = this.lassoDrag;
    if (!drag || !this.lassoCanvas) return;
    const selected = new Set(drag.strokes.map((stroke) => stroke.id));
    this.tiles.sync(page.strokes, selected);
    this.tiles.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom, false);
    const resolution = canvasResolution(
      this.canvasLogicalWidth,
      this.canvasLogicalHeight,
      window.devicePixelRatio || 1,
      this.zoom,
      4e6
    );
    this.lassoCanvas.width = resolution.width;
    this.lassoCanvas.height = resolution.height;
    this.lassoCanvas.style.left = "0";
    this.lassoCanvas.style.top = "0";
    this.lassoCanvas.style.width = `${this.canvasLogicalWidth}px`;
    this.lassoCanvas.style.height = `${this.canvasLogicalHeight}px`;
    this.lassoCtx.setTransform(
      resolution.width / this.canvasLogicalWidth,
      0,
      0,
      resolution.height / this.canvasLogicalHeight,
      0,
      0
    );
    this.lassoCtx.clearRect(0, 0, this.canvasLogicalWidth, this.canvasLogicalHeight);
    for (const stroke of drag.strokes) drawInkStroke(this.lassoCtx, stroke, this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.lassoCanvas.style.transform = "translate(0px, 0px)";
    this.lassoCanvas.style.display = "block";
  }
  drawLassoInteraction() {
    const drag = this.lassoDrag;
    if (!drag) return;
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    const bounds = drag.bounds;
    if (!bounds) return;
    this.ctx.save();
    this.ctx.strokeStyle = "#2f80ed";
    this.ctx.lineWidth = 1.5;
    this.ctx.setLineDash([6, 4]);
    this.ctx.strokeRect(
      (bounds.minX + drag.dx) * this.canvasLogicalWidth,
      (bounds.minY + drag.dy) * this.canvasLogicalHeight,
      (bounds.maxX - bounds.minX) * this.canvasLogicalWidth,
      (bounds.maxY - bounds.minY) * this.canvasLogicalHeight
    );
    this.ctx.restore();
  }
  commitLassoPreview(page) {
    this.tiles.sync(page.strokes);
    this.tiles.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom);
    this.hideLassoPreview();
    this.drawStrokes(page.strokes);
  }
  hideLassoPreview() {
    if (!this.lassoCanvas) return;
    this.lassoCanvas.style.display = "none";
    this.lassoCanvas.style.transform = "none";
    this.lassoCanvas.width = this.lassoCanvas.height = 1;
  }
  commitPreview(page = this.currentPage()) {
    var _a;
    if (((_a = this.activeStroke) == null ? void 0 : _a.tool) !== "pen") return;
    this.tiles.sync(page.strokes);
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
    if (this.activePointerId !== null) this.finishPointerInput(false);
    this.updateViewport(true);
    if (this.saveTimer !== void 0) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    this.activePointerId = event.pointerId;
    const page = this.currentPage();
    const tool = this.state.tool;
    this.interaction = {
      generation: ++this.interactionGeneration,
      pointerId: event.pointerId,
      pageId: page.id,
      tool,
      eraserMode: tool === "eraser" ? this.state.eraserMode : void 0,
      eraserSize: tool === "eraser" ? this.state.eraserSize : void 0
    };
    this.pageElement.setPointerCapture(event.pointerId);
    const point = this.toPoint(event);
    this.erasedStrokeIds.clear();
    this.erasedCandidateIds.clear();
    this.erasedStrokes = [];
    this.eraserReplacementIds.clear();
    this.eraserReplacements = [];
    if (tool === "eraser") {
      this.updateEraserHover(point, true);
      if (this.eraseAt(point, page)) this.requestRender();
      return;
    }
    if (tool === "lasso") {
      if (this.isPointInSelection(point)) {
        const strokes = this.selectedStrokes();
        const before = new Map(strokes.map((stroke) => [stroke.id, clonePoints(stroke.points)]));
        this.lassoDrag = {
          start: point,
          pageId: page.id,
          strokes,
          before,
          bounds: boundsForPointSets([...before.values()]),
          dx: 0,
          dy: 0
        };
        this.beginLassoPreview(page);
      } else {
        this.selectedStrokeIds.clear();
        this.lassoPath = [point];
        this.drawStrokes(page.strokes);
      }
      return;
    }
    this.activeStroke = {
      id: newId("stroke"),
      pageId: page.id,
      tool,
      color: this.state.color,
      width: this.state.width,
      opacity: this.state.opacity,
      points: [point],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.lastPoint = point;
    page.strokes.push(this.activeStroke);
    if (this.activeStroke.tool === "pen") {
      this.resizePreview();
      this.drawPreview();
    } else this.drawStrokes(page.strokes);
  }
  onPointerEnter(event) {
    if (event.pointerType === "touch") return;
    const rect = this.pageElement.getBoundingClientRect();
    this.updateEraserHover(this.toPoint(event, rect), pointInsideRect(event, rect));
  }
  onPointerMove(event) {
    var _a;
    if (event.pointerType === "touch") return;
    const rect = this.pageElement.getBoundingClientRect();
    const point = this.toPoint(event, rect);
    const inside = pointInsideRect(event, rect);
    if (this.activePointerId === null) {
      this.updateEraserHover(point, inside);
      return;
    }
    if (this.activePointerId !== event.pointerId) return;
    if (((_a = this.interaction) == null ? void 0 : _a.tool) === "eraser") this.updateEraserHover(point, inside);
    this.applyPointerSamples(event, rect);
  }
  onPointerUp(event) {
    if (this.activePointerId !== event.pointerId) return;
    const rect = this.pageElement.getBoundingClientRect();
    const point = this.toPoint(event, rect);
    const inside = pointInsideRect(event, rect);
    this.applyPointerSamples(event, rect);
    this.finishPointerInput(true);
    if (this.pageElement.hasPointerCapture(event.pointerId)) this.pageElement.releasePointerCapture(event.pointerId);
    this.updateEraserHover(point, inside);
  }
  onPointerCancel(event) {
    if (this.activePointerId !== event.pointerId) return;
    this.eraserPointerInside = false;
    this.finishPointerInput(false);
  }
  applyPointerSamples(event, rect = this.pageElement.getBoundingClientRect()) {
    const interaction = this.interaction;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const page = this.pageById(interaction.pageId);
    if (!page) return;
    const samples = this.pointerSamples(event);
    if (interaction.tool === "lasso") {
      this.pendingLassoPoint = this.toPoint(samples[samples.length - 1], rect);
      this.requestRender();
      return;
    }
    let changed = false;
    for (const sample of samples) {
      const point = this.toPoint(sample, rect);
      if (interaction.tool === "eraser") {
        changed = this.eraseAt(point, page, interaction.eraserMode, interaction.eraserSize) || changed;
      } else if (this.activeStroke && this.lastPoint) {
        const stabilized = stabilizeInkPoint(point, this.lastPoint, this.canvasLogicalWidth, this.canvasLogicalHeight);
        if (!stabilized) continue;
        this.activeStroke.points.push(stabilized);
        this.activeStroke.updatedAt = Date.now();
        this.lastPoint = stabilized;
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
      const bounds = this.lassoDrag.bounds;
      const dx = constrainDelta(point.x - this.lassoDrag.start.x, (_a = bounds == null ? void 0 : bounds.minX) != null ? _a : 0, (_b = bounds == null ? void 0 : bounds.maxX) != null ? _b : 1);
      const dy = constrainDelta(point.y - this.lassoDrag.start.y, (_c = bounds == null ? void 0 : bounds.minY) != null ? _c : 0, (_d = bounds == null ? void 0 : bounds.maxY) != null ? _d : 1);
      if (dx === this.lassoDrag.dx && dy === this.lassoDrag.dy) return false;
      this.lassoDrag.dx = dx;
      this.lassoDrag.dy = dy;
      this.lassoCanvas.style.transform = `translate(${dx * this.canvasLogicalWidth}px, ${dy * this.canvasLogicalHeight}px)`;
      return true;
    }
    const previous = this.lassoPath[this.lassoPath.length - 1];
    if (!previous || distance(point, previous) < 1e-3) return false;
    this.lassoPath.push(point);
    return true;
  }
  flushPendingLassoPoint() {
    const point = this.pendingLassoPoint;
    this.pendingLassoPoint = null;
    if (point) this.applyLassoPoint(point);
  }
  finishPointerInput(_includeFinalSample = false) {
    var _a;
    const interaction = this.interaction;
    if (!interaction) return;
    const page = this.pageById(interaction.pageId);
    this.interaction = null;
    this.refreshEraserCursor();
    if (!page) {
      this.activePointerId = null;
      return;
    }
    this.flushPendingLassoPoint();
    this.commitPreview(page);
    if (((_a = this.activeStroke) == null ? void 0 : _a.tool) === "pen" && this.renderFrame !== null && !this.resizeRequested) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
    if (interaction.tool === "lasso") {
      this.finishLasso(page);
      this.activePointerId = null;
      this.applyPendingMergedNotebook();
      return;
    }
    if (interaction.tool === "eraser" && this.erasedStrokes.length > 0) {
      this.markChanged(page);
      this.pushCommand(this.erasedStrokesCommand(page.id, this.erasedStrokes, this.eraserReplacements));
      this.drawInteractiveStrokes(page.strokes, true);
    } else if (this.activeStroke) {
      this.markChanged(page);
      this.pushCommand(this.addedStrokeCommand(page.id, this.activeStroke));
    }
    this.activePointerId = null;
    this.activeStroke = null;
    this.lastPoint = null;
    this.pendingLassoPoint = null;
    this.applyPendingMergedNotebook();
    this.scheduleSave();
    if (this.externalRefreshPending) {
      this.externalRefreshPending = false;
      void this.reloadFromDisk().catch((error) => new import_obsidian.Notice(`Ink Notes could not reload: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  applyPendingMergedNotebook() {
    if (!this.pendingMergedNotebook) return;
    const pageId = this.currentPage().id;
    this.notebook = mergeNotebooks(this.pendingMergedNotebook, this.notebook);
    this.pendingMergedNotebook = null;
    this.pageIndex = Math.max(0, this.notebook.pages.findIndex((page) => page.id === pageId));
    this.renderAll();
  }
  receiveMergedNotebook(notebook) {
    this.pendingMergedNotebook = this.pendingMergedNotebook ? mergeNotebooks(this.pendingMergedNotebook, notebook) : notebook;
    if (this.activePointerId === null) this.applyPendingMergedNotebook();
  }
  onLostPointerCapture(event) {
    if (this.activePointerId !== event.pointerId) return;
    if (this.pageElement.hasPointerCapture(event.pointerId)) return;
    this.finishPointerInput(false);
  }
  onWheel(event) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.setZoom(this.zoom * (event.deltaY > 0 ? 0.92 : 1.08), { x: event.clientX, y: event.clientY });
  }
  onTouchStart(event) {
    this.touchGesture = null;
    if (this.activePointerId !== null || event.touches.length < 1 || event.touches.length > 2) return;
    event.preventDefault();
    const a2 = event.touches.item(0);
    const b2 = event.touches.item(1);
    if (!a2) return;
    const x2 = b2 ? (a2.clientX + b2.clientX) / 2 : a2.clientX;
    const y2 = b2 ? (a2.clientY + b2.clientY) / 2 : a2.clientY;
    const rect = this.pageElement.getBoundingClientRect();
    this.touchGesture = {
      ids: b2 ? [a2.identifier, b2.identifier] : [a2.identifier],
      distance: b2 ? Math.hypot(a2.clientX - b2.clientX, a2.clientY - b2.clientY) : 0,
      zoom: this.zoom,
      x: x2,
      y: y2,
      pageX: (x2 - rect.left) / rect.width,
      pageY: (y2 - rect.top) / rect.height
    };
  }
  onTouchMove(event) {
    if (this.activePointerId !== null) {
      this.touchGesture = null;
      return;
    }
    const gesture = this.touchGesture;
    if (!gesture) return;
    const touches = Array.from(event.touches);
    const a2 = touches.find((touch) => touch.identifier === gesture.ids[0]);
    const b2 = touches.find((touch) => touch.identifier === gesture.ids[1]);
    if (touches.length !== gesture.ids.length || !a2 || gesture.ids.length === 2 && !b2) {
      this.onTouchStart(event);
      return;
    }
    event.preventDefault();
    if (!b2) {
      this.pageScroller.scrollLeft += gesture.x - a2.clientX;
      this.pageScroller.scrollTop += gesture.y - a2.clientY;
      gesture.x = a2.clientX;
      gesture.y = a2.clientY;
      return;
    }
    if (gesture.distance < 1) {
      this.onTouchStart(event);
      return;
    }
    const distanceNow = Math.hypot(a2.clientX - b2.clientX, a2.clientY - b2.clientY);
    this.setZoom(
      gesture.zoom * distanceNow / gesture.distance,
      { x: (a2.clientX + b2.clientX) / 2, y: (a2.clientY + b2.clientY) / 2 },
      { x: gesture.pageX, y: gesture.pageY }
    );
  }
  toPoint(event, rect = this.pageElement.getBoundingClientRect()) {
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      pressure: event.pressure > 0 ? event.pressure : 0.5,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      t: Date.now()
    };
  }
  eraseAt(point, page = this.currentPage(), mode = this.state.eraserMode, size = this.state.eraserSize) {
    var _a;
    const radius = mode === "stroke" ? STROKE_ERASER_HIT_RADIUS : size / 2;
    const indexed = ((_a = this.tiles) == null ? void 0 : _a.queryNear) ? this.tiles.queryNear(point, radius) : page.strokes;
    const candidates = [...new Map([...indexed, ...this.eraserReplacements].map((stroke) => [stroke.id, stroke])).values()].filter((stroke) => !this.erasedCandidateIds.has(stroke.id));
    const removed = candidates.filter((stroke) => strokeIntersectsEraser(stroke, point, radius, mode, this.canvasLogicalWidth, this.canvasLogicalHeight));
    if (removed.length === 0) return false;
    for (const stroke of removed) {
      this.erasedCandidateIds.add(stroke.id);
      if (!this.eraserReplacementIds.has(stroke.id) && !this.erasedStrokeIds.has(stroke.id)) {
        this.erasedStrokeIds.add(stroke.id);
        this.erasedStrokes.push(cloneStroke(stroke));
      }
      if (this.eraserReplacementIds.delete(stroke.id)) this.eraserReplacements = this.eraserReplacements.filter((candidate) => candidate.id !== stroke.id);
    }
    this.deleteStrokes(page, removed.map((stroke) => stroke.id));
    if (mode !== "stroke") {
      const now = Date.now();
      for (const stroke of removed) {
        const segments = eraseStrokeSegments(stroke, point, radius, mode, this.canvasLogicalWidth, this.canvasLogicalHeight);
        for (const points of segments) {
          const replacement = { ...cloneStroke(stroke), id: newId("stroke"), points, createdAt: now, updatedAt: now };
          page.strokes.push(replacement);
          this.eraserReplacementIds.add(replacement.id);
          this.eraserReplacements.push(cloneStroke(replacement));
        }
      }
      page.strokes.sort((left, right) => left.createdAt - right.createdAt);
    }
    return true;
  }
  updateEraserHover(point, inside) {
    this.eraserHoverPoint = point;
    this.eraserPointerInside = inside;
    this.refreshEraserCursor();
  }
  refreshEraserCursor() {
    var _a, _b, _c, _d;
    if (!this.eraserCursor) return;
    const mode = ((_a = this.interaction) == null ? void 0 : _a.tool) === "eraser" ? (_b = this.interaction.eraserMode) != null ? _b : this.state.eraserMode : this.state.eraserMode;
    const eraserSize = ((_c = this.interaction) == null ? void 0 : _c.tool) === "eraser" ? (_d = this.interaction.eraserSize) != null ? _d : this.state.eraserSize : this.state.eraserSize;
    this.eraserCursor.toggleClass("is-visible", this.state.tool === "eraser" && this.eraserPointerInside && this.eraserHoverPoint !== null);
    this.eraserCursor.toggleClass("is-square", mode === "square");
    this.eraserCursor.toggleClass("is-stroke", mode === "stroke");
    const size = mode === "stroke" ? STROKE_ERASER_HIT_RADIUS * 2 : eraserSize;
    this.eraserCursor.style.width = `${size}px`;
    this.eraserCursor.style.height = `${size}px`;
    if (!this.eraserHoverPoint) return;
    this.eraserCursor.style.left = `${this.eraserHoverPoint.x * this.canvasLogicalWidth}px`;
    this.eraserCursor.style.top = `${this.eraserHoverPoint.y * this.canvasLogicalHeight}px`;
  }
  addPage() {
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const beforePageId = this.currentPage().id;
    const now = Date.now();
    const page = { id: newId("page"), title: `Page ${this.notebook.pages.length + 1}`, paper: "ruled", strokes: [], deletedStrokeIds: [], createdAt: now, updatedAt: now };
    this.notebook.pages.push(page);
    this.notebook.pageOrder.push(page.id);
    this.notebook.pageOrderUpdatedAt = now;
    this.notebook.updatedAt = now;
    this.dirtyRevision += 1;
    this.pageIndex = this.notebook.pages.length - 1;
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, page.id);
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }
  changePage(delta) {
    this.finishPointerInput(false);
    this.pageIndex = Math.max(0, Math.min(this.notebook.pages.length - 1, this.pageIndex + delta));
    this.renderPageRail();
    this.renderPage();
  }
  openPageMenu(event) {
    const menu = new import_obsidian.Menu();
    for (const paper of ["blank", "ruled", "grid", "dot"]) menu.addItem((item) => item.setTitle(`Paper: ${paper}`).setChecked(this.currentPage().paper === paper).onClick(() => {
      const page = this.currentPage();
      const before = page.paper;
      page.paper = paper;
      this.markChanged(page);
      this.pushCommand({
        undo: () => this.setPagePaper(page.id, before),
        redo: () => this.setPagePaper(page.id, paper)
      });
      this.renderPageRail();
      this.renderPage();
      this.scheduleSave();
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Add page").onClick(() => this.addPage()));
    menu.addItem((item) => item.setTitle("Rename page").onClick(() => this.renamePage()));
    menu.addItem((item) => item.setTitle("Duplicate page").onClick(() => this.duplicateCurrentPage()));
    menu.addItem((item) => item.setTitle("Move page up").setDisabled(this.pageIndex === 0).onClick(() => this.moveCurrentPage(-1)));
    menu.addItem((item) => item.setTitle("Move page down").setDisabled(this.pageIndex === this.notebook.pages.length - 1).onClick(() => this.moveCurrentPage(1)));
    menu.addItem((item) => item.setTitle("Delete page").setDisabled(this.notebook.pages.length <= 1).onClick(() => this.deleteCurrentPage()));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Copy page embed syntax").onClick(() => void this.copyCurrentPageEmbed()));
    menu.addItem((item) => item.setTitle("Zoom out").setDisabled(this.zoom <= 0.5).onClick(() => this.setZoom(this.zoom - 0.1)));
    menu.addItem((item) => item.setTitle("Reset zoom").setDisabled(this.zoom === 1).onClick(() => this.setZoom(1)));
    menu.addItem((item) => item.setTitle("Zoom in").setDisabled(this.zoom >= 3).onClick(() => this.setZoom(this.zoom + 0.1)));
    menu.showAtMouseEvent(event);
  }
  renamePage() {
    var _a;
    const title = (_a = window.prompt("Page title", this.currentPage().title)) == null ? void 0 : _a.trim();
    if (!title) return;
    const page = this.currentPage();
    const before = page.title;
    page.title = title;
    this.markChanged(page);
    this.pushCommand({
      undo: () => this.setPageTitle(page.id, before),
      redo: () => this.setPageTitle(page.id, title)
    });
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }
  duplicateCurrentPage() {
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const beforePageId = this.currentPage().id;
    const source = clonePage(this.currentPage());
    const insertionIndex = this.pageIndex + 1;
    const now = Date.now();
    const page = clonePageAsNew(source, `${source.title} copy`, now);
    this.notebook.pages.splice(insertionIndex, 0, page);
    this.pageIndex += 1;
    this.finishPageOrderChange(now);
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, page.id);
    this.renderAll();
    this.scheduleSave();
  }
  deleteCurrentPage() {
    if (this.notebook.pages.length <= 1) return;
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const beforePageId = this.currentPage().id;
    const deletedIndex = this.pageIndex;
    const [deleted] = this.notebook.pages.splice(this.pageIndex, 1);
    const now = Date.now();
    this.notebook.deletedPages[deleted.id] = now;
    this.pageIndex = Math.min(this.pageIndex, this.notebook.pages.length - 1);
    this.finishPageOrderChange(now);
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, this.currentPage().id);
    this.clearSelection();
    this.renderAll();
    this.scheduleSave();
  }
  moveCurrentPage(delta) {
    const target = this.pageIndex + delta;
    if (target < 0 || target >= this.notebook.pages.length) return;
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const pageId = this.currentPage().id;
    const [page] = this.notebook.pages.splice(this.pageIndex, 1);
    this.notebook.pages.splice(target, 0, page);
    this.pageIndex = target;
    this.finishPageOrderChange(Date.now());
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), pageId, pageId);
    this.renderAll();
    this.scheduleSave();
  }
  finishPageOrderChange(now) {
    this.notebook.pageOrder = this.notebook.pages.map((page) => page.id);
    this.notebook.pageOrderUpdatedAt = now;
    this.notebook.updatedAt = now;
    this.dirtyRevision += 1;
  }
  pushNotebookCommand(before, after, beforePageId, afterPageId) {
    this.pushCommand({
      undo: () => this.restoreNotebookState(before, beforePageId),
      redo: () => this.restoreNotebookState(after, afterPageId)
    });
  }
  restoreNotebookState(snapshot, selectedPageId) {
    var _a;
    const current = this.notebook;
    const next = cloneNotebook(snapshot);
    const now = Date.now();
    const nextIds = new Set(next.pages.map((page) => page.id));
    const deletedPages = { ...current.deletedPages, ...next.deletedPages };
    for (const page of current.pages) {
      if (!nextIds.has(page.id)) deletedPages[page.id] = Math.max((_a = deletedPages[page.id]) != null ? _a : 0, now);
    }
    let selectedId = selectedPageId;
    next.pages = next.pages.map((page) => {
      if (!(page.id in deletedPages)) return page;
      const restored = clonePageAsNew(page, page.title, now);
      if (page.id === selectedPageId) selectedId = restored.id;
      return restored;
    });
    next.deletedPages = deletedPages;
    next.pageOrder = next.pages.map((page) => page.id);
    next.updatedAt = now;
    next.pageOrderUpdatedAt = now;
    this.notebook = next;
    this.pageIndex = Math.max(0, next.pages.findIndex((page) => page.id === selectedId));
    this.dirtyRevision += 1;
  }
  setPagePaper(pageId, paper) {
    const page = this.pageById(pageId);
    if (!page) return;
    page.paper = paper;
    this.markChanged(page);
  }
  setPageTitle(pageId, title) {
    const page = this.pageById(pageId);
    if (!page) return;
    page.title = title;
    this.markChanged(page);
  }
  async copyCurrentPageEmbed() {
    if (!this.file) return;
    const syntax = `\`\`\`ink
${this.file.path}
page: ${this.currentPage().id}
\`\`\``;
    try {
      await navigator.clipboard.writeText(syntax);
      new import_obsidian.Notice("Copied Ink page embed syntax");
    } catch (error) {
      new import_obsidian.Notice(`Could not copy embed syntax: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  addToolButton(parent, icon, label, tool) {
    const hasSettings = tool === "pen" || tool === "highlighter" || tool === "eraser";
    const button = parent.createEl("button", { cls: "ink-tool-button", attr: {
      type: "button",
      title: label,
      "aria-label": label,
      "aria-pressed": String(this.state.tool === tool),
      "data-tool": tool,
      ...hasSettings ? { "aria-haspopup": "dialog", "aria-expanded": "false" } : {}
    } });
    const iconHolder = button.createSpan({ cls: "ink-button-icon" });
    (0, import_obsidian.setIcon)(iconHolder, icon);
    button.createSpan({ cls: "ink-button-text", text: label });
    button.addEventListener("click", () => {
      var _a;
      this.finishPointerInput(false);
      if (this.state.tool === tool && (tool === "pen" || tool === "highlighter" || tool === "eraser")) {
        this.setSizePopoverOpen(!this.sizePopoverOpen);
        return;
      }
      this.state.tool = tool;
      if (tool !== "lasso") this.clearSelection();
      (_a = this.sizePopover) == null ? void 0 : _a.toggleClass("is-eraser-tool", tool === "eraser");
      this.updateBrushControls();
      this.updateToolButtons();
      this.renderPage();
      this.refreshEraserCursor();
      if (this.sizePopoverOpen) {
        this.setSizePopoverOpen(true);
        this.positionSizePopover();
      }
    });
  }
  addIconButton(parent, icon, label, callback, disabled = false) {
    const button = parent.createEl("button", { cls: "ink-icon-button", attr: { type: "button", title: label, "aria-label": label } });
    button.disabled = disabled;
    const iconHolder = button.createSpan({ cls: "ink-button-icon" });
    (0, import_obsidian.setIcon)(iconHolder, icon);
    button.createSpan({ cls: "ink-button-text", text: label });
    button.addEventListener("click", callback);
    return button;
  }
  addColorPicker(parent) {
    const control = parent.createDiv({ cls: "ink-color-control" });
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
    (0, import_obsidian.setIcon)(custom.createSpan({ cls: "ink-button-icon" }), "plus");
    const input = custom.createEl("input", { attr: { type: "color", value: this.state.color, "aria-label": "Custom color" } });
    input.addEventListener("input", () => {
      this.state.color = input.value;
      this.updateColorSwatches();
    });
  }
  addRange(parent, name, min, max, step, value, onChange) {
    const label = parent.createEl("label", { cls: "ink-range-control", attr: { title: name } });
    label.addClass(`ink-range-${name.toLowerCase().replace(/\s+/g, "-")}`);
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
  layoutPage() {
    const style = getComputedStyle(this.pageScroller);
    const width = Math.max(1, Math.min(980, this.pageScroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
    const height = width * this.notebook.pageHeight / this.notebook.pageWidth;
    this.pageElement.style.width = width + "px";
    this.pageElement.style.height = height + "px";
    this.pageElement.style.transform = "scale(" + this.zoom + ")";
    this.pageExtent.style.width = width * this.zoom + "px";
    this.pageExtent.style.height = height * this.zoom + "px";
  }
  setZoom(value, target, anchor) {
    if (!Number.isFinite(value)) return;
    const viewport = this.pageScroller.getBoundingClientRect();
    target != null ? target : target = { x: viewport.left + this.pageScroller.clientWidth / 2, y: viewport.top + this.pageScroller.clientHeight / 2 };
    const before = this.pageElement.getBoundingClientRect();
    anchor != null ? anchor : anchor = { x: (target.x - before.left) / before.width, y: (target.y - before.top) / before.height };
    const nextZoom = Math.max(0.5, Math.min(3, value));
    if (nextZoom !== this.zoom) {
      this.zoom = nextZoom;
      this.layoutPage();
    }
    const after = this.pageElement.getBoundingClientRect();
    this.pageScroller.scrollLeft += after.left + anchor.x * after.width - target.x;
    this.pageScroller.scrollTop += after.top + anchor.y * after.height - target.y;
    const readout = this.root.querySelector(".ink-zoom-value");
    if (readout) readout.textContent = Math.round(this.zoom * 100) + "%";
    const zoomOut = this.root.querySelector("[aria-label='Zoom out']");
    const zoomIn = this.root.querySelector("[aria-label='Zoom in']");
    if (zoomOut) zoomOut.disabled = this.zoom <= 0.5;
    if (zoomIn) zoomIn.disabled = this.zoom >= 3;
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
    const saving = this.performSave(file);
    this.activeSave = saving;
    try {
      await saving;
    } catch (error) {
      new import_obsidian.Notice(`Ink Notes could not save ${file.path || "notebook"}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.activeSave === saving) this.activeSave = null;
  }
  async performSave(file) {
    this.syncing = true;
    try {
      do {
        this.saveRequested = false;
        const revision = this.dirtyRevision;
        const snapshot = cloneNotebook(this.notebook);
        try {
          const merged = await this.store.save(file, snapshot);
          this.savedRevision = Math.max(this.savedRevision, revision);
          if (this.file === file) this.receiveMergedNotebook(merged);
        } catch (error) {
          new import_obsidian.Notice(`Ink Notes could not save ${file.path || "notebook"}: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
      } while (this.saveRequested || this.dirtyRevision > this.savedRevision);
    } finally {
      this.syncing = false;
      if (this.externalRefreshPending && this.activePointerId === null) {
        this.externalRefreshPending = false;
        void this.reloadFromDisk().catch((error) => new import_obsidian.Notice(`Ink Notes could not reload: ${error instanceof Error ? error.message : String(error)}`));
      }
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
    this.renderAll();
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
    const custom = this.root.querySelector('input[type="color"]');
    if (custom) custom.value = this.state.color;
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
  erasedStrokesCommand(pageId, originals, replacements) {
    let currentOriginals = originals.map(cloneStroke);
    let currentReplacements = replacements.map(cloneStroke);
    return {
      undo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        this.deleteStrokes(page, currentReplacements.map((stroke) => stroke.id));
        currentOriginals = originals.map(restoredStroke);
        page.strokes.push(...currentOriginals.map(cloneStroke));
        page.strokes.sort((left, right) => left.createdAt - right.createdAt);
        this.markChanged(page);
      },
      redo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        this.deleteStrokes(page, currentOriginals.map((stroke) => stroke.id));
        currentReplacements = replacements.map(restoredStroke);
        page.strokes.push(...currentReplacements.map(cloneStroke));
        page.strokes.sort((left, right) => left.createdAt - right.createdAt);
        this.markChanged(page);
      }
    };
  }
  finishLasso(page) {
    if (this.lassoDrag) {
      const drag = this.lassoDrag;
      const before = drag.before;
      const movedStrokes = drag.strokes;
      const moved = drag.dx !== 0 || drag.dy !== 0;
      if (moved) for (const stroke of movedStrokes) {
        const points = before.get(stroke.id);
        if (points) stroke.points = translatePoints(points, drag.dx, drag.dy);
      }
      const after = new Map(movedStrokes.map((stroke) => [stroke.id, clonePoints(stroke.points)]));
      if (moved) {
        const now = Date.now();
        for (const stroke of movedStrokes) stroke.updatedAt = now;
        const pageId = drag.pageId;
        this.pushCommand({
          undo: () => this.applyStrokePoints(pageId, before),
          redo: () => this.applyStrokePoints(pageId, after)
        });
        this.markChanged(page, false);
        this.scheduleSave();
      }
      this.lassoDrag = null;
      this.commitLassoPreview(page);
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
  markChanged(page, syncTiles = true) {
    var _a;
    const now = Date.now();
    page.updatedAt = now;
    this.notebook.updatedAt = now;
    this.dirtyRevision += 1;
    if (syncTiles && page === this.currentPage()) (_a = this.tiles) == null ? void 0 : _a.sync(page.strokes);
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
    this.hideLassoPreview();
  }
  resetInteraction() {
    if (this.previewCanvas) this.previewCanvas.width = this.previewCanvas.height = 1;
    this.touchGesture = null;
    this.pendingMergedNotebook = null;
    this.externalRefreshPending = false;
    this.eraserHoverPoint = null;
    this.eraserPointerInside = false;
    this.activeStroke = null;
    this.activePointerId = null;
    this.lastPoint = null;
    this.erasedStrokeIds.clear();
    this.erasedCandidateIds.clear();
    this.erasedStrokes = [];
    this.eraserReplacementIds.clear();
    this.eraserReplacements = [];
    this.clearSelection();
  }
  renderAll() {
    if (!this.viewReady) return;
    this.renderPageRail();
    this.renderPage();
    this.updateHistoryButtons();
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
function pointInsideRect(point, rect) {
  return point.clientX >= rect.left && point.clientX <= rect.right && point.clientY >= rect.top && point.clientY <= rect.bottom;
}
function stabilizeInkPoint(point, previous, width, height) {
  if (width <= 1 || height <= 1) return distance(point, previous) >= 2e-4 ? point : null;
  const dx = (point.x - previous.x) * width;
  const dy = (point.y - previous.y) * height;
  const pixels = Math.hypot(dx, dy);
  if (pixels < 0.75) return null;
  const weight = pixels < 4 ? 0.45 : pixels < 8 ? 0.7 : 1;
  return {
    ...point,
    x: previous.x + (point.x - previous.x) * weight,
    y: previous.y + (point.y - previous.y) * weight,
    pressure: previous.pressure + (point.pressure - previous.pressure) * Math.max(0.55, weight)
  };
}
function strokeIntersectsEraser(stroke, center, radius, mode, width, height) {
  if (stroke.points.some((point) => pointInsideEraser(point, center, radius, mode, width, height))) return true;
  for (let index = 1; index < stroke.points.length; index++) {
    if (segmentIntersectsEraser(stroke.points[index - 1], stroke.points[index], center, radius, mode, width, height)) return true;
  }
  return false;
}
function eraseStrokeSegments(stroke, center, radius, mode, width, height) {
  const segments = [];
  let segment = [];
  const flush = () => {
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };
  for (const point of sampleStrokeForEraser(stroke.points, radius, width, height)) {
    if (pointInsideEraser(point, center, radius, mode, width, height)) flush();
    else segment.push({ ...point });
  }
  flush();
  return segments;
}
function pointInsideEraser(point, center, radius, mode, width, height) {
  const dx = (point.x - center.x) * width;
  const dy = (point.y - center.y) * height;
  return mode === "square" ? Math.abs(dx) <= radius && Math.abs(dy) <= radius : Math.hypot(dx, dy) <= radius;
}
function segmentIntersectsEraser(start, end, center, radius, mode, width, height) {
  const ax = (start.x - center.x) * width;
  const ay = (start.y - center.y) * height;
  const bx = (end.x - center.x) * width;
  const by = (end.y - center.y) * height;
  if (mode === "square") return segmentIntersectsBox(ax, ay, bx, by, radius);
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t2 = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + dx * t2, ay + dy * t2) <= radius;
}
function segmentIntersectsBox(ax, ay, bx, by, radius) {
  let minimum = 0, maximum = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [origin, delta] of [[ax, dx], [ay, dy]]) {
    if (delta === 0) {
      if (origin < -radius || origin > radius) return false;
      continue;
    }
    const near = (-radius - origin) / delta;
    const far = (radius - origin) / delta;
    minimum = Math.max(minimum, Math.min(near, far));
    maximum = Math.min(maximum, Math.max(near, far));
    if (minimum > maximum) return false;
  }
  return true;
}
function sampleStrokeForEraser(points, radius, width, height) {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const sampled = [{ ...points[0] }];
  const step = Math.max(1, radius / 3);
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1], end = points[index];
    const pixels = Math.hypot((end.x - start.x) * width, (end.y - start.y) * height);
    const count = Math.max(1, Math.ceil(pixels / step));
    for (let sample = 1; sample <= count; sample++) sampled.push(interpolateInkPoint(start, end, sample / count));
  }
  return sampled;
}
function interpolateInkPoint(start, end, amount) {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
    pressure: start.pressure + (end.pressure - start.pressure) * amount,
    tiltX: start.tiltX === void 0 || end.tiltX === void 0 ? end.tiltX : start.tiltX + (end.tiltX - start.tiltX) * amount,
    tiltY: start.tiltY === void 0 || end.tiltY === void 0 ? end.tiltY : start.tiltY + (end.tiltY - start.tiltY) * amount,
    t: start.t + (end.t - start.t) * amount
  };
}
function cloneNotebook(notebook) {
  return {
    ...notebook,
    pageOrder: [...notebook.pageOrder],
    deletedPages: { ...notebook.deletedPages },
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
function clonePage(page) {
  return { ...page, strokes: page.strokes.map(cloneStroke), deletedStrokeIds: [...page.deletedStrokeIds] };
}
function clonePageAsNew(page, title, now = Date.now()) {
  const pageId = newId("page");
  return {
    ...clonePage(page),
    id: pageId,
    title,
    strokes: page.strokes.map((stroke) => ({ ...cloneStroke(stroke), id: newId("stroke"), pageId, createdAt: now, updatedAt: now })),
    deletedStrokeIds: [],
    createdAt: now,
    updatedAt: now
  };
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
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const points of pointSets) for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}
function notebooksEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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
var NotebookFormatError = class extends Error {
  constructor(message = "Ink notebook contains invalid JSON") {
    super(message);
    this.name = "NotebookFormatError";
  }
};
var NotebookStore = class {
  constructor(app) {
    this.selfWrites = /* @__PURE__ */ new Map();
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
      } catch (error) {
        throw new NotebookFormatError(`Cannot save ${file.path || "notebook"}: existing file is not valid JSON`);
      }
      merged = mergeNotebooks(latest, next);
      const serialized = serialize(merged);
      this.selfWrites.set(file.path, serialized);
      return serialized;
    });
    return merged;
  }
  async list() {
    return this.vault.getFiles().filter((file) => file.extension === INK_EXTENSION && file.path.startsWith(`${INK_FOLDER}/`));
  }
  observe(onChange) {
    const timers = /* @__PURE__ */ new Map();
    const handler = (file) => {
      if (!(file instanceof import_obsidian2.TFile) || file.extension !== INK_EXTENSION || !file.path.startsWith(`${INK_FOLDER}/`)) return;
      const expected = this.selfWrites.get(file.path);
      const notify = () => {
        timers.delete(file.path);
        onChange(file);
      };
      const existing = timers.get(file.path);
      if (existing !== void 0) globalThis.clearTimeout(existing);
      if (!expected) {
        timers.set(file.path, globalThis.setTimeout(notify, 75));
        return;
      }
      void this.vault.cachedRead(file).then((raw) => {
        if (this.selfWrites.get(file.path) === expected) this.selfWrites.delete(file.path);
        if (raw !== expected) timers.set(file.path, globalThis.setTimeout(notify, 75));
      }).catch(() => {
        this.selfWrites.delete(file.path);
        timers.set(file.path, globalThis.setTimeout(notify, 75));
      });
    };
    const ref = this.vault.on("modify", handler);
    return () => {
      for (const timer of timers.values()) globalThis.clearTimeout(timer);
      timers.clear();
      this.vault.offref(ref);
    };
  }
  async ensureFolder() {
    if (!this.vault.getAbstractFileByPath(INK_FOLDER)) await this.vault.createFolder(INK_FOLDER);
  }
};
function serialize(notebook) {
  return `${JSON.stringify(notebook, null, 2)}
`;
}

// src/embed.ts
var import_obsidian3 = require("obsidian");

// src/embed-spec.ts
function parseInkEmbed(source) {
  var _a, _b;
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const path = (_a = lines[0]) != null ? _a : "";
  if (!path.startsWith(`${INK_FOLDER}/`) || !path.toLowerCase().endsWith(".ink") || path.includes("..")) {
    throw new Error(`Ink path must be a .ink file inside ${INK_FOLDER}/`);
  }
  if (lines.length > 2 || lines[1] && !/^page:\s*\S+$/i.test(lines[1])) {
    throw new Error("Optional second line must use: page: <page-id>");
  }
  return { path, pageId: (_b = lines[1]) == null ? void 0 : _b.replace(/^page:\s*/i, "") };
}

// src/embed.ts
function createInkEmbedProcessor(app, open) {
  return (source, el, context) => {
    let spec;
    try {
      spec = parseInkEmbed(source);
    } catch (error) {
      renderError(el, error);
      return;
    }
    context.addChild(new InkEmbedChild(app, el, spec, open));
  };
}
var InkEmbedChild = class extends import_obsidian3.MarkdownRenderChild {
  constructor(app, container, spec, open) {
    super(container);
    this.app = app;
    this.spec = spec;
    this.open = open;
    this.renderRevision = 0;
  }
  onload() {
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof import_obsidian3.TFile && file.path === this.spec.path) void this.render().catch((error) => renderError(this.containerEl, error));
    }));
    void this.render().catch((error) => renderError(this.containerEl, error));
  }
  async render() {
    var _a;
    const revision = ++this.renderRevision;
    const el = this.containerEl;
    el.empty();
    el.addClass("ink-embed");
    const file = this.app.vault.getAbstractFileByPath(this.spec.path);
    if (!(file instanceof import_obsidian3.TFile)) {
      renderError(el, new Error(`Ink notebook not found: ${this.spec.path}`));
      return;
    }
    let notebook;
    try {
      notebook = normalizeNotebook(JSON.parse(await this.app.vault.cachedRead(file)));
    } catch (e2) {
      renderError(el, new Error(`Ink notebook is damaged: ${this.spec.path}`));
      return;
    }
    if (revision !== this.renderRevision) return;
    const page = this.spec.pageId ? notebook.pages.find((candidate) => candidate.id === this.spec.pageId) : notebook.pages[0];
    if (!page) {
      renderError(el, new Error(`Ink page not found: ${(_a = this.spec.pageId) != null ? _a : "first page"}`));
      return;
    }
    const frame = el.createDiv({ cls: `ink-embed-page ink-paper-${page.paper}` });
    frame.style.aspectRatio = `${notebook.pageWidth} / ${notebook.pageHeight}`;
    const canvas = frame.createEl("canvas", { attr: { "aria-label": `Ink preview: ${page.title}` } });
    drawPage(canvas, notebook, page);
    const button = el.createEl("button", { cls: "ink-embed-open", attr: { type: "button", "aria-label": "Open Ink notebook" } });
    (0, import_obsidian3.setIcon)(button, "external-link");
    button.createSpan({ text: "Open notebook" });
    button.addEventListener("click", () => void this.open(file, page.id));
  }
};
function drawPage(canvas, notebook, page) {
  const width = Math.min(1200, notebook.pageWidth);
  const height = Math.round(width * notebook.pageHeight / notebook.pageWidth);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  for (const stroke of page.strokes) drawInkStroke(ctx, stroke, width, height);
}
function renderError(el, error) {
  el.empty();
  el.createDiv({ cls: "ink-embed-error", text: error instanceof Error ? error.message : String(error) });
}

// src/main.ts
var InkNotesPlugin = class extends import_obsidian4.Plugin {
  constructor() {
    super(...arguments);
    this.refreshTimers = /* @__PURE__ */ new Map();
    this.refreshing = /* @__PURE__ */ new Set();
    this.pendingRefresh = /* @__PURE__ */ new Set();
  }
  async onload() {
    this.store = new NotebookStore(this.app);
    this.registerView(VIEW_TYPE_INK, (leaf) => this.createView(leaf));
    this.registerExtensions([INK_EXTENSION], VIEW_TYPE_INK);
    this.addRibbonIcon("pen-line", "Open Ink Notes", () => void this.openNotebook());
    this.addCommand({ id: "open-ink-notebook", name: "Open Ink Notebook", callback: () => void this.openNotebook() });
    this.addCommand({ id: "create-ink-notebook", name: "Create Ink Notebook", callback: () => void this.createNotebook() });
    this.registerMarkdownCodeBlockProcessor("ink", createInkEmbedProcessor(this.app, (file, pageId) => this.openFile(file, pageId)));
    this.register(this.store.observe((file) => this.queueRefresh(file)));
    this.register(() => {
      for (const timer of this.refreshTimers.values()) window.clearTimeout(timer);
      this.refreshTimers.clear();
    });
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
    new NotebookSuggestModal(this.app, files, (file) => void this.openFile(file)).open();
  }
  async createNotebook() {
    const file = await this.store.create("Ink Notebook");
    await this.openFile(file);
  }
  async openFile(file, pageId) {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    if (pageId && leaf.view instanceof InkView) leaf.view.revealPage(pageId);
  }
  queueRefresh(file) {
    const existing = this.refreshTimers.get(file.path);
    if (existing !== void 0) window.clearTimeout(existing);
    this.refreshTimers.set(file.path, window.setTimeout(() => {
      this.refreshTimers.delete(file.path);
      void this.refreshFile(file);
    }, 120));
  }
  async refreshFile(file) {
    var _a;
    if (this.refreshing.has(file.path)) {
      this.pendingRefresh.add(file.path);
      return;
    }
    this.refreshing.add(file.path);
    try {
      do {
        this.pendingRefresh.delete(file.path);
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
          if (leaf.view instanceof InkView && ((_a = leaf.view.file) == null ? void 0 : _a.path) === file.path) await leaf.view.reloadFromDisk();
        }
      } while (this.pendingRefresh.has(file.path));
    } catch (error) {
      new import_obsidian4.Notice(`Ink Notes could not reload ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.refreshing.delete(file.path);
    }
  }
};
var NotebookSuggestModal = class extends import_obsidian4.SuggestModal {
  constructor(app, files, select) {
    super(app);
    this.files = files;
    this.select = select;
  }
  getSuggestions(query) {
    const search = query.trim().toLowerCase();
    return this.files.filter((file) => !search || file.path.toLowerCase().includes(search));
  }
  renderSuggestion(file, el) {
    el.setText(file.path);
  }
  onChooseSuggestion(file) {
    this.select(file);
  }
};
//# sourceMappingURL=main.js.map
