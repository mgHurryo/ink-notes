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
  const pressures = smoothPenPressures(stroke.points);
  return R(stroke.points.map((point, index) => [point.x * width, point.y * height, pressures[index]]), {
    // Preserve the existing diameter: width * (0.55 + pressure * 0.75).
    size: stroke.width * 0.925,
    thinning: 0.75 / 1.85,
    simulatePressure: false,
    // Input is the raw captured trajectory; a position filter here would pull
    // sparse fast corners away from the saved trajectory.
    streamline: 0,
    smoothing: 0.65,
    last: true,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 }
  });
}
function smoothPenPressures(points) {
  if (points.length < 3) return points.map((point) => point.pressure);
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return point.pressure;
    return median3(points[index - 1].pressure, point.pressure, points[index + 1].pressure);
  });
}
function median3(a2, b2, c2) {
  return Math.max(Math.min(a2, b2), Math.min(Math.max(a2, b2), c2));
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
    path.moveTo(first[0], first[1]);
    for (let index = 1; index < outline.length; index++) {
      const point = outline[index];
      path.lineTo(point[0], point[1]);
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
var BLEED = 4;
var MAX_PIXELS = 16e6;
var MAX_TILE_DENSITY = 9;
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
      this.upsert(stroke, order);
    });
    for (const [id, entry] of this.entries) if (!retained.has(id)) this.removeEntry(entry);
  }
  upsert(stroke, order) {
    const previous = this.entries.get(stroke.id);
    const style = [stroke.tool, stroke.color, stroke.width, stroke.opacity].join(":");
    if ((previous == null ? void 0 : previous.stroke) === stroke && previous.points === stroke.points && previous.count === stroke.points.length && previous.revision === stroke.updatedAt && previous.style === style) {
      previous.order = order;
      return [];
    }
    if (previous) this.removeEntry(previous);
    const padding = stroke.width * 0.7 + BLEED;
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
    return keys;
  }
  patch(upsert, remove, order) {
    var _a, _b;
    const changed = /* @__PURE__ */ new Set();
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
      for (const cell of (_a = previous == null ? void 0 : previous.cells) != null ? _a : []) changed.add(cell);
      for (const cell of this.upsert(stroke, (_b = positions.get(stroke.id)) != null ? _b : Number.MAX_SAFE_INTEGER)) changed.add(cell);
    }
    for (const [id, entry] of this.entries) {
      const position = positions.get(id);
      if (position !== void 0) entry.order = position;
    }
    return [...changed];
  }
  remove(ids) {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) this.removeEntry(entry);
    }
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
  cellsFor(strokes) {
    var _a, _b;
    const cells = /* @__PURE__ */ new Set();
    for (const stroke of strokes) for (const cell of (_b = (_a = this.entries.get(stroke.id)) == null ? void 0 : _a.cells) != null ? _b : []) cells.add(cell);
    return [...cells];
  }
  removeEntry(entry) {
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
function tileDensity(viewport, density) {
  void viewport;
  return Math.max(0.5, Math.min(MAX_TILE_DENSITY, Math.ceil(density * 4) / 4));
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
    this.inkFrame = null;
    this.inkCommit = null;
    this.inkCommitPaused = false;
    this.heldCells = /* @__PURE__ */ new Set();
    this.sequence = 0;
    this.pixels = 0;
    this.disposed = false;
    this.renderGeneration = 0;
    this.backend = null;
    this.backendError = null;
    this.pendingTiles = /* @__PURE__ */ new Map();
    this.displayScale = 1;
  }
  setBackend(backend, onError) {
    var _a, _b;
    this.renderGeneration += 1;
    (_b = (_a = this.backend) == null ? void 0 : _a.cancelGeneration) == null ? void 0 : _b.call(_a, this.renderGeneration);
    this.backend = backend;
    this.backendError = onError != null ? onError : null;
    this.jobs = [];
    this.pendingTiles.clear();
  }
  setPage(page, width, height, exclude) {
    var _a, _b;
    this.renderGeneration += 1;
    (_b = (_a = this.backend) == null ? void 0 : _a.cancelGeneration) == null ? void 0 : _b.call(_a, this.renderGeneration);
    const state = this.state(page, width, height);
    this.pendingTiles.clear();
    if (state !== this.active) {
      this.cancelInkCommit();
      this.host.replaceChildren();
      this.active = state;
      this.jobs = [];
    }
    state.index.sync(page.strokes, exclude);
  }
  setDisplayScale(scale) {
    this.displayScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    for (const tile of this.cache.values()) this.sizeTile(tile);
  }
  sync(strokes, exclude) {
    var _a;
    (_a = this.active) == null ? void 0 : _a.index.sync(strokes, exclude);
  }
  patchStrokes(upsert, remove, order) {
    var _a, _b;
    return (_b = (_a = this.active) == null ? void 0 : _a.index.patch(upsert, remove, order)) != null ? _b : [];
  }
  removeStrokes(ids) {
    var _a;
    (_a = this.active) == null ? void 0 : _a.index.remove(ids);
  }
  queryNear(point, radius) {
    var _a, _b;
    return (_b = (_a = this.active) == null ? void 0 : _a.index.queryNear(point, radius)) != null ? _b : [];
  }
  previewInteractiveCells(cells, viewport, density) {
    if (!this.active || this.disposed || cells.length === 0) return;
    this.viewport = viewport;
    this.density = tileDensity(viewport, density);
    this.visible = new Set(cellKeys(viewport, this.active.index.width, this.active.index.height));
    for (const cell of new Set(cells)) {
      if (!this.visible.has(cell)) continue;
      const exact = this.get(this.active, cell, this.density);
      const tile = exact != null ? exact : this.paint({ state: this.active, cell, density: this.density, priority: "visible" });
      this.attach(tile);
    }
    this.evict();
  }
  flushVisible() {
    const jobs = this.jobs.filter((job) => job.state === this.active && this.visible.has(job.cell) && !this.isHeld(job));
    this.jobs = this.jobs.filter((job) => !jobs.includes(job));
    for (const job of jobs) {
      const tile = this.get(job.state, job.cell, job.density);
      if (tile) this.attach(tile);
      else if (this.backend) this.requestWorkerTile(job);
      else this.attach(this.paint(job));
    }
    this.evict();
  }
  commitInteractive(viewport, density, refine = true, onComplete = () => void 0) {
    var _a, _b, _c;
    this.cancelInkCommit();
    if (!this.active || this.disposed) {
      onComplete(false);
      return;
    }
    this.renderGeneration += 1;
    (_b = (_a = this.backend) == null ? void 0 : _a.cancelGeneration) == null ? void 0 : _b.call(_a, this.renderGeneration);
    this.viewport = viewport;
    this.density = tileDensity(viewport, refine ? density : Math.min(1, density));
    this.visible = new Set(cellKeys(viewport, this.active.index.width, this.active.index.height));
    for (const node of Array.from(this.host.children)) {
      if (!this.visible.has((_c = node.dataset.cell) != null ? _c : "")) node.remove();
    }
    const jobs = [];
    for (const cell of this.visible) {
      if (!this.get(this.active, cell, this.density)) jobs.push({ state: this.active, cell, density: this.density, priority: "visible" });
    }
    if (jobs.length === 0) {
      onComplete(true);
      return;
    }
    const cells = jobs.map((job) => job.cell);
    for (const cell of cells) this.heldCells.add(this.holdKey(this.active, cell));
    this.jobs = this.jobs.filter((job) => !this.isHeld(job));
    this.inkCommit = {
      state: this.active,
      strokes: [],
      cells,
      jobs,
      tiles: [],
      onComplete,
      invalid: false,
      generation: this.renderGeneration
    };
    this.scheduleInkCommit();
  }
  commitInk(strokes, viewport, density, onComplete) {
    if (!this.active || this.disposed || this.inkCommit) {
      onComplete(false);
      return;
    }
    this.viewport = viewport;
    this.density = tileDensity(viewport, density);
    this.visible = new Set(cellKeys(viewport, this.active.index.width, this.active.index.height));
    const cells = this.active.index.cellsFor(strokes).filter((cell) => this.visible.has(cell));
    const jobs = [];
    const tiles = [];
    for (const cell of cells) {
      this.heldCells.add(this.holdKey(this.active, cell));
      const exact = this.get(this.active, cell, this.density);
      if (exact) tiles.push(exact);
      else jobs.push({ state: this.active, cell, density: this.density });
    }
    this.jobs = this.jobs.filter((job) => !this.isHeld(job));
    this.inkCommit = { state: this.active, strokes, cells, jobs, tiles, onComplete, invalid: false, generation: this.renderGeneration };
    if (jobs.length === 0) this.finishInkCommit(true);
    else this.scheduleInkCommit();
  }
  pauseInkCommit() {
    this.inkCommitPaused = true;
    if (this.inkFrame !== null) cancelAnimationFrame(this.inkFrame);
    this.inkFrame = null;
    if (this.inkCommit) this.abortInkCommit(true);
  }
  beginInput() {
    var _a, _b;
    this.renderGeneration += 1;
    (_b = (_a = this.backend) == null ? void 0 : _a.cancelGeneration) == null ? void 0 : _b.call(_a, this.renderGeneration);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.jobs = [];
    this.pendingTiles.clear();
  }
  resumeInkCommit() {
    this.inkCommitPaused = false;
    this.scheduleInkCommit();
    this.schedule();
  }
  cancelInkCommit() {
    this.abortInkCommit(true);
  }
  update(viewport, density, refine) {
    var _a;
    if (!this.active || this.disposed) return;
    this.viewport = viewport;
    this.density = tileDensity(viewport, density);
    this.visible = new Set(cellKeys(viewport, this.active.index.width, this.active.index.height));
    this.jobs = [];
    for (const node of Array.from(this.host.children)) {
      if (!this.visible.has((_a = node.dataset.cell) != null ? _a : "")) node.remove();
    }
    for (const cell of this.visible) {
      const exact = this.get(this.active, cell, this.density);
      const fallback = exact != null ? exact : this.fallback(this.active, cell);
      if (fallback) this.attach(fallback);
      if (!exact && (refine || !fallback)) {
        const job = { state: this.active, cell, density: refine ? this.density : Math.min(1, this.density), priority: "visible" };
        if (!this.isHeld(job)) this.jobs.push(job);
      }
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
        if (!this.get(state, cell, this.density)) this.jobs.push({ state, cell, density: this.density, priority: "prewarm" });
      }
    }
    this.schedule();
  }
  dispose() {
    var _a, _b;
    this.disposed = true;
    this.renderGeneration += 1;
    (_b = (_a = this.backend) == null ? void 0 : _a.cancelGeneration) == null ? void 0 : _b.call(_a, this.renderGeneration);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.abortInkCommit(false);
    for (const [key, tile] of this.cache) this.drop(key, tile);
    this.states.clear();
    this.jobs = [];
    this.pendingTiles.clear();
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
    if (this.frame !== null || !this.jobs.length || this.disposed || this.inkCommitPaused || this.inkCommit) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
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
  scheduleInkCommit() {
    if (this.inkFrame !== null || !this.inkCommit || this.inkCommitPaused || this.disposed) return;
    this.inkFrame = requestAnimationFrame(() => {
      var _a, _b;
      this.inkFrame = null;
      const commit = this.inkCommit;
      if (!commit) return;
      const job = commit.jobs.shift();
      if (!job) {
        this.finishInkCommit(true);
        return;
      }
      if (this.backend) {
        const generation = this.renderGeneration;
        this.backend.renderTile(
          job.state.page.id,
          job.cell,
          job.density,
          (_a = job.state.index.revisions.get(job.cell)) != null ? _a : 0,
          job.state.index.width,
          job.state.index.height,
          generation,
          (_b = job.priority) != null ? _b : "visible"
        ).then((result) => {
          var _a2;
          if (this.inkCommit !== commit || commit.generation !== this.renderGeneration || result.renderGeneration !== generation || result.pageId !== job.state.page.id || result.cell !== job.cell || this.disposed) {
            result.bitmap.close();
            return;
          }
          if (result.revision === ((_a2 = job.state.index.revisions.get(job.cell)) != null ? _a2 : 0)) commit.tiles.push(this.tileFromBitmap(job, result));
          else commit.invalid = true;
          if (commit.jobs.length > 0) this.scheduleInkCommit();
          else this.finishInkCommit(true);
        }).catch((error) => {
          var _a2;
          if (this.inkCommit === commit) {
            if (isStaleRenderError(error)) {
              this.finishInkCommit(false);
              return;
            }
            (_a2 = this.backendError) == null ? void 0 : _a2.call(this, error);
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
  finishInkCommit(requested) {
    const commit = this.inkCommit;
    if (!commit) return;
    const valid = requested && !commit.invalid && !this.disposed && this.active === commit.state && commit.tiles.every((tile) => {
      var _a;
      return tile.revision === ((_a = tile.state.index.revisions.get(tile.cell)) != null ? _a : 0);
    });
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
        tile.node.remove();
        tile.canvas.width = tile.canvas.height = 1;
      }
    }
    commit.onComplete(valid);
    this.schedule();
  }
  abortInkCommit(notify) {
    const commit = this.inkCommit;
    if (!commit) {
      this.inkFrame = null;
      return;
    }
    if (this.inkFrame !== null) cancelAnimationFrame(this.inkFrame);
    this.inkFrame = null;
    if (notify) this.finishInkCommit(false);
    else {
      this.inkCommit = null;
      for (const cell of commit.cells) this.heldCells.delete(this.holdKey(commit.state, cell));
      for (const tile of commit.tiles) if (this.cache.get(this.key(tile.state, tile.cell, tile.density)) !== tile) {
        tile.node.remove();
        tile.canvas.width = tile.canvas.height = 1;
      }
    }
  }
  holdKey(state, cell) {
    return state.id + "/" + cell;
  }
  isHeld(job) {
    return this.heldCells.has(this.holdKey(job.state, job.cell));
  }
  paint(job) {
    const tile = this.createTile(job);
    this.cacheTile(tile);
    return tile;
  }
  requestWorkerTile(job) {
    var _a, _b;
    if (!this.backend || this.disposed) return;
    const key = this.key(job.state, job.cell, job.density);
    if (this.pendingTiles.get(key) === this.renderGeneration) return;
    const revision = (_a = job.state.index.revisions.get(job.cell)) != null ? _a : 0;
    const generation = this.renderGeneration;
    this.pendingTiles.set(key, generation);
    this.backend.renderTile(
      job.state.page.id,
      job.cell,
      job.density,
      revision,
      job.state.index.width,
      job.state.index.height,
      generation,
      (_b = job.priority) != null ? _b : "visible"
    ).then((result) => {
      var _a2;
      if (this.pendingTiles.get(key) === generation) this.pendingTiles.delete(key);
      if (this.disposed || generation !== this.renderGeneration || result.pageId !== job.state.page.id || result.cell !== job.cell) {
        result.bitmap.close();
        return;
      }
      const currentRevision = (_a2 = job.state.index.revisions.get(job.cell)) != null ? _a2 : 0;
      if (result.revision !== currentRevision || result.density !== job.density || result.renderGeneration !== generation) {
        result.bitmap.close();
        this.schedule();
        return;
      }
      const tile = this.tileFromBitmap(job, result);
      this.cacheTile(tile);
      if (job.state === this.active && this.visible.has(job.cell)) this.attach(tile);
      this.evict();
      this.schedule();
    }).catch((error) => {
      var _a2;
      if (this.pendingTiles.get(key) === generation) this.pendingTiles.delete(key);
      if (isStaleRenderError(error)) {
        this.schedule();
        return;
      }
      (_a2 = this.backendError) == null ? void 0 : _a2.call(this, error);
      this.schedule();
    });
  }
  tileFromBitmap(job, result) {
    const canvas = document.createElement("canvas");
    canvas.width = result.canvasWidth;
    canvas.height = result.canvasHeight;
    const bitmapContext = canvas.getContext("bitmaprenderer");
    if (bitmapContext) bitmapContext.transferFromImageBitmap(result.bitmap);
    else {
      const context = canvas.getContext("2d");
      if (context) context.drawImage(result.bitmap, 0, 0);
      result.bitmap.close();
    }
    canvas.style.cssText = "position:absolute";
    const node = document.createElement("div");
    node.dataset.cell = result.cell;
    node.style.cssText = "position:absolute;overflow:hidden";
    node.appendChild(canvas);
    const tile = {
      node,
      canvas,
      revision: result.revision,
      pixels: result.canvasWidth * result.canvasHeight,
      used: ++this.sequence,
      state: job.state,
      cell: result.cell,
      density: result.density
    };
    this.sizeTile(tile);
    return tile;
  }
  createTile(job) {
    return this.createTileFrom(job);
  }
  createInkTile(job, strokes) {
    var _a;
    const revision = (_a = job.state.index.revisions.get(job.cell)) != null ? _a : 0;
    const additions = strokes.filter((stroke) => job.state.index.cellsFor([stroke]).includes(job.cell));
    const previous = this.cache.get(this.key(job.state, job.cell, job.density));
    const base = previous && previous.revision + additions.length === revision ? previous : void 0;
    return this.createTileFrom(job, base, additions);
  }
  createTileFrom(job, base, additions = []) {
    var _a;
    const { state, cell, density } = job;
    const [column, row] = cell.split(":").map(Number);
    const x2 = column * TILE, y2 = row * TILE;
    const width = Math.min(TILE, state.index.width - x2), height = Math.min(TILE, state.index.height - y2);
    const canvas = document.createElement("canvas");
    const bleedPixels = Math.ceil(BLEED * density);
    canvas.width = Math.ceil(width * density) + bleedPixels * 2;
    canvas.height = Math.ceil(height * density) + bleedPixels * 2;
    canvas.style.cssText = "position:absolute";
    const node = document.createElement("div");
    node.dataset.cell = cell;
    node.style.cssText = "position:absolute;overflow:hidden";
    node.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (base) ctx.drawImage(base.canvas, 0, 0);
    ctx.setTransform(density, 0, 0, density, bleedPixels - x2 * density, bleedPixels - y2 * density);
    const rect = { x: x2, y: y2, width, height };
    const strokes = base ? additions : state.index.query(rect);
    for (const stroke of strokes) drawInkStroke(ctx, stroke, state.index.width, state.index.height);
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
    this.sizeTile(tile);
    return tile;
  }
  sizeTile(tile) {
    var _a;
    const [column, row] = tile.cell.split(":").map(Number);
    const x2 = column * TILE, y2 = row * TILE;
    const width = Math.min(TILE, tile.state.index.width - x2), height = Math.min(TILE, tile.state.index.height - y2);
    const scale = (_a = this.displayScale) != null ? _a : 1;
    tile.canvas.style.left = `${-BLEED * scale}px`;
    tile.canvas.style.top = `${-BLEED * scale}px`;
    tile.canvas.style.width = `${tile.canvas.width / tile.density * scale}px`;
    tile.canvas.style.height = `${tile.canvas.height / tile.density * scale}px`;
    tile.node.style.left = `${x2 * scale}px`;
    tile.node.style.top = `${y2 * scale}px`;
    tile.node.style.width = `${width * scale}px`;
    tile.node.style.height = `${height * scale}px`;
  }
  cacheTile(tile) {
    const { state, cell, density } = tile;
    const key = this.key(state, cell, density);
    const old = this.cache.get(key);
    if (old === tile) return;
    if (old) this.drop(key, old);
    this.cache.set(key, tile);
    this.pixels += tile.pixels;
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
function isStaleRenderError(error) {
  return typeof error === "object" && error !== null && error.code === "stale-generation";
}

// src/stroke-modeler.ts
var DEFAULT_STROKE_MODEL_PARAMS = {
  wobbleSmoother: { enabled: true, timeout: 0.04, speedFloor: 1.31, speedCeiling: 1.44 },
  positionModeler: { springMassConstant: 11 / 32400, dragConstant: 72 },
  sampling: {
    minOutputRate: 180,
    endOfStrokeStoppingDistance: 1e-3,
    endOfStrokeMaxIterations: 20,
    maxOutputsPerCall: 1e5
  }
};
function strokeModelParamsForSmoothStrength(strength) {
  const value = Math.max(1, Math.min(100, strength));
  const amount = value <= 50 ? (value - 1) / 49 : (value - 50) / 50;
  const floor = value <= 50 ? interp(2.62, 1.31, amount) : interp(1.31, 0.65, amount);
  const ceiling = value <= 50 ? interp(2.88, 1.44, amount) : interp(1.44, 0.72, amount);
  const timeout = value <= 50 ? interp(0.016, 0.04, amount) : interp(0.04, 0.08, amount);
  const springFactor = value <= 50 ? interp(0.5, 1, amount) : interp(1, 2, amount);
  const springMassConstant = DEFAULT_STROKE_MODEL_PARAMS.positionModeler.springMassConstant * springFactor;
  return {
    wobbleSmoother: { enabled: true, timeout, speedFloor: floor, speedCeiling: ceiling },
    positionModeler: { springMassConstant, dragConstant: DEFAULT_STROKE_MODEL_PARAMS.positionModeler.dragConstant },
    // A softer spring needs proportionally more steps to land the stroke end
    // on the lift point within the stopping distance.
    sampling: { ...DEFAULT_STROKE_MODEL_PARAMS.sampling, endOfStrokeMaxIterations: Math.ceil(DEFAULT_STROKE_MODEL_PARAMS.sampling.endOfStrokeMaxIterations * springFactor) }
  };
}
function copyTip(state) {
  return {
    position: { ...state.position },
    velocity: { ...state.velocity },
    acceleration: { ...state.acceleration },
    time: state.time
  };
}
function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
function interp(start, end, amount) {
  return start + (end - start) * clamp01(amount);
}
function interpPosition(start, end, amount) {
  return { x: interp(start.x, end.x, amount), y: interp(start.y, end.y, amount) };
}
function distance(a2, b2) {
  return Math.hypot(a2.x - b2.x, a2.y - b2.y);
}
function dotProduct(a2, b2) {
  return a2.x * b2.x + a2.y * b2.y;
}
function normalize01(start, end, value) {
  if (start === end) return value > start ? 1 : 0;
  return clamp01((value - start) / (end - start));
}
function nearestPointOnSegment(start, end, point) {
  if (start.x === end.x && start.y === end.y) return 0;
  const segmentVector = { x: end.x - start.x, y: end.y - start.y };
  const projectionVector = { x: point.x - start.x, y: point.y - start.y };
  return clamp01(dotProduct(projectionVector, segmentVector) / dotProduct(segmentVector, segmentVector));
}
function springAcceleration(tip, anchor, params) {
  return {
    x: (anchor.x - tip.position.x) / params.springMassConstant - params.dragConstant * tip.velocity.x,
    y: (anchor.y - tip.position.y) / params.springMassConstant - params.dragConstant * tip.velocity.y
  };
}
var WobbleSmoother = class {
  constructor() {
    this.samples = [];
    this.weightedPositionSum = { x: 0, y: 0 };
    this.distanceSum = 0;
    this.durationSum = 0;
  }
  reset(params, position, time) {
    this.params = params;
    this.samples = [{ position, weightedPosition: { x: 0, y: 0 }, distance: 0, duration: 0, time }];
    this.weightedPositionSum = { x: 0, y: 0 };
    this.distanceSum = 0;
    this.durationSum = 0;
  }
  update(position, time) {
    if (!this.params.enabled) return position;
    const back = this.samples[this.samples.length - 1];
    const deltaTime = time - back.time;
    const segmentDistance = distance(position, back.position);
    this.samples.push({
      position,
      weightedPosition: { x: position.x * deltaTime, y: position.y * deltaTime },
      distance: segmentDistance,
      duration: deltaTime,
      time
    });
    this.weightedPositionSum.x += position.x * deltaTime;
    this.weightedPositionSum.y += position.y * deltaTime;
    this.distanceSum += segmentDistance;
    this.durationSum += deltaTime;
    while (this.samples.length > 1 && this.samples[0].time < time - this.params.timeout) {
      const front = this.samples.shift();
      this.weightedPositionSum.x -= front.weightedPosition.x;
      this.weightedPositionSum.y -= front.weightedPosition.y;
      this.distanceSum -= front.distance;
      this.durationSum -= front.duration;
    }
    if (this.durationSum === 0) return position;
    const averagePosition = {
      x: this.weightedPositionSum.x / this.durationSum,
      y: this.weightedPositionSum.y / this.durationSum
    };
    const averageSpeed = this.distanceSum / this.durationSum;
    return interpPosition(averagePosition, position, normalize01(this.params.speedFloor, this.params.speedCeiling, averageSpeed));
  }
};
var PositionModeler = class {
  reset(state, params) {
    this.state = state;
    this.params = params;
  }
  update(anchor, time) {
    const state = this.state;
    const deltaTime = time - state.time;
    const acceleration = springAcceleration(state, anchor, this.params);
    state.acceleration = acceleration;
    state.velocity = {
      x: state.velocity.x + deltaTime * acceleration.x,
      y: state.velocity.y + deltaTime * acceleration.y
    };
    state.position = {
      x: state.position.x + deltaTime * state.velocity.x,
      y: state.position.y + deltaTime * state.velocity.y
    };
    state.time = time;
    return copyTip(state);
  }
  currentState() {
    return this.state;
  }
  /** Interpolates the anchor linearly from start to end over nSamples steps. */
  updateAlongLinearPath(startAnchor, startTime, endAnchor, endTime, nSamples, output) {
    for (let index = 1; index <= nSamples; index++) {
      const amount = index / nSamples;
      output.push(this.update(interpPosition(startAnchor, endAnchor, amount), interp(startTime, endTime, amount)));
    }
  }
  /** Repeatedly updates toward the final anchor, halving the step on overshoot. */
  modelEndOfStroke(anchor, deltaTime, maxIterations, stopDistance, output) {
    for (let index = 0; index < maxIterations; index++) {
      const previousState = copyTip(this.state);
      const candidate = this.update(anchor, previousState.time + deltaTime);
      if (distance(previousState.position, candidate.position) < stopDistance) return;
      if (nearestPointOnSegment(previousState.position, candidate.position, anchor) < 1) {
        deltaTime *= 0.5;
        this.state = previousState;
        continue;
      }
      output.push(candidate);
      if (distance(candidate.position, anchor) < stopDistance) return;
    }
  }
};
var StylusStateModeler = class {
  constructor() {
    this.samples = [];
    this.segmentIndex = 0;
    this.ratioAlongSegment = 0;
    this.receivedUnknownPressure = false;
    this.receivedUnknownTiltX = false;
    this.receivedUnknownTiltY = false;
  }
  reset() {
    this.samples = [];
    this.segmentIndex = 0;
    this.ratioAlongSegment = 0;
    this.receivedUnknownPressure = false;
    this.receivedUnknownTiltX = false;
    this.receivedUnknownTiltY = false;
  }
  update(position, time, pressure, tiltX, tiltY) {
    if (pressure === void 0 || !Number.isFinite(pressure)) this.receivedUnknownPressure = true;
    if (tiltX === void 0 || !Number.isFinite(tiltX)) this.receivedUnknownTiltX = true;
    if (tiltY === void 0 || !Number.isFinite(tiltY)) this.receivedUnknownTiltY = true;
    const back = this.samples[this.samples.length - 1];
    let velocity = { x: 0, y: 0 };
    if (back && time !== back.time) {
      velocity = {
        x: (position.x - back.position.x) / (time - back.time),
        y: (position.y - back.position.y) / (time - back.time)
      };
    }
    if (this.samples.length > 4096 && back && distance(position, back.position) < 0.01) {
      this.samples[this.samples.length - 1] = { position, velocity, time, pressure, tiltX, tiltY };
      return;
    }
    this.samples.push({ position, velocity, time, pressure, tiltX, tiltY });
  }
  project(tip) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (this.samples.length === 0) return {};
    this.projectToClosestPoint(tip.position);
    while (this.segmentIndex > 0) {
      this.segmentIndex--;
      this.samples.shift();
    }
    const start = this.samples[0];
    const end = (_a = this.samples[1]) != null ? _a : start;
    const amount = this.samples.length > 1 ? this.ratioAlongSegment : 0;
    return {
      pressure: this.receivedUnknownPressure ? void 0 : interp((_b = start.pressure) != null ? _b : 0, (_c = end.pressure) != null ? _c : 0, amount),
      tiltX: this.receivedUnknownTiltX ? void 0 : interp((_d = start.tiltX) != null ? _d : 0, (_e = end.tiltX) != null ? _e : 0, amount),
      tiltY: this.receivedUnknownTiltY ? void 0 : interp((_f = start.tiltY) != null ? _f : 0, (_g = end.tiltY) != null ? _g : 0, amount)
    };
  }
  projectToClosestPoint(position) {
    let bestDistance = Infinity;
    for (let index = 0; index < this.samples.length - 1; index++) {
      const ratio = nearestPointOnSegment(this.samples[index].position, this.samples[index + 1].position, position);
      if (index === this.segmentIndex && ratio < this.ratioAlongSegment) continue;
      const projected = interpPosition(this.samples[index].position, this.samples[index + 1].position, ratio);
      const currentDistance = distance(position, projected);
      if (currentDistance <= bestDistance) {
        this.segmentIndex = index;
        this.ratioAlongSegment = ratio;
        bestDistance = currentDistance;
      }
    }
  }
};
var StrokeModeler = class {
  constructor(params = DEFAULT_STROKE_MODEL_PARAMS) {
    this.wobbleSmoother = new WobbleSmoother();
    this.positionModeler = new PositionModeler();
    this.stylusStateModeler = new StylusStateModeler();
    this.lastInput = null;
    this.lastCorrectedPosition = { x: 0, y: 0 };
    this.params = params;
  }
  reset(params = DEFAULT_STROKE_MODEL_PARAMS) {
    this.params = params;
    this.lastInput = null;
  }
  /** True while a stroke is in progress (after down, before up). */
  get strokeInProgress() {
    return this.lastInput !== null;
  }
  update(input) {
    if (!Number.isFinite(input.time) || !Number.isFinite(input.position.x) || !Number.isFinite(input.position.y)) {
      throw new Error("Stroke modeler received a non-finite position or time");
    }
    if (this.lastInput) {
      if (input.time < this.lastInput.time) throw new Error("Stroke modeler inputs travel backwards in time");
      if (sameInput(this.lastInput, input)) return [];
    }
    switch (input.eventType) {
      case "down":
        return this.processDown(input);
      case "move":
        return this.processMove(input);
      case "up":
        return this.processUp(input);
      default:
        throw new Error(`Stroke modeler received an invalid event type: ${String(input.eventType)}`);
    }
  }
  processDown(input) {
    if (this.lastInput) throw new Error("Stroke modeler received a down event while a stroke is in progress");
    this.wobbleSmoother.reset(this.params.wobbleSmoother, input.position, input.time);
    this.positionModeler.reset({
      position: { ...input.position },
      velocity: { x: 0, y: 0 },
      acceleration: { x: 0, y: 0 },
      time: input.time
    }, this.params.positionModeler);
    this.stylusStateModeler.reset();
    this.stylusStateModeler.update(input.position, input.time, input.pressure, input.tiltX, input.tiltY);
    this.lastInput = input;
    this.lastCorrectedPosition = { ...input.position };
    return [{ position: { ...input.position }, time: input.time, pressure: input.pressure, tiltX: input.tiltX, tiltY: input.tiltY }];
  }
  processMove(input) {
    if (!this.lastInput) throw new Error("Stroke modeler received a move event while no stroke is in progress");
    const corrected = this.wobbleSmoother.update(input.position, input.time);
    this.stylusStateModeler.update(corrected, input.time, input.pressure, input.tiltX, input.tiltY);
    const nSteps = this.numberOfStepsBetweenInputs(input);
    const tipStates = [];
    this.positionModeler.updateAlongLinearPath(
      this.lastCorrectedPosition,
      this.lastInput.time,
      corrected,
      input.time,
      nSteps,
      tipStates
    );
    this.lastInput = input;
    this.lastCorrectedPosition = corrected;
    return this.modelStylus(tipStates);
  }
  processUp(input) {
    if (!this.lastInput) throw new Error("Stroke modeler received an up event while no stroke is in progress");
    const nSteps = this.numberOfStepsBetweenInputs(input);
    const tipStates = [];
    this.positionModeler.updateAlongLinearPath(
      this.lastCorrectedPosition,
      this.lastInput.time,
      input.position,
      input.time,
      nSteps,
      tipStates
    );
    this.positionModeler.modelEndOfStroke(
      input.position,
      1 / this.params.sampling.minOutputRate,
      this.params.sampling.endOfStrokeMaxIterations,
      this.params.sampling.endOfStrokeStoppingDistance,
      tipStates
    );
    if (tipStates.length === 0) tipStates.push(copyTip(this.positionModeler.currentState()));
    this.stylusStateModeler.update(input.position, input.time, input.pressure, input.tiltX, input.tiltY);
    const results = this.modelStylus(tipStates);
    this.lastInput = null;
    return results;
  }
  numberOfStepsBetweenInputs(input) {
    const tip = this.positionModeler.currentState();
    const deltaTime = input.time - this.lastInput.time;
    let nSteps = Math.ceil(deltaTime * this.params.sampling.minOutputRate);
    if (this.params.sampling.maxOutputsPerCall > 0 && nSteps > this.params.sampling.maxOutputsPerCall) {
      throw new Error(`Stroke modeler input events are too far apart; requested ${nSteps} > ${this.params.sampling.maxOutputsPerCall} samples`);
    }
    return Math.max(0, nSteps);
  }
  modelStylus(tipStates) {
    return tipStates.map((tip) => {
      const stylus = this.stylusStateModeler.project(tip);
      return { position: { ...tip.position }, time: tip.time, ...stylus };
    });
  }
};
function sameInput(left, right) {
  return left.eventType === right.eventType && left.time === right.time && left.position.x === right.position.x && left.position.y === right.position.y && left.pressure === right.pressure && left.tiltX === right.tiltX && left.tiltY === right.tiltY;
}

// ink-worker:ink-worker-source
var ink_worker_source_default = '(() => {\n  // src/model.ts\n  var DEFAULT_PAGE_WIDTH = 1600;\n  var DEFAULT_PAGE_HEIGHT = 2200;\n  function newId(prefix) {\n    const random = Math.random().toString(36).slice(2, 10);\n    return `${prefix}-${Date.now().toString(36)}-${random}`;\n  }\n  function createNotebook(title = "Ink Notebook") {\n    const now = Date.now();\n    const page = createPage("Page 1", "ruled", now);\n    return {\n      schema: 2,\n      title,\n      pageWidth: DEFAULT_PAGE_WIDTH,\n      pageHeight: DEFAULT_PAGE_HEIGHT,\n      pages: [page],\n      pageOrder: [page.id],\n      deletedPages: {},\n      pageOrderUpdatedAt: now,\n      updatedAt: now\n    };\n  }\n  function createPage(title, paper = "ruled", now = Date.now()) {\n    return { id: newId("page"), title, paper, strokes: [], deletedStrokeIds: [], createdAt: now, updatedAt: now };\n  }\n  function normalizeNotebook(value) {\n    if (!value || typeof value !== "object") return createNotebook();\n    const raw = value;\n    const pages = Array.isArray(raw.pages) ? raw.pages : [];\n    const normalizedPages = pages.map(normalizePage).filter((page) => page !== null);\n    const pageIds = new Set(normalizedPages.map((page) => page.id));\n    const legacyOrder = [...normalizedPages].sort((a2, b2) => a2.createdAt - b2.createdAt).map((page) => page.id);\n    const requestedOrder = Array.isArray(raw.pageOrder) ? raw.pageOrder.filter((id) => typeof id === "string") : legacyOrder;\n    const pageOrder = [.../* @__PURE__ */ new Set([...requestedOrder.filter((id) => pageIds.has(id)), ...legacyOrder.filter((id) => !requestedOrder.includes(id))])];\n    const deletedPages = raw.deletedPages && typeof raw.deletedPages === "object" ? Object.fromEntries(Object.entries(raw.deletedPages).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "number" && Number.isFinite(entry[1]))) : {};\n    const visiblePages = normalizedPages.filter((page) => !(page.id in deletedPages));\n    const visibleIds = new Set(visiblePages.map((page) => page.id));\n    const byId = new Map(visiblePages.map((page) => [page.id, page]));\n    const orderedPages = pageOrder.map((id) => byId.get(id)).filter((page) => page !== void 0);\n    if (orderedPages.length === 0) orderedPages.push(createPage("Page 1"));\n    return {\n      schema: 2,\n      title: typeof raw.title === "string" ? raw.title : "Ink Notebook",\n      pageWidth: finitePositive(raw.pageWidth, DEFAULT_PAGE_WIDTH),\n      pageHeight: finitePositive(raw.pageHeight, DEFAULT_PAGE_HEIGHT),\n      pages: orderedPages,\n      pageOrder: orderedPages.map((page) => page.id).filter((id) => visibleIds.has(id) || orderedPages.length === 1),\n      deletedPages,\n      pageOrderUpdatedAt: finitePositive(raw.pageOrderUpdatedAt, finitePositive(raw.updatedAt, Date.now())),\n      updatedAt: finitePositive(raw.updatedAt, Date.now())\n    };\n  }\n  function mergeNotebooks(base, incoming) {\n    var _a, _b, _c, _d, _e, _f, _g;\n    const pages = /* @__PURE__ */ new Map();\n    for (const page of base.pages) pages.set(page.id, page);\n    for (const page of incoming.pages) {\n      const existing = pages.get(page.id);\n      pages.set(page.id, existing ? mergePages(existing, page) : page);\n    }\n    const deletedPages = { ...(_a = base.deletedPages) != null ? _a : {} };\n    for (const [id, timestamp] of Object.entries((_b = incoming.deletedPages) != null ? _b : {})) deletedPages[id] = Math.max((_c = deletedPages[id]) != null ? _c : 0, timestamp);\n    for (const id of Object.keys(deletedPages)) pages.delete(id);\n    const orderSource = incoming.pageOrderUpdatedAt > base.pageOrderUpdatedAt || incoming.pageOrderUpdatedAt === base.pageOrderUpdatedAt && compareNotebookOrder(incoming, base) >= 0 ? incoming : base;\n    const preferred = (_d = orderSource.pageOrder) != null ? _d : [];\n    const known = preferred.map((id) => pages.get(id)).filter((page) => page !== void 0);\n    const additions = [...pages.values()].filter((page) => !preferred.includes(page.id)).sort((a2, b2) => a2.createdAt - b2.createdAt);\n    const ordered = [...known];\n    for (const page of additions) {\n      const inBase = ((_e = base.pageOrder) != null ? _e : []).includes(page.id);\n      const inIncoming = ((_f = incoming.pageOrder) != null ? _f : []).includes(page.id);\n      const source = inBase && !inIncoming ? base : incoming;\n      const sourceOrder = (_g = source.pageOrder) != null ? _g : source.pages.map((candidate) => candidate.id);\n      const sourceIndex = sourceOrder.indexOf(page.id);\n      let inserted = false;\n      for (let index = sourceIndex - 1; index >= 0; index--) {\n        const anchor = ordered.findIndex((candidate) => candidate.id === sourceOrder[index]);\n        if (anchor >= 0) {\n          ordered.splice(anchor + 1, 0, page);\n          inserted = true;\n          break;\n        }\n      }\n      if (!inserted) for (let index = sourceIndex + 1; index < sourceOrder.length; index++) {\n        const anchor = ordered.findIndex((candidate) => candidate.id === sourceOrder[index]);\n        if (anchor >= 0) {\n          ordered.splice(anchor, 0, page);\n          inserted = true;\n          break;\n        }\n      }\n      if (!inserted) {\n        const at = ordered.findIndex((candidate) => page.createdAt < candidate.createdAt);\n        ordered.splice(at < 0 ? ordered.length : at, 0, page);\n      }\n    }\n    const safePages = ordered.length ? ordered : [createPage("Page 1")];\n    const pageOrder = safePages.map((page) => page.id);\n    return {\n      ...incoming,\n      schema: 2,\n      title: incoming.updatedAt >= base.updatedAt ? incoming.title : base.title,\n      pageWidth: incoming.pageWidth || base.pageWidth,\n      pageHeight: incoming.pageHeight || base.pageHeight,\n      pages: safePages,\n      pageOrder,\n      deletedPages,\n      pageOrderUpdatedAt: Math.max(base.pageOrderUpdatedAt, incoming.pageOrderUpdatedAt),\n      updatedAt: Math.max(base.updatedAt, incoming.updatedAt)\n    };\n  }\n  function compareNotebookOrder(left, right) {\n    var _a, _b;\n    const leftOrder = JSON.stringify((_a = left.pageOrder) != null ? _a : []);\n    const rightOrder = JSON.stringify((_b = right.pageOrder) != null ? _b : []);\n    return leftOrder < rightOrder ? -1 : leftOrder > rightOrder ? 1 : 0;\n  }\n  function mergePages(base, incoming) {\n    var _a, _b;\n    const strokes = /* @__PURE__ */ new Map();\n    for (const stroke of base.strokes) strokes.set(stroke.id, stroke);\n    for (const stroke of incoming.strokes) {\n      const existing = strokes.get(stroke.id);\n      if (!existing || stroke.updatedAt >= existing.updatedAt) strokes.set(stroke.id, stroke);\n    }\n    const deletedStrokeIds = [.../* @__PURE__ */ new Set([...(_a = base.deletedStrokeIds) != null ? _a : [], ...(_b = incoming.deletedStrokeIds) != null ? _b : []])];\n    for (const id of deletedStrokeIds) strokes.delete(id);\n    return {\n      ...base,\n      ...incoming,\n      title: incoming.updatedAt >= base.updatedAt ? incoming.title : base.title,\n      paper: incoming.updatedAt >= base.updatedAt ? incoming.paper : base.paper,\n      strokes: [...strokes.values()].sort((a2, b2) => a2.createdAt - b2.createdAt),\n      deletedStrokeIds,\n      updatedAt: Math.max(base.updatedAt, incoming.updatedAt)\n    };\n  }\n  function normalizePage(value) {\n    if (!value || typeof value !== "object") return null;\n    const raw = value;\n    const strokes = Array.isArray(raw.strokes) ? raw.strokes : [];\n    const deletedStrokeIds = Array.isArray(raw.deletedStrokeIds) ? raw.deletedStrokeIds.filter((id) => typeof id === "string") : [];\n    const deleted = new Set(deletedStrokeIds);\n    return {\n      id: typeof raw.id === "string" ? raw.id : newId("page"),\n      title: typeof raw.title === "string" ? raw.title : "Untitled",\n      paper: isPaperStyle(raw.paper) ? raw.paper : "ruled",\n      strokes: strokes.map(normalizeStroke).filter((stroke) => stroke !== null && !deleted.has(stroke.id)),\n      deletedStrokeIds,\n      createdAt: finitePositive(raw.createdAt, Date.now()),\n      updatedAt: finitePositive(raw.updatedAt, Date.now())\n    };\n  }\n  function normalizeStroke(value) {\n    if (!value || typeof value !== "object") return null;\n    const raw = value;\n    if (typeof raw.id !== "string" || typeof raw.pageId !== "string") return null;\n    const points = Array.isArray(raw.points) ? raw.points : [];\n    return {\n      id: raw.id,\n      pageId: raw.pageId,\n      tool: raw.tool === "highlighter" ? "highlighter" : "pen",\n      color: typeof raw.color === "string" ? raw.color : "#1b1b1b",\n      width: finitePositive(raw.width, 3),\n      opacity: clamp(finitePositive(raw.opacity, 1), 0.05, 1),\n      points: points.map(normalizePoint).filter((point) => point !== null),\n      createdAt: finitePositive(raw.createdAt, Date.now()),\n      updatedAt: finitePositive(raw.updatedAt, Date.now())\n    };\n  }\n  function normalizePoint(value) {\n    if (!value || typeof value !== "object") return null;\n    const raw = value;\n    if (typeof raw.x !== "number" || typeof raw.y !== "number") return null;\n    return {\n      x: clamp(raw.x, 0, 1),\n      y: clamp(raw.y, 0, 1),\n      pressure: clamp(typeof raw.pressure === "number" ? raw.pressure : 0.5, 0.05, 1),\n      tiltX: typeof raw.tiltX === "number" ? raw.tiltX : void 0,\n      tiltY: typeof raw.tiltY === "number" ? raw.tiltY : void 0,\n      t: finitePositive(raw.t, Date.now())\n    };\n  }\n  function finitePositive(value, fallback) {\n    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;\n  }\n  function clamp(value, min, max) {\n    return Math.max(min, Math.min(max, value));\n  }\n  function isPaperStyle(value) {\n    return value === "blank" || value === "ruled" || value === "grid" || value === "dot";\n  }\n\n  // node_modules/perfect-freehand/dist/esm/index.mjs\n  var { PI: e } = Math;\n  var t = e + 1e-4;\n  var n = 0.5;\n  var r = [1, 1];\n  function i(e2, t2, n2, r2 = (e3) => e3) {\n    return e2 * r2(0.5 - t2 * (0.5 - n2));\n  }\n  var { min: a } = Math;\n  function o(e2, t2, n2) {\n    let r2 = a(1, t2 / n2);\n    return a(1, e2 + (a(1, 1 - r2) - e2) * (r2 * 0.275));\n  }\n  function s(e2) {\n    return [-e2[0], -e2[1]];\n  }\n  function c(e2, t2) {\n    return [e2[0] + t2[0], e2[1] + t2[1]];\n  }\n  function l(e2, t2, n2) {\n    return e2[0] = t2[0] + n2[0], e2[1] = t2[1] + n2[1], e2;\n  }\n  function u(e2, t2) {\n    return [e2[0] - t2[0], e2[1] - t2[1]];\n  }\n  function d(e2, t2, n2) {\n    return e2[0] = t2[0] - n2[0], e2[1] = t2[1] - n2[1], e2;\n  }\n  function f(e2, t2) {\n    return [e2[0] * t2, e2[1] * t2];\n  }\n  function p(e2, t2, n2) {\n    return e2[0] = t2[0] * n2, e2[1] = t2[1] * n2, e2;\n  }\n  function m(e2, t2) {\n    return [e2[0] / t2, e2[1] / t2];\n  }\n  function h(e2) {\n    return [e2[1], -e2[0]];\n  }\n  function g(e2, t2) {\n    let n2 = t2[0];\n    return e2[0] = t2[1], e2[1] = -n2, e2;\n  }\n  function ee(e2, t2) {\n    return e2[0] * t2[0] + e2[1] * t2[1];\n  }\n  function _(e2, t2) {\n    return e2[0] === t2[0] && e2[1] === t2[1];\n  }\n  function v(e2) {\n    return Math.hypot(e2[0], e2[1]);\n  }\n  function y(e2, t2) {\n    let n2 = e2[0] - t2[0], r2 = e2[1] - t2[1];\n    return n2 * n2 + r2 * r2;\n  }\n  function b(e2) {\n    return m(e2, v(e2));\n  }\n  function x(e2, t2) {\n    return Math.hypot(e2[1] - t2[1], e2[0] - t2[0]);\n  }\n  function S(e2, t2, n2) {\n    let r2 = Math.sin(n2), i2 = Math.cos(n2), a2 = e2[0] - t2[0], o2 = e2[1] - t2[1], s2 = a2 * i2 - o2 * r2, c2 = a2 * r2 + o2 * i2;\n    return [s2 + t2[0], c2 + t2[1]];\n  }\n  function C(e2, t2, n2, r2) {\n    let i2 = Math.sin(r2), a2 = Math.cos(r2), o2 = t2[0] - n2[0], s2 = t2[1] - n2[1], c2 = o2 * a2 - s2 * i2, l2 = o2 * i2 + s2 * a2;\n    return e2[0] = c2 + n2[0], e2[1] = l2 + n2[1], e2;\n  }\n  function w(e2, t2, n2) {\n    return c(e2, f(u(t2, e2), n2));\n  }\n  function te(e2, t2, n2, r2) {\n    let i2 = n2[0] - t2[0], a2 = n2[1] - t2[1];\n    return e2[0] = t2[0] + i2 * r2, e2[1] = t2[1] + a2 * r2, e2;\n  }\n  function T(e2, t2, n2) {\n    return c(e2, f(t2, n2));\n  }\n  var E = [0, 0];\n  var D = [0, 0];\n  var O = [0, 0];\n  function k(e2, n2) {\n    let r2 = T(e2, b(h(u(e2, c(e2, [1, 1])))), -n2), i2 = [], a2 = 1 / 13;\n    for (let n3 = a2; n3 <= 1; n3 += a2) i2.push(S(r2, e2, t * 2 * n3));\n    return i2;\n  }\n  function A(e2, n2, r2) {\n    let i2 = [], a2 = 1 / r2;\n    for (let r3 = a2; r3 <= 1; r3 += a2) i2.push(S(n2, e2, t * r3));\n    return i2;\n  }\n  function j(e2, t2, n2) {\n    let r2 = u(t2, n2), i2 = f(r2, 0.5), a2 = f(r2, 0.51);\n    return [u(e2, i2), u(e2, a2), c(e2, a2), c(e2, i2)];\n  }\n  function M(e2, n2, r2, i2) {\n    let a2 = [], o2 = T(e2, n2, r2), s2 = 1 / i2;\n    for (let n3 = s2; n3 < 1; n3 += s2) a2.push(S(o2, e2, t * 3 * n3));\n    return a2;\n  }\n  function ne(e2, t2, n2) {\n    return [c(e2, f(t2, n2)), c(e2, f(t2, n2 * 0.99)), u(e2, f(t2, n2 * 0.99)), u(e2, f(t2, n2))];\n  }\n  function N(e2, t2, n2) {\n    return e2 === false || e2 === void 0 ? 0 : e2 === true ? Math.max(t2, n2) : e2;\n  }\n  function re(e2, t2, n2) {\n    return e2.slice(0, 10).reduce((e3, r2) => {\n      let i2 = r2.pressure;\n      return t2 && (i2 = o(e3, r2.distance, n2)), (e3 + i2) / 2;\n    }, e2[0].pressure);\n  }\n  function P(e2, n2 = {}) {\n    let { size: r2 = 16, smoothing: a2 = 0.5, thinning: f2 = 0.5, simulatePressure: m2 = true, easing: _2 = (e3) => e3, start: v2 = {}, end: b2 = {}, last: x2 = false } = n2, { cap: S2 = true, easing: w2 = (e3) => e3 * (2 - e3) } = v2, { cap: T2 = true, easing: P2 = (e3) => --e3 * e3 * e3 + 1 } = b2;\n    if (e2.length === 0 || r2 <= 0) return [];\n    let F2 = e2[e2.length - 1].runningLength, I2 = N(v2.taper, r2, F2), L2 = N(b2.taper, r2, F2), R2 = (r2 * a2) ** 2, z = [], B = [], V = re(e2, m2, r2), H = i(r2, f2, e2[e2.length - 1].pressure, _2), U, W = e2[0].vector, G = e2[0].point, K = G, q = G, J = K, Y = false;\n    for (let n3 = 0; n3 < e2.length; n3++) {\n      let { pressure: a3 } = e2[n3], { point: s2, vector: h2, distance: v3, runningLength: b3 } = e2[n3], x3 = n3 === e2.length - 1;\n      if (!x3 && F2 - b3 < 3) continue;\n      f2 ? (m2 && (a3 = o(V, v3, r2)), H = i(r2, f2, a3, _2)) : H = r2 / 2, U === void 0 && (U = H);\n      let S3 = b3 < I2 ? w2(b3 / I2) : 1, T3 = F2 - b3 < L2 ? P2((F2 - b3) / L2) : 1;\n      H = Math.max(0.01, H * Math.min(S3, T3));\n      let k2 = (x3 ? e2[n3] : e2[n3 + 1]).vector, A2 = x3 ? 1 : ee(h2, k2), j2 = ee(h2, W) < 0 && !Y, M2 = A2 !== null && A2 < 0;\n      if (j2 || M2) {\n        g(E, W), p(E, E, H);\n        for (let e3 = 0; e3 <= 1; e3 += 0.07692307692307693) d(D, s2, E), C(D, D, s2, t * e3), q = [D[0], D[1]], z.push(q), l(O, s2, E), C(O, O, s2, t * -e3), J = [O[0], O[1]], B.push(J);\n        G = q, K = J, M2 && (Y = true);\n        continue;\n      }\n      if (Y = false, x3) {\n        g(E, h2), p(E, E, H), z.push(u(s2, E)), B.push(c(s2, E));\n        continue;\n      }\n      te(E, k2, h2, A2), g(E, E), p(E, E, H), d(D, s2, E), q = [D[0], D[1]], (n3 <= 1 || y(G, q) > R2) && (z.push(q), G = q), l(O, s2, E), J = [O[0], O[1]], (n3 <= 1 || y(K, J) > R2) && (B.push(J), K = J), V = a3, W = h2;\n    }\n    let X = [e2[0].point[0], e2[0].point[1]], Z = e2.length > 1 ? [e2[e2.length - 1].point[0], e2[e2.length - 1].point[1]] : c(e2[0].point, [1, 1]), Q = [], $ = [];\n    if (e2.length === 1) {\n      if (!(I2 || L2) || x2) return k(X, U || H);\n    } else {\n      I2 || L2 && e2.length === 1 || (S2 ? Q.push(...A(X, B[0], 13)) : Q.push(...j(X, z[0], B[0])));\n      let t2 = h(s(e2[e2.length - 1].vector));\n      L2 || I2 && e2.length === 1 ? $.push(Z) : T2 ? $.push(...M(Z, t2, H, 29)) : $.push(...ne(Z, t2, H));\n    }\n    return z.concat($, B.reverse(), Q);\n  }\n  var F = [0, 0];\n  function I(e2) {\n    return e2 != null && e2 >= 0;\n  }\n  function L(e2, t2 = {}) {\n    var _a;\n    let { streamline: i2 = 0.5, size: a2 = 16, last: o2 = false } = t2;\n    if (e2.length === 0) return [];\n    let s2 = 0.15 + (1 - i2) * 0.85, l2 = Array.isArray(e2[0]) ? e2 : e2.map(({ x: e3, y: t3, pressure: r2 = n }) => [e3, t3, r2]);\n    if (l2.length === 2) {\n      let e3 = l2[1];\n      l2 = l2.slice(0, -1);\n      for (let t3 = 1; t3 < 5; t3++) l2.push(w(l2[0], e3, t3 / 4));\n    }\n    l2.length === 1 && (l2 = [...l2, [...c(l2[0], r), ...l2[0].slice(2)]]);\n    let u2 = [{ point: [l2[0][0], l2[0][1]], pressure: I(l2[0][2]) ? l2[0][2] : 0.25, vector: [...r], distance: 0, runningLength: 0 }], f2 = false, p2 = 0, m2 = u2[0], h2 = l2.length - 1;\n    for (let e3 = 1; e3 < l2.length; e3++) {\n      let t3 = o2 && e3 === h2 ? [l2[e3][0], l2[e3][1]] : w(m2.point, l2[e3], s2);\n      if (_(m2.point, t3)) continue;\n      let r2 = x(t3, m2.point);\n      if (p2 += r2, e3 < h2 && !f2) {\n        if (p2 < a2) continue;\n        f2 = true;\n      }\n      d(F, m2.point, t3), m2 = { point: t3, pressure: I(l2[e3][2]) ? l2[e3][2] : n, vector: b(F), distance: r2, runningLength: p2 }, u2.push(m2);\n    }\n    return u2[0].vector = ((_a = u2[1]) == null ? void 0 : _a.vector) || [0, 0], u2;\n  }\n  function R(e2, t2 = {}) {\n    return P(L(e2, t2), t2);\n  }\n\n  // src/rendering.ts\n  var paths = /* @__PURE__ */ new WeakMap();\n  function penOutline(stroke, width, height) {\n    const pressures = smoothPenPressures(stroke.points);\n    return R(stroke.points.map((point, index) => [point.x * width, point.y * height, pressures[index]]), {\n      // Preserve the existing diameter: width * (0.55 + pressure * 0.75).\n      size: stroke.width * 0.925,\n      thinning: 0.75 / 1.85,\n      simulatePressure: false,\n      // Input is the raw captured trajectory; a position filter here would pull\n      // sparse fast corners away from the saved trajectory.\n      streamline: 0,\n      smoothing: 0.65,\n      last: true,\n      start: { cap: true, taper: 0 },\n      end: { cap: true, taper: 0 }\n    });\n  }\n  function smoothPenPressures(points) {\n    if (points.length < 3) return points.map((point) => point.pressure);\n    return points.map((point, index) => {\n      if (index === 0 || index === points.length - 1) return point.pressure;\n      return median3(points[index - 1].pressure, point.pressure, points[index + 1].pressure);\n    });\n  }\n  function median3(a2, b2, c2) {\n    return Math.max(Math.min(a2, b2), Math.min(Math.max(a2, b2), c2));\n  }\n  function drawInkStroke(ctx, stroke, width, height) {\n    if (stroke.points.length === 0) return;\n    ctx.save();\n    ctx.globalAlpha = stroke.opacity;\n    ctx.fillStyle = stroke.color;\n    ctx.strokeStyle = stroke.color;\n    ctx.lineCap = "round";\n    ctx.lineJoin = "round";\n    ctx.globalCompositeOperation = stroke.tool === "highlighter" ? "multiply" : "source-over";\n    if (stroke.points.length === 1) {\n      const point = stroke.points[0];\n      const diameter = stroke.tool === "highlighter" ? stroke.width : stroke.width * (0.55 + point.pressure * 0.75);\n      ctx.beginPath();\n      ctx.arc(point.x * width, point.y * height, diameter / 2, 0, Math.PI * 2);\n      ctx.fill();\n    } else if (stroke.tool === "highlighter") {\n      ctx.lineWidth = stroke.width;\n      drawSmoothPath(ctx, stroke.points, width, height);\n      ctx.stroke();\n    } else {\n      let cached = paths.get(stroke);\n      if (!cached || cached.points !== stroke.points || cached.count !== stroke.points.length || cached.updatedAt !== stroke.updatedAt || cached.size !== stroke.width || cached.width !== width || cached.height !== height) {\n        cached = {\n          points: stroke.points,\n          count: stroke.points.length,\n          updatedAt: stroke.updatedAt,\n          size: stroke.width,\n          width,\n          height,\n          path: createPenPath(stroke, width, height)\n        };\n        paths.set(stroke, cached);\n      }\n      ctx.fill(cached.path);\n    }\n    ctx.restore();\n  }\n  function createPenPath(stroke, width, height) {\n    const path = new Path2D();\n    const outline = penOutline(stroke, width, height);\n    if (outline.length > 0) {\n      const first = outline[0];\n      path.moveTo(first[0], first[1]);\n      for (let index = 1; index < outline.length; index++) {\n        const point = outline[index];\n        path.lineTo(point[0], point[1]);\n      }\n      path.closePath();\n    }\n    return path;\n  }\n  function drawSmoothPath(ctx, points, width, height) {\n    ctx.beginPath();\n    ctx.moveTo(points[0].x * width, points[0].y * height);\n    for (let index = 1; index < points.length; index++) {\n      const previous = points[index - 1];\n      const point = points[index];\n      const end = index === points.length - 1 ? point : { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };\n      ctx.quadraticCurveTo(previous.x * width, previous.y * height, end.x * width, end.y * height);\n    }\n    const last = points[points.length - 1];\n    ctx.lineTo(last.x * width, last.y * height);\n  }\n\n  // src/worker-protocol.ts\n  function serializeNotebook(notebook) {\n    return `${JSON.stringify(notebook, null, 2)}\n`;\n  }\n  function cloneStrokeValue(stroke) {\n    return { ...stroke, points: stroke.points.map((point) => ({ ...point })) };\n  }\n  function clonePageValue(page) {\n    return { ...page, strokes: page.strokes.map(cloneStrokeValue), deletedStrokeIds: [...page.deletedStrokeIds] };\n  }\n\n  // src/worker-core.ts\n  var WorkerPageIndex = class {\n    constructor(width, height) {\n      this.width = width;\n      this.height = height;\n      this.entries = /* @__PURE__ */ new Map();\n      this.cells = /* @__PURE__ */ new Map();\n      this.strokeWidths = /* @__PURE__ */ new Map();\n      this.maximumStrokeWidth = 0;\n    }\n    sync(page) {\n      this.entries.clear();\n      this.cells.clear();\n      this.strokeWidths.clear();\n      this.maximumStrokeWidth = 0;\n      page.strokes.forEach((stroke, order) => this.upsert(stroke, order));\n    }\n    upsert(stroke, order) {\n      var _a;\n      this.remove(stroke.id);\n      const entry = { stroke, order, cells: workerStrokeCells(stroke, this.width, this.height) };\n      this.entries.set(stroke.id, entry);\n      this.strokeWidths.set(stroke.width, ((_a = this.strokeWidths.get(stroke.width)) != null ? _a : 0) + 1);\n      this.maximumStrokeWidth = Math.max(this.maximumStrokeWidth, stroke.width);\n      for (const cell of entry.cells) {\n        let bucket = this.cells.get(cell);\n        if (!bucket) this.cells.set(cell, bucket = /* @__PURE__ */ new Set());\n        bucket.add(entry);\n      }\n    }\n    remove(strokeId) {\n      var _a;\n      const entry = this.entries.get(strokeId);\n      if (!entry) return;\n      this.entries.delete(strokeId);\n      const widthCount = ((_a = this.strokeWidths.get(entry.stroke.width)) != null ? _a : 1) - 1;\n      if (widthCount > 0) this.strokeWidths.set(entry.stroke.width, widthCount);\n      else this.strokeWidths.delete(entry.stroke.width);\n      if (entry.stroke.width === this.maximumStrokeWidth && widthCount <= 0) {\n        this.maximumStrokeWidth = 0;\n        for (const width of this.strokeWidths.keys()) this.maximumStrokeWidth = Math.max(this.maximumStrokeWidth, width);\n      }\n      for (const cell of entry.cells) {\n        const bucket = this.cells.get(cell);\n        bucket == null ? void 0 : bucket.delete(entry);\n        if ((bucket == null ? void 0 : bucket.size) === 0) this.cells.delete(cell);\n      }\n    }\n    updateOrder(page) {\n      page.strokes.forEach((stroke, order) => {\n        const entry = this.entries.get(stroke.id);\n        if (entry) entry.order = order;\n      });\n    }\n    getStroke(strokeId) {\n      var _a;\n      return (_a = this.entries.get(strokeId)) == null ? void 0 : _a.stroke;\n    }\n    getOrder(strokeId) {\n      var _a;\n      return (_a = this.entries.get(strokeId)) == null ? void 0 : _a.order;\n    }\n    query(cell, queryWidth = this.width, queryHeight = this.height) {\n      var _a;\n      const [column, row] = cell.split(":").map(Number);\n      const x2 = column * 128;\n      const y2 = row * 128;\n      const padding = this.maximumStrokeWidth * 0.7 + 4;\n      const paddingX = padding * this.width / queryWidth;\n      const paddingY = padding * this.height / queryHeight;\n      const keys = workerCellKeys({\n        x: x2 * this.width / queryWidth - paddingX,\n        y: y2 * this.height / queryHeight - paddingY,\n        width: Math.min(128, queryWidth - x2) * this.width / queryWidth + paddingX * 2,\n        height: Math.min(128, queryHeight - y2) * this.height / queryHeight + paddingY * 2\n      }, this.width, this.height);\n      const found = /* @__PURE__ */ new Set();\n      for (const key of keys) for (const entry of (_a = this.cells.get(key)) != null ? _a : []) found.add(entry);\n      return [...found].sort((left, right) => left.order - right.order).map((entry) => entry.stroke);\n    }\n  };\n  var OUTLINE_CACHE_LIMIT = 512;\n  var ProtocolError = class extends Error {\n    constructor(code, message) {\n      super(message);\n      this.code = code;\n    }\n  };\n  var InkWorkerCore = class {\n    constructor(capabilities) {\n      this.capabilities = capabilities;\n      this.sessions = /* @__PURE__ */ new Map();\n    }\n    ready() {\n      return { type: "ready", requestId: 0, sessionId: "", generation: 0, notebookRevision: 0, capabilities: this.capabilities };\n    }\n    async handle(request) {\n      var _a, _b;\n      try {\n        const response = await this.dispatch(request);\n        return response.type === "tile-rendered" ? { response, transfer: [response.bitmap] } : response.type === "operation-applied" && response.outline ? { response, transfer: [response.outline.buffer] } : { response };\n      } catch (error) {\n        return { response: {\n          type: "error",\n          requestId: request.requestId,\n          sessionId: request.sessionId,\n          generation: request.generation,\n          notebookRevision: (_b = (_a = this.sessions.get(request.sessionId)) == null ? void 0 : _a.revision) != null ? _b : request.notebookRevision,\n          code: error instanceof ProtocolError ? error.code : "internal",\n          message: error instanceof Error ? error.message : String(error)\n        } };\n      }\n    }\n    async dispatch(request) {\n      if (request.type === "initialize-raw") {\n        if (request.notebookRevision !== request.revision) {\n          throw new ProtocolError("revision-gap", "Initialize request revision metadata does not match its notebook revision");\n        }\n        const notebook = parseNotebook(request.raw);\n        this.sessions.set(request.sessionId, {\n          generation: request.generation,\n          notebook,\n          revision: request.revision,\n          pendingSave: /* @__PURE__ */ new Map(),\n          indexes: workerIndexes(notebook),\n          outlineCache: /* @__PURE__ */ new Map()\n        });\n        return this.response(request, { type: "initialized", notebook, revision: request.revision });\n      }\n      if (request.type === "initialize-notebook") {\n        if (request.notebookRevision !== request.revision) {\n          throw new ProtocolError("revision-gap", "Initialize request revision metadata does not match its notebook revision");\n        }\n        const notebook = normalizeNotebook(request.notebook);\n        this.sessions.set(request.sessionId, {\n          generation: request.generation,\n          notebook,\n          revision: request.revision,\n          pendingSave: /* @__PURE__ */ new Map(),\n          indexes: workerIndexes(notebook),\n          outlineCache: /* @__PURE__ */ new Map()\n        });\n        return this.response(request, { type: "initialized", notebook, revision: request.revision });\n      }\n      const session = this.sessions.get(request.sessionId);\n      if (!session) throw new ProtocolError("missing-session", "Ink worker session is not initialized");\n      if (session.generation !== request.generation) throw new ProtocolError("stale-generation", "Ink worker request belongs to a stale file generation");\n      if (request.type !== "apply-operation" && request.notebookRevision > session.revision) {\n        throw new ProtocolError("revision-gap", `Worker revision ${session.revision} is behind request revision ${request.notebookRevision}`);\n      }\n      if (request.type === "apply-operation") {\n        if (request.notebookRevision !== request.revision) {\n          throw new ProtocolError("revision-gap", "Operation revision metadata does not match its notebook revision");\n        }\n        if (request.revision !== session.revision + 1) {\n          throw new ProtocolError("revision-gap", `Expected revision ${session.revision + 1}, received ${request.revision}`);\n        }\n        const operation = request.operation;\n        invalidateOperationOutlines(session.outlineCache, operation);\n        const operationIndex = "pageId" in operation && typeof operation.pageId === "string" ? session.indexes.get(operation.pageId) : void 0;\n        const outline = applyNotebookOperation(session.notebook, operation, session.outlineCache, operationIndex);\n        if (operation.type === "replace-notebook" || operation.type === "history-restore" || operation.type === "page-operation") {\n          session.indexes = workerIndexes(session.notebook);\n          session.outlineCache.clear();\n        } else {\n          const pageId = operation.pageId;\n          const page = session.notebook.pages.find((candidate) => candidate.id === pageId);\n          if (page) {\n            let index = session.indexes.get(pageId);\n            if (!index) session.indexes.set(pageId, index = new WorkerPageIndex(session.notebook.pageWidth, session.notebook.pageHeight));\n            updateWorkerIndex(index, page, operation, outline == null ? void 0 : outline.stroke);\n          }\n        }\n        session.revision = request.revision;\n        return this.response(request, {\n          type: "operation-applied",\n          revision: session.revision,\n          ...outline ? { strokeId: outline.strokeId, sampleCount: outline.sampleCount, outline: outline.points, outlineMode: outline.mode } : {}\n        });\n      }\n      if (request.type === "barrier") {\n        if (session.revision < request.minimumRevision) {\n          throw new ProtocolError("revision-gap", `Worker revision ${session.revision} is behind ${request.minimumRevision}`);\n        }\n        return this.response(request, { type: "barrier-complete", revision: session.revision });\n      }\n      if (request.type === "prepare-save") {\n        if (session.revision < request.minimumRevision) {\n          throw new ProtocolError("revision-gap", `Worker revision ${session.revision} is behind ${request.minimumRevision}`);\n        }\n        const disk = parseNotebook(request.raw);\n        const local = normalizeNotebook(session.notebook);\n        const merged = mergeNotebooks(disk, local);\n        const token = `${request.sessionId}:${request.generation}:${request.requestId}`;\n        session.pendingSave.clear();\n        session.pendingSave.set(token, {\n          notebook: normalizeNotebook(merged),\n          revision: session.revision,\n          reconcile: serializeNotebook(merged) !== serializeNotebook(local)\n        });\n        return this.response(request, { type: "save-prepared", token, content: serializeNotebook(merged), revision: session.revision });\n      }\n      if (request.type === "render-tile") {\n        const rendered = renderTile(\n          session.notebook,\n          session.indexes.get(request.pageId),\n          session.outlineCache,\n          request.pageId,\n          request.cell,\n          request.density,\n          request.revision,\n          request.renderGeneration,\n          request.width,\n          request.height\n        );\n        return this.response(request, { type: "tile-rendered", ...rendered });\n      }\n      if (request.type === "cancel-render-generation") {\n        return this.response(request, { type: "renders-cancelled", renderGeneration: request.renderGeneration });\n      }\n      if (request.type === "commit-save") {\n        const candidate = session.pendingSave.get(request.token);\n        if (!candidate) throw new ProtocolError("missing-session", "Prepared save is no longer available");\n        session.pendingSave.delete(request.token);\n        session.notebook = mergeNotebooks(candidate.notebook, session.notebook);\n        session.indexes = workerIndexes(session.notebook);\n        session.outlineCache.clear();\n        return this.response(request, {\n          type: "save-committed",\n          revision: candidate.revision,\n          merged: candidate.reconcile ? candidate.notebook : void 0\n        });\n      }\n      if (request.type === "abort-save") {\n        session.pendingSave.delete(request.token);\n        return this.response(request, { type: "save-aborted" });\n      }\n      if (request.type === "merge-external") {\n        const merged = mergeNotebooks(parseNotebook(request.raw), session.notebook);\n        const changed = serializeNotebook(merged) !== serializeNotebook(session.notebook);\n        session.notebook = normalizeNotebook(merged);\n        if (changed) {\n          session.indexes = workerIndexes(session.notebook);\n          session.outlineCache.clear();\n        }\n        return this.response(request, { type: "external-merged", notebook: changed ? session.notebook : void 0, revision: session.revision });\n      }\n      this.sessions.delete(request.sessionId);\n      return this.response(request, { type: "session-disposed" });\n    }\n    response(request, response) {\n      var _a, _b;\n      return {\n        ...response,\n        requestId: request.requestId,\n        sessionId: request.sessionId,\n        generation: request.generation,\n        notebookRevision: (_b = (_a = this.sessions.get(request.sessionId)) == null ? void 0 : _a.revision) != null ? _b : request.notebookRevision\n      };\n    }\n  };\n  function renderTile(notebook, index, outlineCache, pageId, cell, density, revision, renderGeneration, pageWidth, pageHeight) {\n    var _a;\n    const page = notebook.pages.find((candidate) => candidate.id === pageId);\n    if (!page) throw new Error(`Ink worker page is unavailable: ${pageId}`);\n    const Canvas = globalThis.OffscreenCanvas;\n    if (!Canvas) throw new Error("OffscreenCanvas is not supported by this device");\n    const [column, row] = cell.split(":").map(Number);\n    const x2 = column * 128;\n    const y2 = row * 128;\n    const width = Math.min(128, pageWidth - x2);\n    const height = Math.min(128, pageHeight - y2);\n    if (width <= 0 || height <= 0) throw new Error(`Ink worker tile is outside page bounds: ${cell}`);\n    const safeDensity = Math.max(0.5, Math.min(9, density));\n    const bleedPixels = Math.ceil(4 * safeDensity);\n    const canvasWidth = Math.ceil(width * safeDensity) + bleedPixels * 2;\n    const canvasHeight = Math.ceil(height * safeDensity) + bleedPixels * 2;\n    const canvas = new Canvas(canvasWidth, canvasHeight);\n    const ctx = canvas.getContext("2d");\n    if (!ctx) throw new Error("Ink worker could not create a 2D tile context");\n    ctx.setTransform(safeDensity, 0, 0, safeDensity, bleedPixels - x2 * safeDensity, bleedPixels - y2 * safeDensity);\n    const candidates = (_a = index == null ? void 0 : index.query(cell, pageWidth, pageHeight)) != null ? _a : [];\n    for (const stroke of candidates) drawWorkerStroke(ctx, stroke, pageWidth, pageHeight, outlineCache);\n    return {\n      pageId,\n      cell,\n      density: safeDensity,\n      revision,\n      renderGeneration,\n      x: x2,\n      y: y2,\n      width,\n      height,\n      canvasWidth,\n      canvasHeight,\n      bitmap: canvas.transferToImageBitmap()\n    };\n  }\n  function workerIndexes(notebook) {\n    const indexes = /* @__PURE__ */ new Map();\n    for (const page of notebook.pages) {\n      const index = new WorkerPageIndex(notebook.pageWidth, notebook.pageHeight);\n      index.sync(page);\n      indexes.set(page.id, index);\n    }\n    return indexes;\n  }\n  function workerStrokeCells(stroke, pageWidth, pageHeight) {\n    if (stroke.points.length === 0) return [];\n    const padding = stroke.width * 0.7 + 4;\n    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;\n    for (const point of stroke.points) {\n      minX = Math.min(minX, point.x * pageWidth);\n      minY = Math.min(minY, point.y * pageHeight);\n      maxX = Math.max(maxX, point.x * pageWidth);\n      maxY = Math.max(maxY, point.y * pageHeight);\n    }\n    return workerCellKeys({ x: minX - padding, y: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 }, pageWidth, pageHeight);\n  }\n  function workerCellKeys(rect, pageWidth, pageHeight) {\n    if (!Number.isFinite(rect.x + rect.y + rect.width + rect.height) || rect.width <= 0 || rect.height <= 0 || rect.x >= pageWidth || rect.y >= pageHeight || rect.x + rect.width <= 0 || rect.y + rect.height <= 0) return [];\n    const cells = [];\n    for (let row = Math.floor(Math.max(0, rect.y) / 128); row < Math.ceil(Math.min(pageHeight, rect.y + rect.height) / 128); row++) {\n      for (let column = Math.floor(Math.max(0, rect.x) / 128); column < Math.ceil(Math.min(pageWidth, rect.x + rect.width) / 128); column++) {\n        cells.push(`${column}:${row}`);\n      }\n    }\n    return cells;\n  }\n  function drawWorkerStroke(ctx, stroke, width, height, cache) {\n    if (stroke.tool !== "pen") {\n      drawInkStroke(ctx, stroke, width, height);\n      return;\n    }\n    const signature = `${stroke.updatedAt}:${stroke.points.length}:${stroke.width}:${width}:${height}`;\n    let cached = cache.get(stroke.id);\n    let outline = (cached == null ? void 0 : cached.signature) === signature ? cached.points : void 0;\n    if (!outline) {\n      const points = penOutline(stroke, width, height);\n      outline = new Float32Array(points.length * 2);\n      for (let index = 0; index < points.length; index++) {\n        outline[index * 2] = points[index][0];\n        outline[index * 2 + 1] = points[index][1];\n      }\n      cache.delete(stroke.id);\n      cache.set(stroke.id, { signature, points: outline });\n      while (cache.size > OUTLINE_CACHE_LIMIT) cache.delete(cache.keys().next().value);\n    } else {\n      cache.delete(stroke.id);\n      cache.set(stroke.id, cached);\n    }\n    ctx.save();\n    ctx.globalAlpha = stroke.opacity;\n    ctx.fillStyle = stroke.color;\n    ctx.globalCompositeOperation = "source-over";\n    ctx.beginPath();\n    if (outline.length >= 2) {\n      ctx.moveTo(outline[0], outline[1]);\n      for (let index = 2; index < outline.length; index += 2) {\n        ctx.lineTo(outline[index], outline[index + 1]);\n      }\n      ctx.closePath();\n      ctx.fill();\n    }\n    ctx.restore();\n  }\n  function parseNotebook(raw) {\n    try {\n      return normalizeNotebook(JSON.parse(raw));\n    } catch (e2) {\n      throw new ProtocolError("invalid-format", "Existing ink notebook is not valid JSON");\n    }\n  }\n  function applyNotebookOperation(notebook, operation, cache, index) {\n    var _a, _b, _c, _d, _e, _f, _g, _h, _i;\n    if (operation.type === "replace-notebook" || operation.type === "history-restore") {\n      Object.assign(notebook, normalizeNotebook(operation.notebook));\n      return void 0;\n    }\n    if (operation.type === "page-operation") {\n      const page2 = operation.page;\n      if ((operation.action === "add" || operation.action === "duplicate" || operation.action === "restore") && page2) {\n        if (!(page2.id in notebook.deletedPages)) {\n          notebook.pages = notebook.pages.filter((candidate) => candidate.id !== page2.id);\n          notebook.pages.push(clonePageValue(page2));\n        }\n      } else if (operation.action === "delete" && operation.pageId) {\n        if (notebook.pages.length > 1) {\n          notebook.pages = notebook.pages.filter((candidate) => candidate.id !== operation.pageId);\n          notebook.deletedPages[operation.pageId] = Math.max((_a = notebook.deletedPages[operation.pageId]) != null ? _a : 0, (_b = operation.deletedAt) != null ? _b : Date.now());\n        }\n      }\n      const order = new Map(operation.pageOrder.map((id, index2) => [id, index2]));\n      notebook.pages.sort((left, right) => {\n        var _a2, _b2;\n        return ((_a2 = order.get(left.id)) != null ? _a2 : Number.MAX_SAFE_INTEGER) - ((_b2 = order.get(right.id)) != null ? _b2 : Number.MAX_SAFE_INTEGER);\n      });\n      notebook.pageOrder = notebook.pages.map((candidate) => candidate.id);\n      notebook.pageOrderUpdatedAt = operation.pageOrderUpdatedAt;\n      notebook.updatedAt = operation.notebookUpdatedAt;\n      return void 0;\n    }\n    const page = notebook.pages.find((candidate) => candidate.id === operation.pageId);\n    if (!page) return void 0;\n    let outlinedStroke;\n    if (operation.type === "start-stroke") {\n      const position = (_c = index == null ? void 0 : index.getOrder(operation.stroke.id)) != null ? _c : -1;\n      const stroke = cloneStrokeValue(operation.stroke);\n      if (position >= 0) page.strokes[position] = stroke;\n      else page.strokes.push(stroke);\n      outlinedStroke = stroke;\n    } else if (operation.type === "append-stroke-points") {\n      const stroke = (_d = index == null ? void 0 : index.getStroke(operation.strokeId)) != null ? _d : page.strokes.find((candidate) => candidate.id === operation.strokeId);\n      if (stroke) {\n        for (let index2 = 0; index2 + 5 < operation.points.length; index2 += 6) {\n          stroke.points.push({\n            x: operation.points[index2],\n            y: operation.points[index2 + 1],\n            pressure: operation.points[index2 + 2],\n            tiltX: Number.isNaN(operation.points[index2 + 3]) ? void 0 : operation.points[index2 + 3],\n            tiltY: Number.isNaN(operation.points[index2 + 4]) ? void 0 : operation.points[index2 + 4],\n            t: operation.points[index2 + 5]\n          });\n        }\n        outlinedStroke = stroke;\n      }\n    } else if (operation.type === "complete-stroke") {\n      const stroke = (_e = index == null ? void 0 : index.getStroke(operation.strokeId)) != null ? _e : page.strokes.find((candidate) => candidate.id === operation.strokeId);\n      if (stroke) stroke.updatedAt = operation.pageUpdatedAt;\n    } else if (operation.type === "finalize-stroke") {\n      const position = (_f = index == null ? void 0 : index.getOrder(operation.stroke.id)) != null ? _f : -1;\n      const stroke = cloneStrokeValue(operation.stroke);\n      if (position >= 0) page.strokes[position] = stroke;\n      else page.strokes.push(stroke);\n      page.strokes.sort((left, right) => left.createdAt - right.createdAt);\n      outlinedStroke = stroke;\n    } else if (operation.type === "patch-strokes") {\n      const removed = new Set(operation.remove);\n      const upsert = new Map(operation.upsert.map((stroke) => [stroke.id, cloneStrokeValue(stroke)]));\n      page.strokes = page.strokes.filter((stroke) => !removed.has(stroke.id) && !upsert.has(stroke.id));\n      page.strokes.push(...upsert.values());\n      page.strokes.sort((left, right) => left.createdAt - right.createdAt);\n      page.deletedStrokeIds = [.../* @__PURE__ */ new Set([...page.deletedStrokeIds, ...operation.deletedStrokeIds])];\n    } else if (operation.type === "translate-strokes") {\n      for (const strokeId of operation.strokeIds) {\n        const stroke = (_g = index == null ? void 0 : index.getStroke(strokeId)) != null ? _g : page.strokes.find((candidate) => candidate.id === strokeId);\n        if (!stroke) continue;\n        stroke.points = stroke.points.map((point) => ({ ...point, x: point.x + operation.dx, y: point.y + operation.dy }));\n        stroke.updatedAt = operation.pageUpdatedAt;\n      }\n    } else {\n      if (operation.title !== void 0) page.title = operation.title;\n      if (operation.paper !== void 0) page.paper = operation.paper;\n    }\n    page.updatedAt = operation.pageUpdatedAt;\n    notebook.updatedAt = operation.notebookUpdatedAt;\n    if (!outlinedStroke || outlinedStroke.tool !== "pen" && outlinedStroke.tool !== "highlighter") return void 0;\n    const previewWidth = operation.type === "start-stroke" || operation.type === "append-stroke-points" ? Math.max(1, (_h = operation.previewWidth) != null ? _h : notebook.pageWidth) : notebook.pageWidth;\n    const previewHeight = operation.type === "start-stroke" || operation.type === "append-stroke-points" ? Math.max(1, (_i = operation.previewHeight) != null ? _i : notebook.pageHeight) : notebook.pageHeight;\n    const signature = `${outlinedStroke.updatedAt}:${outlinedStroke.points.length}:${outlinedStroke.width}:${previewWidth}:${previewHeight}`;\n    if (outlinedStroke.tool === "highlighter") {\n      const line = new Float32Array(outlinedStroke.points.length * 2);\n      for (let index2 = 0; index2 < outlinedStroke.points.length; index2++) {\n        line[index2 * 2] = outlinedStroke.points[index2].x;\n        line[index2 * 2 + 1] = outlinedStroke.points[index2].y;\n      }\n      return { strokeId: outlinedStroke.id, sampleCount: outlinedStroke.points.length, points: line, mode: "highlighter", stroke: outlinedStroke };\n    }\n    const cached = cache == null ? void 0 : cache.get(outlinedStroke.id);\n    let outline = (cached == null ? void 0 : cached.signature) === signature ? cached.points : void 0;\n    if (!outline) {\n      const generated = penOutline(outlinedStroke, previewWidth, previewHeight);\n      outline = new Float32Array(generated.length * 2);\n      for (let index2 = 0; index2 < generated.length; index2++) {\n        outline[index2 * 2] = generated[index2][0];\n        outline[index2 * 2 + 1] = generated[index2][1];\n      }\n      if (cache) {\n        cache.delete(outlinedStroke.id);\n        cache.set(outlinedStroke.id, { signature, points: outline });\n        while (cache.size > OUTLINE_CACHE_LIMIT) cache.delete(cache.keys().next().value);\n      }\n    }\n    const normalized = new Float32Array(outline.length);\n    for (let index2 = 0; index2 < outline.length; index2 += 2) {\n      normalized[index2] = outline[index2] / previewWidth;\n      normalized[index2 + 1] = outline[index2 + 1] / previewHeight;\n    }\n    return { strokeId: outlinedStroke.id, sampleCount: outlinedStroke.points.length, points: normalized, mode: "pen", stroke: outlinedStroke };\n  }\n  function invalidateOperationOutlines(cache, operation) {\n    if (operation.type === "replace-notebook" || operation.type === "history-restore" || operation.type === "page-operation") {\n      cache.clear();\n      return;\n    }\n    if (operation.type === "start-stroke" || operation.type === "finalize-stroke") cache.delete(operation.stroke.id);\n    else if (operation.type === "append-stroke-points" || operation.type === "complete-stroke") cache.delete(operation.strokeId);\n    else if (operation.type === "patch-strokes") {\n      for (const id of operation.remove) cache.delete(id);\n      for (const stroke of operation.upsert) cache.delete(stroke.id);\n    } else if (operation.type === "translate-strokes") {\n      for (const id of operation.strokeIds) cache.delete(id);\n    }\n  }\n  function updateWorkerIndex(index, page, operation, outlinedStroke) {\n    var _a, _b, _c, _d;\n    if (operation.type === "start-stroke" || operation.type === "finalize-stroke") {\n      const stroke = outlinedStroke;\n      if (stroke) index.upsert(stroke, operation.type === "start-stroke" ? (_a = index.getOrder(stroke.id)) != null ? _a : page.strokes.length - 1 : Number.MAX_SAFE_INTEGER);\n      if (operation.type === "finalize-stroke") index.updateOrder(page);\n    } else if (operation.type === "complete-stroke") {\n      const stroke = outlinedStroke != null ? outlinedStroke : index.getStroke(operation.strokeId);\n      if (stroke) index.upsert(stroke, (_b = index.getOrder(operation.strokeId)) != null ? _b : page.strokes.length - 1);\n    } else if (operation.type === "append-stroke-points") {\n    } else if (operation.type === "patch-strokes") {\n      for (const id of operation.remove) index.remove(id);\n      const positions = new Map(page.strokes.map((stroke, position) => [stroke.id, position]));\n      const strokes = new Map(page.strokes.map((stroke) => [stroke.id, stroke]));\n      for (const replacement of operation.upsert) {\n        const stroke = strokes.get(replacement.id);\n        if (stroke) index.upsert(stroke, (_c = positions.get(stroke.id)) != null ? _c : Number.MAX_SAFE_INTEGER);\n      }\n      index.updateOrder(page);\n    } else if (operation.type === "translate-strokes") {\n      for (const id of operation.strokeIds) {\n        const stroke = index.getStroke(id);\n        if (stroke) index.upsert(stroke, (_d = index.getOrder(id)) != null ? _d : Number.MAX_SAFE_INTEGER);\n      }\n    }\n  }\n\n  // src/ink-worker.ts\n  var scope = self;\n  var core = new InkWorkerCore({\n    offscreenCanvas: typeof OffscreenCanvas !== "undefined",\n    imageBitmap: typeof ImageBitmap !== "undefined",\n    transferable: supportsTransferableBuffers()\n  });\n  var queue = [];\n  var running = false;\n  scope.onmessage = (event) => {\n    const request = event.data;\n    if (request.type === "cancel-render-generation") {\n      for (let index = queue.length - 1; index >= 0; index--) {\n        const queued = queue[index];\n        if (queued.type === "render-tile" && queued.sessionId === request.sessionId && queued.generation === request.generation && queued.renderGeneration < request.renderGeneration) {\n          queue.splice(index, 1);\n          scope.postMessage({\n            type: "error",\n            requestId: queued.requestId,\n            sessionId: queued.sessionId,\n            generation: queued.generation,\n            notebookRevision: queued.notebookRevision,\n            code: "stale-generation",\n            message: "Queued tile belongs to an obsolete render generation"\n          });\n        }\n      }\n    }\n    queue.push(request);\n    drain();\n  };\n  function drain() {\n    if (running || queue.length === 0) return;\n    queue.sort((left, right) => workerPriority(left) - workerPriority(right));\n    const request = queue.shift();\n    running = true;\n    void core.handle(request).then(({ response, transfer }) => scope.postMessage(response, transfer != null ? transfer : [])).finally(() => {\n      running = false;\n      drain();\n    });\n  }\n  function workerPriority(request) {\n    if (request.type === "cancel-render-generation" || request.type === "initialize-raw" || request.type === "initialize-notebook") return 0;\n    if (request.type === "apply-operation") return 1;\n    if (request.type === "render-tile") return request.priority === "visible" ? 2 : 3;\n    return 4;\n  }\n  scope.postMessage(core.ready());\n  function supportsTransferableBuffers() {\n    if (typeof MessageChannel === "undefined") return false;\n    try {\n      const channel = new MessageChannel();\n      const buffer = new ArrayBuffer(1);\n      channel.port1.postMessage(buffer, [buffer]);\n      channel.port1.close();\n      channel.port2.close();\n      return buffer.byteLength === 0;\n    } catch (e2) {\n      return false;\n    }\n  }\n})();\n';

// src/worker-service.ts
var WORKER_READY_TIMEOUT = 2e3;
var InkWorkerRequestError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "InkWorkerRequestError";
  }
};
var InkWorkerService = class {
  constructor(reportFallback) {
    this.reportFallback = reportFallback;
    this.worker = null;
    this.workerUrl = null;
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.nextRequestId = 1;
    this.nextSessionId = 1;
    this.restartCount = 0;
    this.disabled = false;
    this.capabilities = null;
    this.recoveryPromise = null;
    this.pending = /* @__PURE__ */ new Map();
    this.sessions = /* @__PURE__ */ new Map();
  }
  createSession(snapshot) {
    const session = new InkWorkerSession(this, `view-${this.nextSessionId++}`, snapshot);
    this.sessions.set(session.id, session);
    return session;
  }
  async send(message, retry = true, skipRecovery = false, transfer = []) {
    if (this.disabled) throw new InkWorkerRequestError("unavailable", "Ink background worker is unavailable");
    if (this.recoveryPromise && !skipRecovery) await this.recoveryPromise;
    await this.ensureWorker();
    try {
      return await this.dispatch(message, transfer);
    } catch (error) {
      if (retry && this.recoveryPromise) {
        await this.recoveryPromise;
        return this.send(message, false, false, transfer);
      }
      throw error;
    }
  }
  removeSession(id) {
    this.sessions.delete(id);
  }
  canRenderTiles() {
    var _a;
    return ((_a = this.capabilities) == null ? void 0 : _a.offscreenCanvas) === true && this.capabilities.imageBitmap === true && this.capabilities.transferable !== false;
  }
  canTransfer() {
    var _a;
    return ((_a = this.capabilities) == null ? void 0 : _a.transferable) === true;
  }
  isDisabled() {
    return this.disabled;
  }
  async waitForRecovery() {
    const recovery = this.recoveryPromise;
    if (!recovery) return false;
    try {
      await recovery;
      return !this.disabled;
    } catch (e2) {
      return false;
    }
  }
  dispose() {
    this.disabled = true;
    this.stopWorker(new InkWorkerRequestError("disposed", "Ink background worker was disposed"));
    this.sessions.clear();
  }
  async ensureWorker() {
    if (this.readyPromise) return this.readyPromise;
    if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") {
      this.disable("This device does not support the Ink Notes background worker; reduced-performance mode is active.");
      throw new InkWorkerRequestError("unsupported", "Web Worker is not supported");
    }
    const blob = new Blob([ink_worker_source_default], { type: "text/javascript" });
    this.workerUrl = URL.createObjectURL(blob);
    this.worker = new Worker(this.workerUrl);
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.readyTimer = globalThis.setTimeout(() => reject(new InkWorkerRequestError("timeout", "Ink background worker did not start")), WORKER_READY_TIMEOUT);
    });
    this.worker.onmessage = (event) => this.onMessage(event.data);
    this.worker.onerror = () => this.onWorkerFailure(new InkWorkerRequestError("crashed", "Ink background worker stopped unexpectedly"));
    try {
      return await this.readyPromise;
    } catch (error) {
      this.onWorkerFailure(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }
  dispatch(message, transfer = []) {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        sessionId: message.sessionId,
        generation: message.generation,
        notebookRevision: message.notebookRevision
      });
      try {
        this.worker.postMessage({ ...message, requestId }, transfer);
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  onMessage(response) {
    var _a;
    if (response.type === "ready") {
      if (this.readyTimer !== void 0) globalThis.clearTimeout(this.readyTimer);
      this.readyTimer = void 0;
      (_a = this.resolveReady) == null ? void 0 : _a.call(this, response.capabilities);
      this.capabilities = response.capabilities;
      this.resolveReady = null;
      this.rejectReady = null;
      if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (response.sessionId !== pending.sessionId || response.generation !== pending.generation || response.notebookRevision < pending.notebookRevision) {
      pending.reject(new InkWorkerRequestError("stale-response", "Ink background worker returned a stale or mismatched response"));
      return;
    }
    if (response.type === "error") pending.reject(new InkWorkerRequestError(response.code, response.message));
    else pending.resolve(response);
  }
  onWorkerFailure(error) {
    if (this.disabled || this.recoveryPromise) return;
    this.stopWorker(error);
    if (this.restartCount >= 1) {
      this.disable("Ink Notes could not restart its background worker; reduced-performance mode is active.");
      return;
    }
    this.restartCount += 1;
    this.recoveryPromise = this.recover().finally(() => {
      this.recoveryPromise = null;
    });
  }
  async recover() {
    try {
      await this.ensureWorker();
      for (const session of this.sessions.values()) await session.recover();
    } catch (e2) {
      this.disable("Ink Notes could not restart its background worker; reduced-performance mode is active.");
    }
  }
  stopWorker(error) {
    var _a, _b;
    if (this.readyTimer !== void 0) globalThis.clearTimeout(this.readyTimer);
    this.readyTimer = void 0;
    (_a = this.rejectReady) == null ? void 0 : _a.call(this, error);
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
    this.capabilities = null;
    (_b = this.worker) == null ? void 0 : _b.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }
  disable(message) {
    if (this.disabled) return;
    this.disabled = true;
    this.stopWorker(new InkWorkerRequestError("unavailable", message));
    this.reportFallback(message);
  }
};
var InkWorkerSession = class {
  constructor(service, id, snapshot) {
    this.service = service;
    this.id = id;
    this.snapshot = snapshot;
    this.generation = 0;
    this.mirroredRevision = 0;
    this.initialized = false;
    this.operationTail = Promise.resolve();
  }
  canRenderTiles() {
    return this.service.canRenderTiles();
  }
  async initializeRaw(raw, revision) {
    this.generation += 1;
    this.initialized = false;
    const response = await this.service.send({
      type: "initialize-raw",
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: revision,
      raw,
      revision
    });
    if (response.type !== "initialized") throw unexpected(response);
    this.mirroredRevision = response.revision;
    this.initialized = true;
    return response.notebook;
  }
  async apply(revision, operation, transfer) {
    const apply = this.operationTail.then(async () => {
      if (revision <= this.mirroredRevision) return this.applied(revision);
      let response;
      try {
        response = await this.service.send(
          {
            type: "apply-operation",
            sessionId: this.id,
            generation: this.generation,
            notebookRevision: revision,
            revision,
            operation
          },
          false,
          false,
          transfer && this.service.canTransfer() ? transfer : []
        );
      } catch (error) {
        if (!await this.service.waitForRecovery() || revision > this.mirroredRevision) throw error;
        return this.applied(revision);
      }
      if (response.type !== "operation-applied") throw unexpected(response);
      this.mirroredRevision = response.revision;
      return response;
    });
    this.operationTail = apply.then(() => void 0, () => void 0);
    return apply;
  }
  async barrier(minimumRevision) {
    await this.operationTail;
    const response = await this.service.send({
      type: "barrier",
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: this.mirroredRevision,
      minimumRevision
    });
    if (response.type !== "barrier-complete") throw unexpected(response);
    return response.revision;
  }
  async prepareSave(raw, minimumRevision) {
    await this.operationTail;
    const response = await this.service.send({
      type: "prepare-save",
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: this.mirroredRevision,
      raw,
      minimumRevision
    });
    if (response.type !== "save-prepared") throw unexpected(response);
    return response;
  }
  async renderTile(pageId, cell, density, revision, width, height, renderGeneration = 0, priority = "visible") {
    await this.operationTail;
    const response = await this.service.send({
      type: "render-tile",
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: this.mirroredRevision,
      pageId,
      cell,
      density,
      revision,
      renderGeneration,
      priority,
      width,
      height
    });
    if (response.type !== "tile-rendered") throw unexpected(response);
    return response;
  }
  cancelGeneration(renderGeneration) {
    void this.service.send({
      type: "cancel-render-generation",
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: this.mirroredRevision,
      renderGeneration
    }).then(() => void 0, () => void 0);
  }
  async commitSave(token) {
    const response = await this.service.send({
      type: "commit-save",
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: this.mirroredRevision,
      token
    });
    if (response.type !== "save-committed") throw unexpected(response);
    return response;
  }
  async abortSave(token) {
    const response = await this.service.send({
      type: "abort-save",
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: this.mirroredRevision,
      token
    });
    if (response.type !== "save-aborted") throw unexpected(response);
  }
  async mergeExternal(raw) {
    await this.operationTail;
    const response = await this.service.send({
      type: "merge-external",
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: this.mirroredRevision,
      raw
    });
    if (response.type !== "external-merged") throw unexpected(response);
    return response.notebook;
  }
  async recover() {
    if (!this.initialized) return;
    const { notebook, revision } = this.snapshot();
    const response = await this.service.send({
      type: "initialize-notebook",
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: revision,
      notebook,
      revision
    }, false, true);
    if (response.type !== "initialized") throw unexpected(response);
    this.mirroredRevision = response.revision;
  }
  dispose() {
    void this.service.send({
      type: "dispose-session",
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: this.mirroredRevision
    }, false).catch(() => void 0);
    this.service.removeSession(this.id);
  }
  applied(revision) {
    return {
      type: "operation-applied",
      requestId: -1,
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: revision,
      revision
    };
  }
};
function unexpected(response) {
  return new InkWorkerRequestError("protocol", `Unexpected worker response: ${response.type}`);
}

// src/view.ts
var VIEW_TYPE_INK = "ink-notes-view";
var STROKE_ERASER_HIT_RADIUS = 10;
var OVERLAY_PIXEL_BUDGET = 12e6;
var SAVE_IDLE_DELAY = 1500;
var SAVE_MAX_DELAY = 1e4;
var SAVE_CONFLICT_RETRIES = 3;
var INK_COMMIT_IDLE_DELAY = 180;
var LIVE_TAIL_SAMPLE_LIMIT = 32;
var COMPLETED_PREVIEW_SAMPLE_LIMIT = 256;
var PEN_CAPTURE_MIN_DISTANCE = 0.35;
var SPARSE_SAMPLE_INTERVAL_MS = 24;
var PEN_SAMPLE_INTERVAL_WINDOW = 32;
var PEN_SPARSE_MIN_INTERVALS = 8;
var SaveConflictError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SaveConflictError";
  }
};
var INK_COLORS = [
  { value: "#1b1b1b", label: "Black" },
  { value: "#195bff", label: "Blue" },
  { value: "#f23c42", label: "Red" },
  { value: "#42c449", label: "Green" },
  { value: "#f2c94c", label: "Yellow" }
];
var InkView = class extends import_obsidian.FileView {
  constructor(leaf, store, workers) {
    super(leaf);
    this.workers = workers;
    this.notebook = createNotebook();
    this.pageIndex = 0;
    this.state = {
      tool: "pen",
      pen: { color: "#1b1b1b", width: 3, opacity: 1, smooth: 0 },
      highlighter: { color: "#f2c94c", width: 18, opacity: 0.4 },
      eraserMode: "stroke",
      eraserSize: 32
    };
    this.viewport = { x: 0, y: 0, width: 1, height: 1 };
    this.overlayScaleX = 1;
    this.overlayScaleY = 1;
    this.canvasLogicalWidth = 1;
    this.canvasLogicalHeight = 1;
    this.pageBaseWidth = 1;
    this.pageBaseHeight = 1;
    this.eraserHoverPoint = null;
    this.eraserPointerInside = false;
    this.syncing = false;
    this.saveRequested = false;
    this.activeSave = null;
    this.dirtyRevision = 0;
    this.savedRevision = 0;
    this.workerRevision = 0;
    this.pendingMergedNotebook = null;
    this.pendingMergedNotebookIsFinal = false;
    this.externalRefreshPending = false;
    this.maxSaveDue = false;
    this.workerSession = null;
    this.workerFallbackReported = false;
    this.activeStroke = null;
    this.workerStrokePointIndex = 0;
    this.penModeler = null;
    /** Active while pointerrawupdate delivers pen samples; tracks the newest
     *  consumed timestamp so pointermove batches cannot replay eaten samples. */
    this.rawUpdateCapture = null;
    /** Recent inter-sample intervals (ms), the device-rate history that drives
     *  the sparse-input auto-intervention. */
    this.penSampleIntervals = [];
    this.lastPenSampleTime = null;
    this.confirmedStrokeOutlines = /* @__PURE__ */ new Map();
    this.pendingInkStrokes = [];
    this.committingInkStrokes = null;
    this.pendingInkPageId = null;
    this.activePointerId = null;
    this.stylusTouchInput = false;
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
    this.eraserPreviewCells = /* @__PURE__ */ new Set();
    this.lassoPath = [];
    this.selectedStrokeIds = /* @__PURE__ */ new Set();
    this.lassoDrag = null;
    this.sizePopover = null;
    this.sizePopoverButton = null;
    this.sizePopoverOpen = false;
    this.renderFrame = null;
    this.resizeRequested = false;
    this.pageNavigationGeneration = 0;
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
    this.navigateToPage(pageId);
  }
  async onOpen() {
    this.root = this.containerEl.children[1];
    this.root.empty();
    this.root.addClass("ink-notes-view");
    this.root.addClass("ink-rail-hidden");
    this.root.setAttribute("aria-label", "Ink Notes");
    this.root.createDiv({ cls: "ink-toolbar", attr: { role: "toolbar", "aria-label": "Ink tools" } });
    this.root.createDiv({ cls: "ink-tool-popover-host" });
    this.root.createSpan({ cls: "ink-page-status", attr: { "aria-live": "polite" } });
    this.renderToolbar();
    this.renderCanvas();
    this.viewReady = true;
    this.renderAll();
  }
  async onClose() {
    var _a, _b, _c, _d;
    this.pageNavigationGeneration += 1;
    if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    if (this.zoomRenderTimer !== void 0) window.clearTimeout(this.zoomRenderTimer);
    this.finishPointerInput(false);
    this.cancelPendingInkCommitTimer();
    this.clearSaveTimers();
    if (this.file && (this.dirtyRevision > this.savedRevision || this.activeSave)) await this.save(this.file);
    (_b = (_a = this.tiles) == null ? void 0 : _a.setBackend) == null ? void 0 : _b.call(_a, null);
    (_c = this.workerSession) == null ? void 0 : _c.dispose();
    this.workerSession = null;
    (_d = this.tiles) == null ? void 0 : _d.dispose();
    this.viewReady = false;
  }
  async onLoadFile(file) {
    var _a, _b, _c, _d;
    this.pageNavigationGeneration += 1;
    (_b = (_a = this.tiles) == null ? void 0 : _a.setBackend) == null ? void 0 : _b.call(_a, null);
    (_c = this.workerSession) == null ? void 0 : _c.dispose();
    this.workerSession = null;
    this.workerRevision = 0;
    if (this.workers) {
      const session = this.workers.createSession(() => ({ notebook: this.notebook, revision: this.workerRevision }));
      try {
        this.notebook = await session.initializeRaw(await this.store.readRaw(file), 0);
        this.workerSession = session;
        this.workerRevision = 0;
        if (session.canRenderTiles()) (_d = this.tiles) == null ? void 0 : _d.setBackend(session, (error) => {
          if (this.workerSession === session) this.disableWorkerSession(error);
        });
      } catch (e2) {
        session.dispose();
        this.notebook = await this.store.read(file);
      }
    } else {
      this.notebook = await this.store.read(file);
    }
    this.pageIndex = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.resetInteraction();
    this.dirtyRevision = 0;
    this.savedRevision = 0;
    this.workerRevision = 0;
    this.renderAll();
  }
  async onUnloadFile(file) {
    var _a, _b, _c;
    this.pageNavigationGeneration += 1;
    this.finishPointerInput(false);
    this.cancelPendingInkCommitTimer();
    this.clearSaveTimers();
    if (this.dirtyRevision > this.savedRevision || this.activeSave) await this.save(file);
    (_b = (_a = this.tiles) == null ? void 0 : _a.setBackend) == null ? void 0 : _b.call(_a, null);
    (_c = this.workerSession) == null ? void 0 : _c.dispose();
    this.workerSession = null;
  }
  async reloadFromDisk() {
    if (this.syncing || this.activePointerId !== null || this.pendingInkStrokes.length > 0) {
      this.externalRefreshPending = true;
      return;
    }
    if (!this.file) return;
    const file = this.file;
    if (this.workerSession) {
      const latest2 = await this.workerSession.mergeExternal(await this.store.readRaw(file));
      if (this.file !== file) return;
      if (!latest2) return;
      this.receiveMergedNotebook(latest2, true);
      return;
    }
    const latest = await this.store.read(file);
    if (this.file !== file) return;
    if (notebooksEqual(latest, this.notebook)) return;
    this.receiveMergedNotebook(latest);
  }
  renderToolbar() {
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
    this.renderToolPopover();
    this.updateToolButtons();
  }
  renderToolPopover() {
    const host = this.root.querySelector(".ink-tool-popover-host");
    host.empty();
    this.addSizePopover(host);
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
    this.addBrushSettings(popover, "pen", "Pen", [2, 4, 8], 24);
    this.addBrushSettings(popover, "highlighter", "Highlighter", [8, 16, 24], 48);
    const eraser = popover.createDiv({ cls: "ink-eraser-settings" });
    eraser.createDiv({ cls: "ink-size-popover-title", text: "Eraser" });
    eraser.createDiv({ cls: "ink-settings-label", text: "Mode" });
    const modes = eraser.createDiv({ cls: "ink-eraser-modes", attr: { role: "radiogroup", "aria-label": "Eraser mode" } });
    for (const [mode, label, shortLabel, iconName] of [["stroke", "Stroke eraser", "Stroke", "eraser"], ["circle", "Circle eraser", "Circle", "circle"], ["square", "Square eraser", "Square", "square"]]) {
      const modeButton = modes.createEl("button", { cls: "ink-eraser-mode", attr: { type: "button", role: "radio", title: label, "aria-label": label, "aria-checked": String(this.state.eraserMode === mode), "data-eraser-mode": mode } });
      (0, import_obsidian.setIcon)(modeButton.createSpan({ cls: "ink-button-icon" }), iconName);
      modeButton.createSpan({ cls: "ink-eraser-mode-label", text: shortLabel });
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
    this.registerDomEvent(document, "pointerdown", (event) => {
      var _a;
      const target = event.target;
      const switchingSettingsTool = (_a = target == null ? void 0 : target.closest) == null ? void 0 : _a.call(target, ".ink-tool-button[aria-haspopup='dialog']");
      if (this.sizePopoverOpen && !container.contains(target) && !switchingSettingsTool) close();
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
    this.updateBrushControls();
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
      const focusTarget = this.state.tool === "eraser" ? ".ink-eraser-mode" : `.ink-brush-settings[data-brush-tool="${this.state.tool}"] input, .ink-brush-settings[data-brush-tool="${this.state.tool}"] button`;
      window.requestAnimationFrame(() => {
        var _a, _b;
        return (_b = (_a = this.sizePopover) == null ? void 0 : _a.querySelector(focusTarget)) == null ? void 0 : _b.focus();
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
  addBrushSettings(parent, tool, label, presets, maximum) {
    var _a;
    const settings = this.brushSettings(tool);
    const panel = parent.createDiv({ cls: "ink-brush-settings", attr: { "data-brush-tool": tool } });
    const header = panel.createDiv({ cls: "ink-size-popover-header" });
    header.createSpan({ cls: "ink-size-popover-title", text: `${label} settings` });
    header.createSpan({ cls: "ink-control-value", text: formatControlValue("Size", settings.width) });
    const preview = panel.createDiv({ cls: "ink-brush-preview", attr: { "aria-hidden": "true" } });
    preview.createSpan({ cls: "ink-brush-preview-line" });
    panel.createDiv({ cls: "ink-settings-label", text: "Size" });
    const input = panel.createEl("input", { attr: {
      type: "range",
      min: "1",
      max: String(maximum),
      step: "0.5",
      value: String(settings.width),
      "aria-label": `${label} size`,
      "data-control": "size"
    } });
    input.addEventListener("input", () => {
      settings.width = Number(input.value);
      this.updateBrushControls(tool);
    });
    panel.createDiv({ cls: "ink-settings-label ink-settings-label-presets", text: "Presets" });
    const widths = this.addToolbarSection(panel, `${label}-widths`);
    for (const width of presets) {
      const preset = widths.createEl("button", { cls: "ink-width-preset", attr: {
        type: "button",
        title: `${width} px`,
        "aria-label": `${label} ${width} px`,
        "data-width": String(width),
        "data-brush-tool": tool,
        "aria-pressed": String(settings.width === width)
      } });
      preset.createSpan({ cls: "ink-width-line" }).style.height = Math.min(width, 24) + "px";
      preset.addEventListener("click", () => {
        settings.width = width;
        this.updateBrushControls(tool);
      });
    }
    this.addColorPicker(panel, tool, label);
    this.addRange(panel, `${label} opacity`, 0.1, 1, 0.05, settings.opacity, (value) => {
      settings.opacity = value;
      this.updateBrushPreview(tool);
    });
    if (tool === "pen") {
      this.addRange(panel, "Smooth", 0, 100, 1, (_a = settings.smooth) != null ? _a : 0, (value) => {
        settings.smooth = value;
      });
    }
  }
  brushSettings(tool) {
    return this.state[tool];
  }
  updateBrushPreview(tool) {
    var _a;
    const settings = this.brushSettings(tool);
    const preview = (_a = this.sizePopover) == null ? void 0 : _a.querySelector(`.ink-brush-settings[data-brush-tool="${tool}"] .ink-brush-preview-line`);
    if (!preview) return;
    preview.style.setProperty("--ink-preview-color", settings.color);
    preview.style.setProperty("--ink-preview-opacity", String(settings.opacity));
    preview.style.setProperty("--ink-preview-width", `${Math.max(2, Math.min(30, settings.width))}px`);
  }
  updateBrushControls(tool = isBrushTool(this.state.tool) ? this.state.tool : null) {
    var _a, _b, _c, _d;
    this.root.querySelectorAll(".ink-width-preset").forEach((button) => {
      const buttonTool = button.dataset.brushTool;
      button.setAttribute("aria-pressed", String(Number(button.dataset.width) === this.brushSettings(buttonTool).width));
    });
    for (const brushTool of ["pen", "highlighter"]) {
      const panel = (_a = this.sizePopover) == null ? void 0 : _a.querySelector(`.ink-brush-settings[data-brush-tool="${brushTool}"]`);
      const settings = this.brushSettings(brushTool);
      const input = panel == null ? void 0 : panel.querySelector('input[data-control="size"]');
      if (input) input.value = String(settings.width);
      const value = panel == null ? void 0 : panel.querySelector(".ink-size-popover-header .ink-control-value");
      if (value) value.textContent = formatControlValue("Size", settings.width);
      this.updateBrushPreview(brushTool);
    }
    (_b = this.sizePopover) == null ? void 0 : _b.toggleClass("is-pen-tool", this.state.tool === "pen");
    (_c = this.sizePopover) == null ? void 0 : _c.toggleClass("is-highlighter-tool", this.state.tool === "highlighter");
    (_d = this.sizePopover) == null ? void 0 : _d.toggleClass("is-eraser-tool", this.state.tool === "eraser");
    if (tool) this.updateColorSwatches(tool);
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
    this.confirmedPreviewCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-confirmed-preview-canvas" });
    this.confirmedPreviewCanvas.style.pointerEvents = "none";
    this.confirmedPreviewCtx = this.confirmedPreviewCanvas.getContext("2d");
    this.previewCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-preview-canvas" });
    this.previewCanvas.style.pointerEvents = "none";
    this.previewCtx = this.previewCanvas.getContext("2d");
    this.canvas.style.pointerEvents = "none";
    this.pageElement.style.touchAction = "none";
    this.registerDomEvent(this.pageElement, "pointerenter", (event) => this.onPointerEnter(event));
    this.registerDomEvent(this.pageElement, "pointerdown", (event) => this.onPointerDown(event));
    this.registerDomEvent(this.pageElement, "pointermove", (event) => this.onPointerMove(event));
    if ("onpointerrawupdate" in window) {
      this.registerDomEvent(this.pageElement, "pointerrawupdate", (event) => this.onPointerRawUpdate(event));
    }
    this.registerDomEvent(this.pageElement, "pointerleave", () => {
      this.eraserPointerInside = false;
      this.refreshEraserCursor();
    });
    this.registerDomEvent(this.pageElement, "pointerup", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.pageElement, "pointercancel", (event) => this.onPointerCancel(event));
    this.registerDomEvent(this.pageElement, "lostpointercapture", (event) => this.onLostPointerCapture(event));
    this.registerPointerEndEvents();
    this.registerDomEvent(this.pageElement, "wheel", (event) => this.onWheel(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "scroll", () => this.onViewportMotion(), { passive: true });
    this.registerDomEvent(this.pageScroller, "touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchend", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchcancel", (event) => {
      this.onStylusTouch(event);
      this.touchGesture = null;
    }, { passive: false });
    const observer = new ResizeObserver(() => this.resizeCanvas());
    observer.observe(this.pageScroller);
    this.register(() => observer.disconnect());
  }
  renderPageRail() {
    var _a, _b;
    let rail = this.root.querySelector(".ink-page-rail");
    if (!rail) return;
    rail.empty();
    const header = rail.createDiv({ cls: "ink-rail-header" });
    header.createDiv({ cls: "ink-rail-heading", text: "Pages" });
    header.createSpan({ cls: "ink-rail-count", text: `${this.pageIndex + 1} / ${this.notebook.pages.length}` });
    const actions = rail.createDiv({ cls: "ink-rail-actions", attr: { role: "group", "aria-label": "Current page actions" } });
    this.addIconButton(actions, "chevron-up", "Move current page up", () => this.moveCurrentPage(-1), this.pageIndex === 0);
    this.addIconButton(actions, "chevron-down", "Move current page down", () => this.moveCurrentPage(1), this.pageIndex === this.notebook.pages.length - 1);
    this.addIconButton(actions, "copy", "Duplicate current page", () => this.duplicateCurrentPage());
    this.addIconButton(actions, "trash-2", "Delete current page", () => this.deleteCurrentPage(), this.notebook.pages.length <= 1);
    this.notebook.pages.forEach((page, index) => {
      const button = rail.createEl("button", { cls: "ink-page-thumb", attr: { type: "button", title: page.title } });
      if (index === this.pageIndex) button.addClass("is-active");
      button.setAttribute("aria-label", String(index + 1) + ": " + page.title);
      button.setAttribute("aria-current", String(index === this.pageIndex));
      button.createDiv({ cls: `ink-page-thumb-paper ink-paper-${page.paper}` });
      button.createSpan({ text: String(index + 1), cls: "ink-page-thumb-number" });
      button.createSpan({ text: page.title, cls: "ink-page-thumb-title" });
      button.addEventListener("click", () => this.navigateToPage(page.id));
    });
    (_b = (_a = rail.querySelector(".ink-page-thumb.is-active")) == null ? void 0 : _a.scrollIntoView) == null ? void 0 : _b.call(_a, { block: "nearest" });
  }
  renderPage() {
    if (!this.viewReady || this.notebook.pages.length === 0) return;
    const page = this.currentPage();
    if (this.pendingInkPageId && this.pendingInkPageId !== page.id) this.discardPendingInkPreview();
    this.updatePageStatus();
    this.pageElement.className = `ink-page ink-paper-${page.paper}`;
    this.pageElement.style.aspectRatio = `${this.notebook.pageWidth} / ${this.notebook.pageHeight}`;
    this.resizeCanvas();
    this.root.querySelectorAll(".ink-tool-button").forEach((el) => {
      const active = el.getAttribute("data-tool") === this.state.tool;
      el.toggleClass("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  }
  updatePageStatus() {
    var _a;
    const status = (_a = this.root) == null ? void 0 : _a.querySelector(".ink-page-status");
    if (status) status.textContent = this.pageIndex + 1 + " / " + this.notebook.pages.length;
  }
  resizeCanvas() {
    if (!this.canvas || !this.pageElement) return;
    this.layoutPage();
    const rect = this.pageElement.getBoundingClientRect();
    this.canvasLogicalWidth = Math.max(1, Math.round(this.pageBaseWidth * 64) / 64);
    this.canvasLogicalHeight = Math.max(1, Math.round(this.pageBaseHeight * 64) / 64);
    this.refreshEraserCursor();
    this.tiles.setDisplayScale(this.zoom);
    this.tiles.setPage(this.currentPage(), this.canvasLogicalWidth, this.canvasLogicalHeight, this.tileExclusion());
    this.updateViewport(true);
  }
  updateViewport(refine) {
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
    if (refine || this.hasInkPreview()) {
      this.resizeOverlay(this.canvas, this.ctx);
      this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
      this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
      if (this.hasInkPreview()) {
        this.resizePreview();
        this.drawPreview();
      }
    }
    if (refine) this.tiles.prewarm(this.notebook.pages.filter((_2, index) => Math.abs(index - this.pageIndex) === 1));
  }
  drawStrokes(strokes) {
    if (!this.ctx || !this.pageElement) return;
    this.tiles.sync(strokes, this.tileExclusion());
    this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true);
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.drawPreview();
  }
  drawInteractiveStrokes(strokes, refine = false) {
    if (!this.ctx || !this.pageElement) return;
    this.tiles.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom, refine);
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
  }
  drawEraserInteraction() {
    if (!this.ctx || !this.pageElement) return;
    const cells = [...this.eraserPreviewCells];
    this.eraserPreviewCells.clear();
    this.tiles.previewInteractiveCells(cells, this.viewport, (window.devicePixelRatio || 1) * this.zoom);
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
      var _a;
      this.renderFrame = null;
      this.flushPendingLassoPoint();
      this.flushWorkerStrokePoints();
      const shouldResize = this.resizeRequested;
      this.resizeRequested = false;
      if (shouldResize) this.resizeCanvas();
      else if (this.lassoDrag) this.drawLassoInteraction();
      else if (((_a = this.interaction) == null ? void 0 : _a.tool) === "eraser") this.drawEraserInteraction();
      else if (this.hasInkPreview()) this.drawPreview();
      else this.drawStrokes(this.currentPage().strokes);
    });
  }
  resizeOverlay(canvas, ctx, maxPixels = 4e6) {
    const { x: x2, y: y2, width, height } = this.viewport;
    const resolution = canvasResolution(width, height, window.devicePixelRatio || 1, this.zoom, maxPixels);
    const left = x2 * this.zoom + "px", top = y2 * this.zoom + "px";
    const displayWidth = width * this.zoom + "px", displayHeight = height * this.zoom + "px";
    const changed = canvas.width !== resolution.width || canvas.height !== resolution.height || canvas.style.left !== left || canvas.style.top !== top || canvas.style.width !== displayWidth || canvas.style.height !== displayHeight;
    if (canvas.width !== resolution.width) canvas.width = resolution.width;
    if (canvas.height !== resolution.height) canvas.height = resolution.height;
    canvas.style.left = left;
    canvas.style.top = top;
    canvas.style.width = displayWidth;
    canvas.style.height = displayHeight;
    canvas.style.right = "auto";
    canvas.style.bottom = "auto";
    this.overlayScaleX = resolution.width / width;
    this.overlayScaleY = resolution.height / height;
    ctx.setTransform(this.overlayScaleX, 0, 0, this.overlayScaleY, -x2 * this.overlayScaleX, -y2 * this.overlayScaleY);
    return changed;
  }
  resizePreview() {
    this.resizeOverlay(this.previewCanvas, this.previewCtx, OVERLAY_PIXEL_BUDGET);
    if (this.confirmedPreviewCanvas && this.confirmedPreviewCtx) {
      if (this.resizeOverlay(this.confirmedPreviewCanvas, this.confirmedPreviewCtx, OVERLAY_PIXEL_BUDGET)) {
        this.redrawConfirmedPreview();
      }
    }
  }
  drawPreview() {
    var _a, _b;
    const outlines = (_a = this.confirmedStrokeOutlines) != null ? _a : this.confirmedStrokeOutlines = /* @__PURE__ */ new Map();
    const strokes = this.activeStroke && (this.activeStroke.tool === "pen" || this.activeStroke.tool === "highlighter") ? [this.activeStroke] : [];
    this.previewCtx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    if (strokes.length === 0) {
      this.previewCanvas.classList.remove("is-highlighter-preview");
      return;
    }
    this.previewCanvas.classList.toggle("is-highlighter-preview", strokes.every((stroke) => stroke.tool === "highlighter"));
    for (const stroke of strokes) {
      const confirmed = outlines.get(stroke.id);
      if (confirmed) {
        this.drawConfirmedOutline(this.previewCtx, confirmed.points, stroke.color, stroke.opacity, stroke.width, confirmed.mode);
      }
      drawImmediateStrokeTail(this.previewCtx, stroke, this.canvasLogicalWidth, this.canvasLogicalHeight, (_b = confirmed == null ? void 0 : confirmed.sampleCount) != null ? _b : 0);
    }
  }
  redrawConfirmedPreview() {
    if (!this.confirmedPreviewCanvas || !this.confirmedPreviewCtx) return;
    const strokes = [...this.pendingInkStrokes];
    this.confirmedPreviewCtx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.confirmedPreviewCanvas.classList.toggle(
      "is-highlighter-preview",
      strokes.length > 0 && strokes.every((stroke) => stroke.tool === "highlighter")
    );
    for (const stroke of strokes) this.drawCompletedPreviewStroke(this.confirmedPreviewCtx, stroke);
  }
  retainActivePreview() {
    if (!this.activeStroke || !this.confirmedPreviewCanvas || !this.confirmedPreviewCtx) return;
    this.drawCompletedPreviewStroke(this.confirmedPreviewCtx, this.activeStroke);
    this.confirmedPreviewCanvas.classList.toggle(
      "is-highlighter-preview",
      this.pendingInkStrokes.length > 0 && this.pendingInkStrokes.every((stroke) => stroke.tool === "highlighter")
    );
  }
  drawCompletedPreviewStroke(ctx, stroke) {
    var _a;
    const outlines = (_a = this.confirmedStrokeOutlines) != null ? _a : this.confirmedStrokeOutlines = /* @__PURE__ */ new Map();
    const confirmed = outlines.get(stroke.id);
    const firstBoundedTailSample = Math.max(0, stroke.points.length - LIVE_TAIL_SAMPLE_LIMIT);
    if (!confirmed || confirmed.sampleCount <= firstBoundedTailSample) {
      drawInkStroke(ctx, boundedPreviewStroke(stroke), this.canvasLogicalWidth, this.canvasLogicalHeight);
      return;
    }
    this.drawConfirmedOutline(ctx, confirmed.points, stroke.color, stroke.opacity, stroke.width, confirmed.mode);
    drawImmediateStrokeTail(ctx, stroke, this.canvasLogicalWidth, this.canvasLogicalHeight, confirmed.sampleCount);
  }
  drawConfirmedOutline(ctx, points, color, opacity, width, mode) {
    if (points.length < 4) return;
    ctx.save();
    ctx.globalAlpha = opacity;
    const scaleX = this.canvasLogicalWidth;
    const scaleY = this.canvasLogicalHeight;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (mode === "highlighter") {
      ctx.globalCompositeOperation = "multiply";
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(points[0] * scaleX, points[1] * scaleY);
      for (let index = 2; index < points.length; index += 2) {
        const previousX = points[index - 2] * scaleX;
        const previousY = points[index - 1] * scaleY;
        const pointX = points[index] * scaleX;
        const pointY = points[index + 1] * scaleY;
        const last = index === points.length - 2;
        ctx.quadraticCurveTo(
          previousX,
          previousY,
          last ? pointX : (previousX + pointX) / 2,
          last ? pointY : (previousY + pointY) / 2
        );
      }
      ctx.lineTo(points[points.length - 2] * scaleX, points[points.length - 1] * scaleY);
      ctx.stroke();
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.beginPath();
      ctx.moveTo(points[0] * scaleX, points[1] * scaleY);
      for (let index = 2; index < points.length; index += 2) {
        ctx.lineTo(points[index] * scaleX, points[index + 1] * scaleY);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  beginLassoPreview(page) {
    const drag = this.lassoDrag;
    if (!drag || !this.lassoCanvas) return;
    const selected = new Set(drag.strokes.map((stroke) => stroke.id));
    this.tiles.patchStrokes([], [...selected], page.strokes);
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
    this.lassoCanvas.style.width = `${this.canvasLogicalWidth * this.zoom}px`;
    this.lassoCanvas.style.height = `${this.canvasLogicalHeight * this.zoom}px`;
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
    this.tiles.patchStrokes(this.selectedStrokes(), [], page.strokes);
    this.tiles.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true, () => {
      this.hideLassoPreview();
      if (this.viewReady && page === this.currentPage()) {
        this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
        this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
        this.drawPreview();
      }
    });
  }
  hideLassoPreview() {
    if (!this.lassoCanvas) return;
    this.lassoCanvas.style.display = "none";
    this.lassoCanvas.style.transform = "none";
    this.lassoCanvas.width = this.lassoCanvas.height = 1;
  }
  commitPreview(page = this.currentPage()) {
    if (!this.activeStroke || this.activeStroke.tool !== "pen" && this.activeStroke.tool !== "highlighter") return;
    if (this.pendingInkPageId && this.pendingInkPageId !== page.id) this.discardPendingInkPreview();
    this.pendingInkPageId = page.id;
    if (!this.pendingInkStrokes.includes(this.activeStroke)) this.pendingInkStrokes.push(this.activeStroke);
  }
  hasInkPreview() {
    return this.activeStroke !== null || this.pendingInkStrokes.length > 0;
  }
  tileExclusion() {
    var _a, _b;
    const committing = new Set((_b = (_a = this.committingInkStrokes) == null ? void 0 : _a.map((stroke) => stroke.id)) != null ? _b : []);
    const excluded = /* @__PURE__ */ new Set();
    if (this.activeStroke) excluded.add(this.activeStroke.id);
    for (const stroke of this.pendingInkStrokes) if (!committing.has(stroke.id)) excluded.add(stroke.id);
    return excluded.size > 0 ? excluded : void 0;
  }
  startPendingInkCommit(page) {
    if (this.activePointerId !== null || this.committingInkStrokes || this.pendingInkStrokes.length === 0 || this.pendingInkPageId !== page.id || page !== this.currentPage()) return;
    const batch = [...this.pendingInkStrokes];
    this.committingInkStrokes = batch;
    this.tiles.patchStrokes(batch, [], page.strokes);
    this.tiles.commitInk(batch, this.viewport, (window.devicePixelRatio || 1) * this.zoom, (committed) => {
      var _a;
      if (this.committingInkStrokes !== batch) return;
      this.committingInkStrokes = null;
      if (!committed) {
        this.tiles.removeStrokes(batch.map((stroke) => stroke.id));
        if (this.viewReady && page === this.currentPage()) this.drawPreview();
        if (this.activePointerId === null) this.schedulePendingInkCommit(page);
        return;
      }
      const ids = new Set(batch.map((stroke) => stroke.id));
      this.pendingInkStrokes = this.pendingInkStrokes.filter((stroke) => !ids.has(stroke.id));
      if (this.pendingInkStrokes.length === 0) this.pendingInkPageId = null;
      const outlines = (_a = this.confirmedStrokeOutlines) != null ? _a : this.confirmedStrokeOutlines = /* @__PURE__ */ new Map();
      for (const stroke of batch) outlines.delete(stroke.id);
      if (this.viewReady && page === this.currentPage()) {
        this.redrawConfirmedPreview();
        this.drawPreview();
      }
      if (this.pendingInkStrokes.length > 0) this.schedulePendingInkCommit(page);
      else if (this.activePointerId === null) {
        this.applyPendingMergedNotebook();
        if (this.externalRefreshPending) {
          this.externalRefreshPending = false;
          void this.reloadFromDisk().catch((error) => new import_obsidian.Notice(`Ink Notes could not reload: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    });
  }
  schedulePendingInkCommit(page) {
    if (this.pendingInkStrokes.length === 0 || this.pendingInkPageId !== page.id) return;
    this.cancelPendingInkCommitTimer();
    this.inkCommitTimer = window.setTimeout(() => {
      this.inkCommitTimer = void 0;
      this.startPendingInkCommit(page);
    }, INK_COMMIT_IDLE_DELAY);
  }
  cancelPendingInkCommitTimer() {
    if (this.inkCommitTimer === void 0) return;
    window.clearTimeout(this.inkCommitTimer);
    this.inkCommitTimer = void 0;
  }
  discardPendingInkPreview() {
    var _a;
    this.cancelPendingInkCommitTimer();
    this.committingInkStrokes = null;
    this.pendingInkStrokes = [];
    this.pendingInkPageId = null;
    this.confirmedStrokeOutlines.clear();
    (_a = this.tiles) == null ? void 0 : _a.cancelInkCommit();
    if (this.confirmedPreviewCanvas) {
      this.confirmedPreviewCanvas.width = this.confirmedPreviewCanvas.height = 1;
      this.confirmedPreviewCanvas.classList.remove("is-highlighter-preview");
    }
    if (this.previewCanvas) {
      this.previewCanvas.width = this.previewCanvas.height = 1;
      this.previewCanvas.classList.remove("is-highlighter-preview");
    }
  }
  materializePendingInkPreview(page) {
    var _a;
    if (this.pendingInkPageId !== page.id) {
      this.discardPendingInkPreview();
      return;
    }
    const pending = [...new Map([
      ...this.pendingInkStrokes,
      ...(_a = this.committingInkStrokes) != null ? _a : []
    ].map((stroke) => [stroke.id, stroke])).values()];
    this.discardPendingInkPreview();
    if (pending.length === 0) return;
    const cells = this.tiles.patchStrokes(pending, [], page.strokes);
    this.tiles.previewInteractiveCells(cells, this.viewport, (window.devicePixelRatio || 1) * this.zoom);
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
  onPointerDown(event, source = "pointer") {
    var _a, _b;
    if (event.pointerType === "touch" || source === "pointer" && event.pointerType === "pen" && this.stylusTouchInput) return;
    this.pageNavigationGeneration += 1;
    if (this.activePointerId !== null) this.finishPointerInput(false);
    if (source === "pointer") this.capturePointer(event.pointerId);
    const page = this.currentPage();
    const tool = this.state.tool;
    const brush = isBrushTool(tool) ? this.brushSettings(tool) : null;
    const rect = this.pageElement.getBoundingClientRect();
    (_b = (_a = this.tiles) == null ? void 0 : _a.beginInput) == null ? void 0 : _b.call(_a);
    this.cancelPendingInkCommitTimer();
    if (tool === "pen" || tool === "highlighter") this.tiles.pauseInkCommit();
    else if (this.pendingInkStrokes.length > 0 || this.committingInkStrokes) this.materializePendingInkPreview(page);
    if (this.saveTimer !== void 0) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
    this.activePointerId = event.pointerId;
    this.interaction = {
      generation: ++this.interactionGeneration,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      source,
      pageId: page.id,
      tool,
      eraserMode: tool === "eraser" ? this.state.eraserMode : void 0,
      eraserSize: tool === "eraser" ? this.state.eraserSize : void 0
    };
    const point = this.toPoint(event, rect);
    this.erasedStrokeIds.clear();
    this.erasedCandidateIds.clear();
    this.erasedStrokes = [];
    this.eraserReplacementIds.clear();
    this.eraserReplacements = [];
    this.eraserPreviewCells.clear();
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
      color: brush.color,
      width: brush.width,
      opacity: brush.opacity,
      points: [point],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    this.workerStrokePointIndex = 1;
    if (tool === "pen" && this.shouldModelPenStroke()) this.startPenModeler(event, point, this.penModelerParams());
    this.queueWorkerOperation({
      type: "start-stroke",
      pageId: page.id,
      stroke: { ...this.activeStroke, points: [{ ...point }] },
      previewWidth: this.canvasLogicalWidth,
      previewHeight: this.canvasLogicalHeight,
      pageUpdatedAt: page.updatedAt,
      notebookUpdatedAt: this.notebook.updatedAt
    });
    this.lastPoint = point;
    page.strokes.push(this.activeStroke);
    this.resizePreview();
    this.drawPreview();
  }
  onPointerEnter(event) {
    if (event.pointerType === "touch") return;
    const rect = this.pageElement.getBoundingClientRect();
    this.updateEraserHover(this.toPoint(event, rect), pointInsideRect(event, rect));
  }
  onPointerMove(event, source = "pointer") {
    var _a, _b, _c, _d;
    if (event.pointerType === "touch") return;
    if (this.interaction && ((_a = this.interaction.source) != null ? _a : "pointer") !== source) return;
    const rect = this.pageElement.getBoundingClientRect();
    const point = this.toPoint(event, rect);
    const inside = pointInsideRect(event, rect);
    if (this.activePointerId === null) {
      if (((_b = this.rawUpdateCapture) == null ? void 0 : _b.pointerId) !== event.pointerId) this.recordPenSampleIntervals(this.pointerSamples(event));
      this.updateEraserHover(point, inside);
      return;
    }
    if (this.activePointerId !== event.pointerId) return;
    if (((_c = this.interaction) == null ? void 0 : _c.tool) === "eraser") this.updateEraserHover(point, inside);
    if (((_d = this.rawUpdateCapture) == null ? void 0 : _d.pointerId) === event.pointerId) return;
    this.applyPointerSamples(event, rect, "move");
  }
  /** Consumes Chromium raw hardware samples so ink forms at full pen rate
   *  instead of waiting for the next frame-aligned pointermove batch. */
  onPointerRawUpdate(event) {
    var _a;
    if (this.activePointerId === null || event.pointerId !== this.activePointerId) return;
    const interaction = this.interaction;
    if (!interaction || ((_a = interaction.source) != null ? _a : "pointer") !== "pointer") return;
    if (interaction.tool !== "pen" && interaction.tool !== "highlighter") return;
    if (typeof event.timeStamp !== "number" || !Number.isFinite(event.timeStamp)) {
      this.rawUpdateCapture = null;
      return;
    }
    if (this.rawUpdateCapture && this.rawUpdateCapture.pointerId !== event.pointerId) return;
    if (!this.rawUpdateCapture) this.rawUpdateCapture = { pointerId: event.pointerId, lastTime: event.timeStamp - 1 };
    this.applyPointerSamples(event);
  }
  onPointerUp(event, source = "pointer") {
    var _a, _b;
    if (this.activePointerId !== event.pointerId || ((_b = (_a = this.interaction) == null ? void 0 : _a.source) != null ? _b : "pointer") !== source) return;
    const rect = this.pageElement.getBoundingClientRect();
    const point = this.toPoint(event, rect);
    const inside = pointInsideRect(event, rect);
    this.applyPointerSamples(event, rect, "up");
    try {
      if (source === "pointer") this.releasePointer(event.pointerId);
    } finally {
      this.finishPointerInput(true);
    }
    this.updateEraserHover(point, inside);
  }
  onPointerCancel(event, source = "pointer") {
    var _a, _b;
    if (this.activePointerId !== event.pointerId || ((_b = (_a = this.interaction) == null ? void 0 : _a.source) != null ? _b : "pointer") !== source) return;
    this.eraserPointerInside = false;
    this.finishPointerInput(false);
  }
  applyPointerSamples(event, rect = this.pageElement.getBoundingClientRect(), phase = "move") {
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
    let feed = samples;
    const raw = this.rawUpdateCapture;
    if (raw && raw.pointerId === event.pointerId && (interaction.tool === "pen" || interaction.tool === "highlighter")) {
      let newest = raw.lastTime;
      feed = [];
      for (const sample of samples) {
        const time = sample.timeStamp;
        if (typeof time === "number" && time <= raw.lastTime) continue;
        feed.push(sample);
        if (typeof time === "number" && time > newest) newest = time;
      }
      raw.lastTime = newest;
      if (feed.length === 0) return;
    }
    this.recordPenSampleIntervals(feed);
    let changed = false;
    if (interaction.tool === "pen" && this.penModeler && !this.penModeler.fallback) {
      changed = this.appendModeledPenPoints(feed, rect, phase);
    } else {
      for (const sample of feed) {
        const point = this.toPoint(sample, rect);
        if (interaction.tool === "eraser") {
          changed = this.eraseAt(point, page, interaction.eraserMode, interaction.eraserSize) || changed;
        } else if (this.activeStroke && this.lastPoint) {
          if (distance2(point, this.lastPoint) <= 0) continue;
          this.activeStroke.points.push(point);
          this.lastPoint = point;
          changed = true;
        }
      }
    }
    if (changed) {
      if (this.activeStroke) this.activeStroke.updatedAt = Date.now();
      this.requestRender();
    }
  }
  /** Feeds raw pointer samples through the stroke modeler and stores its results. */
  appendModeledPenPoints(samples, rect, phase) {
    const capture = this.penModeler;
    const stroke = this.activeStroke;
    if (!stroke) return false;
    let changed = false;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const point = this.toPoint(sample, rect);
      if (capture.fallback) {
        if (this.appendRawPenPoint(stroke, point)) changed = true;
        continue;
      }
      const isLift = phase === "up" && index === samples.length - 1;
      const rawPressure = sample.pressure > 0 ? sample.pressure : capture.lastRawPressure;
      capture.lastRawPressure = rawPressure;
      const input = {
        eventType: isLift ? "up" : "move",
        position: { x: point.x * capture.pageWidth, y: point.y * capture.pageHeight },
        time: penSampleTimeMillis(sample) / 1e3,
        pressure: rawPressure,
        tiltX: sample.tiltX,
        tiltY: sample.tiltY
      };
      this.updatePenModeler(input, isLift);
      if (capture.fallback) {
        this.appendRawPenPoint(stroke, point);
        changed = true;
        continue;
      }
      changed = true;
    }
    return changed;
  }
  /** Runs one modeler input and appends its results, guarding stroke bloat. */
  updatePenModeler(input, _isLift) {
    var _a;
    const capture = this.penModeler;
    const stroke = this.activeStroke;
    let results;
    try {
      results = capture.modeler.update(input);
    } catch (e2) {
      capture.fallback = true;
      return false;
    }
    capture.lastInput = _isLift ? null : input;
    let changed = false;
    for (const result of results) {
      if (Math.hypot(result.position.x - capture.lastStored.x, result.position.y - capture.lastStored.y) < PEN_CAPTURE_MIN_DISTANCE) continue;
      capture.lastStored = { x: result.position.x, y: result.position.y };
      const point = {
        x: result.position.x / capture.pageWidth,
        y: result.position.y / capture.pageHeight,
        pressure: (_a = result.pressure) != null ? _a : 0.5,
        tiltX: result.tiltX,
        tiltY: result.tiltY,
        t: result.time * 1e3
      };
      stroke.points.push(point);
      this.lastPoint = point;
      changed = true;
    }
    return changed;
  }
  appendRawPenPoint(stroke, point) {
    if (!this.lastPoint || distance2(point, this.lastPoint) <= 0) return false;
    stroke.points.push(point);
    this.lastPoint = point;
    return true;
  }
  /** Completes a stroke whose pointer vanished without an up event. */
  flushPenModeler() {
    const capture = this.penModeler;
    if (!capture || capture.fallback || !capture.lastInput) return;
    this.updatePenModeler({ ...capture.lastInput, eventType: "up" }, true);
  }
  /** Ink stays direct (raw samples, probe-style) unless the user picked a
   *  smooth strength or the device itself samples too sparsely. */
  shouldModelPenStroke() {
    var _a;
    if (((_a = this.state.pen.smooth) != null ? _a : 0) > 0) return true;
    return this.penInputSparse();
  }
  /** Sparse devices get the proven default tuning; an explicit strength maps
   *  through the slider curve. */
  penModelerParams() {
    var _a;
    const smooth = (_a = this.state.pen.smooth) != null ? _a : 0;
    return smooth > 0 ? strokeModelParamsForSmoothStrength(smooth) : DEFAULT_STROKE_MODEL_PARAMS;
  }
  penInputSparse() {
    if (this.penSampleIntervals.length < PEN_SPARSE_MIN_INTERVALS) return false;
    const sorted = [...this.penSampleIntervals].sort((a2, b2) => a2 - b2);
    return sorted[Math.floor(sorted.length / 2)] > SPARSE_SAMPLE_INTERVAL_MS;
  }
  /** Feeds the device-rate history from one batch of consumed samples. */
  recordPenSampleIntervals(samples) {
    for (const sample of samples) {
      const time = sample.timeStamp;
      if (typeof time !== "number" || !Number.isFinite(time)) continue;
      if (this.lastPenSampleTime !== null) {
        const interval = time - this.lastPenSampleTime;
        if (interval > 0 && interval < 120) {
          this.penSampleIntervals.push(interval);
          if (this.penSampleIntervals.length > PEN_SAMPLE_INTERVAL_WINDOW) this.penSampleIntervals.shift();
        }
      }
      this.lastPenSampleTime = time;
    }
  }
  startPenModeler(event, point, params) {
    const pageWidth = this.notebook.pageWidth;
    const pageHeight = this.notebook.pageHeight;
    const modeler = new StrokeModeler(params);
    const input = {
      eventType: "down",
      position: { x: point.x * pageWidth, y: point.y * pageHeight },
      time: penSampleTimeMillis(event) / 1e3,
      pressure: point.pressure,
      tiltX: event.tiltX,
      tiltY: event.tiltY
    };
    try {
      modeler.update(input);
    } catch (e2) {
      return;
    }
    point.t = input.time * 1e3;
    this.penModeler = {
      modeler,
      pageWidth,
      pageHeight,
      lastInput: input,
      lastRawPressure: point.pressure,
      lastStored: { ...input.position },
      fallback: false
    };
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
      this.lassoCanvas.style.transform = `translate(${dx * this.canvasLogicalWidth * this.zoom}px, ${dy * this.canvasLogicalHeight * this.zoom}px)`;
      return true;
    }
    const previous = this.lassoPath[this.lassoPath.length - 1];
    if (!previous || distance2(point, previous) < 1e-3) return false;
    this.lassoPath.push(point);
    return true;
  }
  flushPendingLassoPoint() {
    const point = this.pendingLassoPoint;
    this.pendingLassoPoint = null;
    if (point) this.applyLassoPoint(point);
  }
  flushWorkerStrokePoints() {
    const stroke = this.activeStroke;
    const interaction = this.interaction;
    if (!stroke || !interaction || interaction.tool !== "pen" && interaction.tool !== "highlighter") return;
    if (this.workerStrokePointIndex >= stroke.points.length) return;
    const points = packStrokePoints(stroke.points, this.workerStrokePointIndex);
    this.workerStrokePointIndex = stroke.points.length;
    this.queueWorkerOperation({
      type: "append-stroke-points",
      pageId: stroke.pageId,
      strokeId: stroke.id,
      points,
      previewWidth: this.canvasLogicalWidth,
      previewHeight: this.canvasLogicalHeight,
      pageUpdatedAt: stroke.updatedAt,
      notebookUpdatedAt: this.notebook.updatedAt
    }, [points.buffer], (response) => {
      var _a, _b, _c, _d;
      if (response.type !== "operation-applied" || !response.outline || response.strokeId !== stroke.id || ((_a = this.activeStroke) == null ? void 0 : _a.id) !== stroke.id && !this.pendingInkStrokes.some((candidate) => candidate.id === stroke.id)) return;
      const outlines = (_b = this.confirmedStrokeOutlines) != null ? _b : this.confirmedStrokeOutlines = /* @__PURE__ */ new Map();
      const previous = outlines.get(stroke.id);
      const sampleCount = (_c = response.sampleCount) != null ? _c : stroke.points.length;
      if (previous && previous.sampleCount >= sampleCount) return;
      outlines.set(stroke.id, {
        points: response.outline,
        sampleCount,
        mode: (_d = response.outlineMode) != null ? _d : "pen"
      });
      this.requestRender();
    });
  }
  finishPointerInput(_includeFinalSample = false) {
    this.flushPenModeler();
    const interaction = this.interaction;
    if (!interaction) return;
    const page = this.pageById(interaction.pageId);
    if (!page) {
      this.interaction = null;
      this.refreshEraserCursor();
      this.activePointerId = null;
      this.penModeler = null;
      this.rawUpdateCapture = null;
      this.tiles.resumeInkCommit();
      return;
    }
    this.flushPendingLassoPoint();
    this.flushWorkerStrokePoints();
    this.commitPreview(page);
    this.interaction = null;
    this.refreshEraserCursor();
    if (this.activeStroke && this.renderFrame !== null && !this.resizeRequested) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
    if (interaction.tool === "lasso") {
      this.finishLasso(page);
      this.activePointerId = null;
      this.tiles.resumeInkCommit();
      this.applyPendingMergedNotebook();
      return;
    }
    if (interaction.tool === "eraser" && this.erasedStrokes.length > 0) {
      this.markChanged(page);
      const replacementIds = new Set(this.eraserReplacements.map((stroke) => stroke.id));
      this.queueWorkerOperation({
        type: "patch-strokes",
        pageId: page.id,
        upsert: page.strokes.filter((stroke) => replacementIds.has(stroke.id)).map(cloneStroke),
        remove: [.../* @__PURE__ */ new Set([...this.erasedStrokes.map((stroke) => stroke.id), ...replacementIds])],
        deletedStrokeIds: [...page.deletedStrokeIds],
        pageUpdatedAt: page.updatedAt,
        notebookUpdatedAt: this.notebook.updatedAt
      });
      this.pushCommand(this.erasedStrokesCommand(page.id, this.erasedStrokes, this.eraserReplacements));
      this.drawInteractiveStrokes(page.strokes, true);
    } else if (this.activeStroke) {
      this.markChanged(page);
      this.retainActivePreview();
      this.queueWorkerOperation({
        type: "complete-stroke",
        pageId: page.id,
        strokeId: this.activeStroke.id,
        pageUpdatedAt: page.updatedAt,
        notebookUpdatedAt: this.notebook.updatedAt
      });
      this.pushCommand(this.addedStrokeCommand(page.id, this.activeStroke));
    }
    this.activePointerId = null;
    this.activeStroke = null;
    this.workerStrokePointIndex = 0;
    this.lastPoint = null;
    this.penModeler = null;
    this.rawUpdateCapture = null;
    this.pendingLassoPoint = null;
    this.eraserPreviewCells.clear();
    if (interaction.tool === "pen" || interaction.tool === "highlighter") {
      this.resizePreview();
      this.drawPreview();
      this.schedulePendingInkCommit(page);
    }
    this.tiles.resumeInkCommit();
    this.applyPendingMergedNotebook();
    this.scheduleSave();
    if (this.externalRefreshPending && this.pendingInkStrokes.length === 0) {
      this.externalRefreshPending = false;
      void this.reloadFromDisk().catch((error) => new import_obsidian.Notice(`Ink Notes could not reload: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  applyPendingMergedNotebook() {
    if (!this.pendingMergedNotebook || this.activePointerId !== null || this.pendingInkStrokes.length > 0) return;
    const pageId = this.currentPage().id;
    const previousPageIndex = this.pageIndex;
    const merged = this.pendingMergedNotebookIsFinal ? this.pendingMergedNotebook : mergeNotebooks(this.pendingMergedNotebook, this.notebook);
    this.pendingMergedNotebook = null;
    this.pendingMergedNotebookIsFinal = false;
    const changes = reconcileNotebook(this.notebook, merged, pageId, previousPageIndex);
    this.pageIndex = changes.pageIndex;
    if (changes.pageRailChanged) this.renderPageRail();
    if (changes.currentPageChanged || changes.currentPaperChanged || changes.dimensionsChanged) {
      this.renderPage();
    } else {
      if (changes.pageRailChanged) this.updatePageStatus();
      if (changes.currentInkChanged) this.drawStrokes(this.currentPage().strokes);
    }
  }
  receiveMergedNotebook(notebook, alreadyMerged = false) {
    this.pendingMergedNotebook = this.pendingMergedNotebook ? mergeNotebooks(this.pendingMergedNotebook, notebook) : notebook;
    this.pendingMergedNotebookIsFinal || (this.pendingMergedNotebookIsFinal = alreadyMerged);
    if (this.activePointerId === null && this.pendingInkStrokes.length === 0) this.applyPendingMergedNotebook();
  }
  onLostPointerCapture(event) {
    if (this.activePointerId !== event.pointerId) return;
  }
  onDocumentPointerEnd(event) {
    var _a;
    if (((_a = this.interaction) == null ? void 0 : _a.source) !== "stylus-touch" && this.activePointerId === event.pointerId) this.finishPointerInput(false);
  }
  registerPointerEndEvents() {
    var _a, _b;
    let owner = this.pageElement.ownerDocument;
    const end = (event) => this.onDocumentPointerEnd(event);
    const bind = () => {
      owner.addEventListener("pointerup", end);
      owner.addEventListener("pointercancel", end);
    };
    const unbind = () => {
      owner.removeEventListener("pointerup", end);
      owner.removeEventListener("pointercancel", end);
    };
    bind();
    const stopMigration = (_b = (_a = this.pageElement).onWindowMigrated) == null ? void 0 : _b.call(_a, () => {
      if (owner === this.pageElement.ownerDocument) return;
      unbind();
      owner = this.pageElement.ownerDocument;
      bind();
    });
    this.register(() => {
      stopMigration == null ? void 0 : stopMigration();
      unbind();
    });
  }
  capturePointer(pointerId) {
    if (this.pageElement.hasPointerCapture(pointerId)) return;
    try {
      this.pageElement.setPointerCapture(pointerId);
    } catch (error) {
      if (!isPointerCaptureError(error)) throw error;
    }
  }
  releasePointer(pointerId) {
    try {
      if (this.pageElement.hasPointerCapture(pointerId)) this.pageElement.releasePointerCapture(pointerId);
    } catch (error) {
      if (!isPointerCaptureError(error)) throw error;
    }
  }
  onWheel(event) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.setZoom(this.zoom * (event.deltaY > 0 ? 0.92 : 1.08), { x: event.clientX, y: event.clientY });
  }
  onTouchStart(event) {
    if (this.onStylusTouch(event)) return;
    if (event.cancelable && event.touches.length < 2) event.preventDefault();
    this.touchGesture = null;
    const touches = Array.from(event.touches).filter((touch) => touch.touchType !== "stylus");
    if (this.activePointerId !== null || touches.length < 1 || touches.length > 2) return;
    event.preventDefault();
    const [a2, b2] = touches;
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
    if (this.onStylusTouch(event)) return;
    if (this.activePointerId !== null) {
      this.touchGesture = null;
      return;
    }
    const gesture = this.touchGesture;
    if (!gesture) return;
    const touches = Array.from(event.touches).filter((touch) => touch.touchType !== "stylus");
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
  onStylusTouch(event) {
    var _a;
    const touch = Array.from((_a = event.changedTouches) != null ? _a : []).find((candidate) => candidate.touchType === "stylus" && this.pageElement.contains(candidate.target));
    if (!touch) return false;
    if (event.cancelable) event.preventDefault();
    this.touchGesture = null;
    const sample = stylusTouchSample(touch, event.timeStamp);
    const interaction = this.interaction;
    if (event.type === "touchstart") {
      this.stylusTouchInput = true;
      if ((interaction == null ? void 0 : interaction.source) === "pointer" && interaction.pointerType === "pen") {
        const pointerId = interaction.pointerId;
        interaction.source = "stylus-touch";
        interaction.pointerId = touch.identifier;
        this.activePointerId = touch.identifier;
        this.releasePointer(pointerId);
      } else {
        this.onPointerDown(sample, "stylus-touch");
      }
    } else if ((interaction == null ? void 0 : interaction.source) === "stylus-touch" && interaction.pointerId === touch.identifier) {
      if (event.type === "touchmove") this.onPointerMove(sample, "stylus-touch");
      else if (event.type === "touchend") {
        this.onPointerUp(sample, "stylus-touch");
        return false;
      } else if (event.type === "touchcancel") this.onPointerCancel(sample, "stylus-touch");
    }
    return true;
  }
  toPoint(event, rect = this.pageElement.getBoundingClientRect()) {
    var _a, _b;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      // Lift events (and some coalesced samples) report pressure 0. Inherit
      // the previous sample's pressure instead of a 0.5 default: a pressure
      // jump at the tail makes the outline end in a thin line with a
      // full-width round cap dot.
      pressure: event.pressure > 0 ? event.pressure : (_b = (_a = this.lastPoint) == null ? void 0 : _a.pressure) != null ? _b : 0.5,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      t: Date.now()
    };
  }
  eraseAt(point, page = this.currentPage(), mode = this.state.eraserMode, size = this.state.eraserSize) {
    var _a, _b, _c;
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
    const replacements = [];
    if (mode !== "stroke") {
      const now = Date.now();
      for (const stroke of removed) {
        const segments = eraseStrokeSegments(stroke, point, radius, mode, this.canvasLogicalWidth, this.canvasLogicalHeight);
        for (const points of segments) {
          const replacement = { ...cloneStroke(stroke), id: newId("stroke"), points, createdAt: now, updatedAt: now };
          page.strokes.push(replacement);
          replacements.push(replacement);
          this.eraserReplacementIds.add(replacement.id);
          this.eraserReplacements.push(cloneStroke(replacement));
        }
      }
      page.strokes.sort((left, right) => left.createdAt - right.createdAt);
    }
    if (page === this.currentPage()) {
      for (const cell of (_c = (_b = this.tiles) == null ? void 0 : _b.patchStrokes(replacements, removed.map((stroke) => stroke.id), page.strokes)) != null ? _c : []) {
        this.eraserPreviewCells.add(cell);
      }
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
    this.eraserCursor.style.width = `${size * this.zoom}px`;
    this.eraserCursor.style.height = `${size * this.zoom}px`;
    if (!this.eraserHoverPoint) return;
    this.eraserCursor.style.left = `${this.eraserHoverPoint.x * this.canvasLogicalWidth * this.zoom}px`;
    this.eraserCursor.style.top = `${this.eraserHoverPoint.y * this.canvasLogicalHeight * this.zoom}px`;
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
    this.queueWorkerOperation({
      type: "page-operation",
      action: "add",
      page: clonePage(page),
      pageOrder: [...this.notebook.pageOrder],
      pageOrderUpdatedAt: now,
      notebookUpdatedAt: now
    });
    this.pageIndex = this.notebook.pages.length - 1;
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, page.id);
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }
  changePage(delta) {
    const index = Math.max(0, Math.min(this.notebook.pages.length - 1, this.pageIndex + delta));
    const page = this.notebook.pages[index];
    if (page) this.navigateToPage(page.id);
  }
  navigateToPage(pageId) {
    if (this.currentPage().id === pageId || !this.pageById(pageId)) return;
    this.finishPointerInput(false);
    this.clearSaveTimers();
    const navigationGeneration = ++this.pageNavigationGeneration;
    const file = this.file;
    const session = this.workerSession;
    const workerRevision = this.workerRevision;
    void (async () => {
      if (file && (this.dirtyRevision > this.savedRevision || this.activeSave)) {
        await this.save(file);
      } else if (session) {
        try {
          await session.barrier(workerRevision);
        } catch (error) {
          if (this.workerSession === session) this.disableWorkerSession(error);
        }
      }
      if (navigationGeneration !== this.pageNavigationGeneration || !this.viewReady || file !== this.file) return;
      const index = this.notebook.pages.findIndex((page) => page.id === pageId);
      if (index < 0) return;
      this.pageIndex = index;
      this.renderPageRail();
      this.renderPage();
    })().catch((error) => new import_obsidian.Notice(`Ink Notes could not switch pages: ${error instanceof Error ? error.message : String(error)}`));
  }
  openPageMenu(event) {
    const menu = new import_obsidian.Menu();
    for (const paper of ["blank", "ruled", "grid", "dot"]) menu.addItem((item) => item.setTitle(`Paper: ${paper}`).setChecked(this.currentPage().paper === paper).onClick(() => {
      const page = this.currentPage();
      const before = page.paper;
      page.paper = paper;
      this.markChanged(page);
      this.queueWorkerOperation({
        type: "set-page",
        pageId: page.id,
        paper,
        pageUpdatedAt: page.updatedAt,
        notebookUpdatedAt: this.notebook.updatedAt
      });
      this.pushCommand({
        undo: () => this.setPagePaper(page.id, before),
        redo: () => this.setPagePaper(page.id, paper),
        rebuild: true
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
    this.queueWorkerOperation({
      type: "set-page",
      pageId: page.id,
      title,
      pageUpdatedAt: page.updatedAt,
      notebookUpdatedAt: this.notebook.updatedAt
    });
    this.pushCommand({
      undo: () => this.setPageTitle(page.id, before),
      redo: () => this.setPageTitle(page.id, title),
      rebuild: true
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
    this.finishPageOrderChange(now, {
      type: "page-operation",
      action: "duplicate",
      page: clonePage(page),
      pageOrder: this.notebook.pages.map((candidate) => candidate.id),
      pageOrderUpdatedAt: now,
      notebookUpdatedAt: now
    });
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
    this.finishPageOrderChange(now, {
      type: "page-operation",
      action: "delete",
      pageId: deleted.id,
      deletedAt: now,
      pageOrder: this.notebook.pages.map((candidate) => candidate.id),
      pageOrderUpdatedAt: now,
      notebookUpdatedAt: now
    });
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
    const now = Date.now();
    this.finishPageOrderChange(now, {
      type: "page-operation",
      action: "reorder",
      pageOrder: this.notebook.pages.map((candidate) => candidate.id),
      pageOrderUpdatedAt: now,
      notebookUpdatedAt: now
    });
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), pageId, pageId);
    this.renderAll();
    this.scheduleSave();
  }
  finishPageOrderChange(now, operation) {
    this.notebook.pageOrder = this.notebook.pages.map((page) => page.id);
    this.notebook.pageOrderUpdatedAt = now;
    this.notebook.updatedAt = now;
    this.dirtyRevision += 1;
    this.queueWorkerOperation(operation != null ? operation : {
      type: "page-operation",
      action: "reorder",
      pageOrder: [...this.notebook.pageOrder],
      pageOrderUpdatedAt: now,
      notebookUpdatedAt: now
    });
  }
  pushNotebookCommand(before, after, beforePageId, afterPageId) {
    this.pushCommand({
      undo: () => this.restoreNotebookState(before, beforePageId),
      redo: () => this.restoreNotebookState(after, afterPageId),
      rebuild: true
    });
  }
  restoreNotebookState(snapshot, selectedPageId) {
    var _a, _b;
    const current = this.notebook;
    const next = cloneNotebook(snapshot);
    const now = Date.now();
    const nextIds = new Set(next.pages.map((page) => page.id));
    const deletedPages = { ...current.deletedPages };
    for (const [pageId, deletedAt] of Object.entries(next.deletedPages)) {
      deletedPages[pageId] = Math.max((_a = deletedPages[pageId]) != null ? _a : 0, deletedAt);
    }
    for (const page of current.pages) {
      if (!nextIds.has(page.id)) deletedPages[page.id] = Math.max((_b = deletedPages[page.id]) != null ? _b : 0, now);
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
    this.queueWorkerOperation({ type: "history-restore", notebook: cloneNotebook(this.notebook) });
  }
  setPagePaper(pageId, paper) {
    const page = this.pageById(pageId);
    if (!page) return;
    page.paper = paper;
    this.markChanged(page);
    this.queueWorkerOperation({
      type: "set-page",
      pageId,
      paper,
      pageUpdatedAt: page.updatedAt,
      notebookUpdatedAt: this.notebook.updatedAt
    });
  }
  setPageTitle(pageId, title) {
    const page = this.pageById(pageId);
    if (!page) return;
    page.title = title;
    this.markChanged(page);
    this.queueWorkerOperation({
      type: "set-page",
      pageId,
      title,
      pageUpdatedAt: page.updatedAt,
      notebookUpdatedAt: this.notebook.updatedAt
    });
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
      this.finishPointerInput(false);
      if (this.state.tool === tool && (tool === "pen" || tool === "highlighter" || tool === "eraser")) {
        this.setSizePopoverOpen(!this.sizePopoverOpen);
        return;
      }
      this.state.tool = tool;
      if (tool !== "lasso") this.clearSelection();
      this.updateBrushControls();
      this.updateToolButtons();
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
  addColorPicker(parent, tool, toolLabel) {
    const settings = this.brushSettings(tool);
    parent.createDiv({ cls: "ink-settings-label", text: "Color" });
    const control = parent.createDiv({ cls: "ink-color-control", attr: { "data-brush-tool": tool } });
    const swatches = control.createDiv({ cls: "ink-color-swatches" });
    for (const color of INK_COLORS) {
      const swatch = swatches.createEl("button", { cls: "ink-color-swatch", attr: {
        type: "button",
        title: color.label,
        "aria-label": `${toolLabel} ${color.label.toLowerCase()}`,
        "aria-pressed": String(settings.color.toLowerCase() === color.value),
        "data-color": color.value,
        "data-brush-tool": tool
      } });
      swatch.style.backgroundColor = color.value;
      if (settings.color.toLowerCase() === color.value) swatch.addClass("is-active");
      swatch.addEventListener("click", () => {
        settings.color = color.value;
        this.updateColorSwatches(tool);
      });
    }
    const custom = control.createEl("label", { cls: "ink-custom-color", attr: { title: "Custom color" } });
    (0, import_obsidian.setIcon)(custom.createSpan({ cls: "ink-button-icon" }), "plus");
    const input = custom.createEl("input", { attr: {
      type: "color",
      value: settings.color,
      "aria-label": `${toolLabel} custom color`,
      "data-brush-tool": tool
    } });
    input.addEventListener("input", () => {
      settings.color = input.value;
      this.updateColorSwatches(tool);
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
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const availableWidth = Math.max(1, this.pageScroller.clientWidth - paddingLeft - paddingRight);
    const width = Math.min(980, availableWidth);
    const horizontalGutter = Math.max(0, (availableWidth - width) / 2);
    const height = width * this.notebook.pageHeight / this.notebook.pageWidth;
    this.pageBaseWidth = width;
    this.pageBaseHeight = height;
    const displayWidth = width * this.zoom;
    const displayHeight = height * this.zoom;
    this.pageElement.style.left = horizontalGutter + "px";
    this.pageElement.style.width = displayWidth + "px";
    this.pageElement.style.height = displayHeight + "px";
    if (typeof this.pageElement.style.setProperty === "function") {
      this.pageElement.style.setProperty("--ink-page-scale", String(this.zoom));
    }
    this.pageElement.style.zoom = "";
    this.pageElement.style.transform = "none";
    this.pageExtent.style.width = displayWidth + horizontalGutter * 2 + "px";
    this.pageExtent.style.height = displayHeight + "px";
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
      this.tiles.setDisplayScale(this.zoom);
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
    if (this.maxSaveDue && this.activePointerId === null) {
      this.maxSaveDue = false;
      void this.save();
      return;
    }
    if (this.saveTimer !== void 0) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = void 0;
      void this.save();
    }, SAVE_IDLE_DELAY);
    if (this.maxSaveTimer === void 0) {
      this.maxSaveTimer = window.setTimeout(() => {
        this.maxSaveTimer = void 0;
        if (this.activePointerId !== null) {
          this.maxSaveDue = true;
          return;
        }
        void this.save();
      }, SAVE_MAX_DELAY);
    }
  }
  clearSaveTimers() {
    if (this.saveTimer !== void 0) window.clearTimeout(this.saveTimer);
    if (this.maxSaveTimer !== void 0) window.clearTimeout(this.maxSaveTimer);
    this.saveTimer = void 0;
    this.maxSaveTimer = void 0;
  }
  async save(file = this.file) {
    if (!file) return;
    this.maxSaveDue = false;
    this.clearSaveTimers();
    if (this.activeSave) {
      this.saveRequested = true;
      try {
        await this.activeSave;
      } catch (error) {
        this.reportSaveFailure(file, error);
      }
      return;
    }
    const saving = this.performSave(file);
    this.activeSave = saving;
    try {
      await saving;
    } catch (error) {
      this.reportSaveFailure(file, error);
    }
    if (this.activeSave === saving) this.activeSave = null;
  }
  reportSaveFailure(file, error) {
    new import_obsidian.Notice(`Ink Notes could not save ${file.path || "notebook"}: ${error instanceof Error ? error.message : String(error)}`);
  }
  async performSave(file) {
    this.syncing = true;
    try {
      do {
        this.saveRequested = false;
        const revision = this.dirtyRevision;
        try {
          const result = await this.saveRevision(file, revision);
          this.savedRevision = Math.max(this.savedRevision, result.revision);
          if (result.merged && this.file === file) this.receiveMergedNotebook(result.merged);
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
      if (this.dirtyRevision > this.savedRevision && this.saveRequested) this.scheduleSave();
    }
  }
  async saveRevision(file, minimumRevision) {
    const session = this.workerSession;
    if (session) {
      try {
        return await this.saveRevisionWithWorker(file, session, minimumRevision);
      } catch (error) {
        if (error instanceof InkWorkerRequestError && error.code === "invalid-format") throw error;
        if (error instanceof SaveConflictError) throw error;
        if (this.workerSession === session) this.disableWorkerSession(error);
      }
    }
    const snapshot = cloneNotebook(this.notebook);
    return { revision: minimumRevision, merged: await this.store.save(file, snapshot) };
  }
  async saveRevisionWithWorker(file, session, minimumRevision) {
    await session.barrier(this.workerRevision);
    let raw = await this.store.readRaw(file);
    for (let attempt = 0; attempt < SAVE_CONFLICT_RETRIES; attempt++) {
      const prepared = await session.prepareSave(raw, minimumRevision);
      if (await this.store.writeIfUnchanged(file, raw, prepared.content)) {
        try {
          await session.commitSave(prepared.token);
          return { revision: minimumRevision };
        } catch (error) {
          if (this.workerSession === session) this.disableWorkerSession(error);
          return { revision: minimumRevision, merged: await this.store.read(file) };
        }
      }
      await session.abortSave(prepared.token);
      raw = await this.store.readRaw(file);
    }
    throw new SaveConflictError(`Cannot save ${file.path || "notebook"}: the file kept changing`);
  }
  undo() {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.afterCommand(command);
  }
  redo() {
    const command = this.redoStack.pop();
    if (!command) return;
    command.redo();
    this.undoStack.push(command);
    this.afterCommand(command);
  }
  pushCommand(command) {
    this.undoStack.push(command);
    this.redoStack = [];
    this.updateHistoryButtons();
  }
  afterCommand(command) {
    this.discardPendingInkPreview();
    this.clearSelection();
    this.updateHistoryButtons();
    if (command.rebuild) this.renderAll();
    else this.drawInteractiveStrokes(this.currentPage().strokes, true);
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
  updateColorSwatches(tool) {
    const settings = this.brushSettings(tool);
    const custom = this.root.querySelector(`input[type="color"][data-brush-tool="${tool}"]`);
    if (custom) custom.value = settings.color;
    this.root.querySelectorAll(`.ink-color-swatch[data-brush-tool="${tool}"]`).forEach((swatch) => {
      const active = swatch.dataset.color === settings.color.toLowerCase();
      swatch.toggleClass("is-active", active);
      swatch.setAttribute("aria-pressed", String(active));
    });
    this.updateBrushPreview(tool);
  }
  addedStrokeCommand(pageId, original) {
    let currentId = original.id;
    let template = original;
    return {
      undo: () => {
        var _a;
        const page = this.pageById(pageId);
        if (!page) return;
        template = (_a = page.strokes.find((stroke) => stroke.id === currentId)) != null ? _a : template;
        this.deleteStrokes(page, [currentId]);
        this.markChanged(page);
        this.queueStrokePatch(page, [], [currentId]);
      },
      redo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        const restored = restoredStroke(template);
        currentId = restored.id;
        page.strokes.push(restored);
        this.markChanged(page);
        this.queueStrokePatch(page, [restored], []);
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
        this.queueStrokePatch(page, currentOriginals, currentReplacements.map((stroke) => stroke.id));
      },
      redo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        this.deleteStrokes(page, currentOriginals.map((stroke) => stroke.id));
        currentReplacements = replacements.map(restoredStroke);
        page.strokes.push(...currentReplacements.map(cloneStroke));
        page.strokes.sort((left, right) => left.createdAt - right.createdAt);
        this.markChanged(page);
        this.queueStrokePatch(page, currentReplacements, currentOriginals.map((stroke) => stroke.id));
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
        this.markChanged(page);
        this.queueWorkerOperation({
          type: "translate-strokes",
          pageId: page.id,
          strokeIds: movedStrokes.map((stroke) => stroke.id),
          dx: drag.dx,
          dy: drag.dy,
          pageUpdatedAt: page.updatedAt,
          notebookUpdatedAt: this.notebook.updatedAt
        });
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
    this.queueStrokePatch(page, page.strokes.filter((stroke) => pointsById.has(stroke.id)), []);
  }
  deleteStrokes(page, ids) {
    const deleted = new Set(ids);
    page.strokes = page.strokes.filter((stroke) => !deleted.has(stroke.id));
    page.deletedStrokeIds = [.../* @__PURE__ */ new Set([...page.deletedStrokeIds, ...ids])];
  }
  markChanged(page) {
    const now = Date.now();
    page.updatedAt = now;
    this.notebook.updatedAt = now;
    this.dirtyRevision += 1;
  }
  queueStrokePatch(page, upsert, remove) {
    var _a;
    if (page === this.currentPage()) (_a = this.tiles) == null ? void 0 : _a.patchStrokes(upsert, remove, page.strokes);
    this.queueWorkerOperation({
      type: "patch-strokes",
      pageId: page.id,
      upsert: upsert.map(cloneStroke),
      remove: [...remove],
      deletedStrokeIds: [...page.deletedStrokeIds],
      pageUpdatedAt: page.updatedAt,
      notebookUpdatedAt: this.notebook.updatedAt
    });
  }
  queueWorkerOperation(operation, transfer, onApplied) {
    const session = this.workerSession;
    if (!session) return;
    const revision = ++this.workerRevision;
    void session.apply(revision, operation, transfer).then((response) => {
      if (this.workerSession === session) onApplied == null ? void 0 : onApplied(response);
    }).catch((error) => {
      if (this.workerSession === session) this.disableWorkerSession(error);
    });
  }
  disableWorkerSession(error) {
    var _a, _b, _c, _d;
    (_b = (_a = this.tiles) == null ? void 0 : _a.setBackend) == null ? void 0 : _b.call(_a, null);
    if (this.viewReady && this.tiles && this.notebook.pages.length > 0) {
      this.tiles.sync(this.currentPage().strokes, this.tileExclusion());
      this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true);
    }
    (_c = this.workerSession) == null ? void 0 : _c.dispose();
    this.workerSession = null;
    if (this.workerFallbackReported || ((_d = this.workers) == null ? void 0 : _d.isDisabled())) return;
    this.workerFallbackReported = true;
    new import_obsidian.Notice(`Ink Notes background processing is unavailable; using reduced-performance mode: ${error instanceof Error ? error.message : String(error)}`);
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
    var _a;
    this.cancelPendingInkCommitTimer();
    this.committingInkStrokes = null;
    this.pendingInkStrokes = [];
    this.pendingInkPageId = null;
    (_a = this.tiles) == null ? void 0 : _a.cancelInkCommit();
    if (this.previewCanvas) this.previewCanvas.width = this.previewCanvas.height = 1;
    if (this.confirmedPreviewCanvas) this.confirmedPreviewCanvas.width = this.confirmedPreviewCanvas.height = 1;
    this.touchGesture = null;
    this.pendingMergedNotebook = null;
    this.pendingMergedNotebookIsFinal = false;
    this.externalRefreshPending = false;
    this.maxSaveDue = false;
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
    this.confirmedStrokeOutlines.clear();
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
function distance2(a2, b2) {
  return Math.hypot(a2.x - b2.x, a2.y - b2.y);
}
function isBrushTool(tool) {
  return tool === "pen" || tool === "highlighter";
}
function pointInsideRect(point, rect) {
  return point.clientX >= rect.left && point.clientX <= rect.right && point.clientY >= rect.top && point.clientY <= rect.bottom;
}
function stylusTouchSample(touch, timeStamp) {
  const altitude = touch.altitudeAngle;
  const azimuth = touch.azimuthAngle;
  let tiltX = 0;
  let tiltY = 0;
  if (typeof altitude === "number" && altitude >= 0 && altitude <= Math.PI / 2 && typeof azimuth === "number" && azimuth >= 0 && azimuth <= Math.PI * 2) {
    if (altitude === 0) {
      tiltX = azimuth === Math.PI / 2 || azimuth === Math.PI * 1.5 ? 0 : Math.sign(Math.cos(azimuth)) * 90;
      tiltY = azimuth === 0 || azimuth === Math.PI || azimuth === Math.PI * 2 ? 0 : Math.sign(Math.sin(azimuth)) * 90;
    } else {
      const slope = 1 / Math.tan(altitude);
      tiltX = Math.atan(Math.cos(azimuth) * slope) * 180 / Math.PI;
      tiltY = Math.atan(Math.sin(azimuth) * slope) * 180 / Math.PI;
    }
  }
  return {
    pointerId: touch.identifier,
    pointerType: "pen",
    clientX: touch.clientX,
    clientY: touch.clientY,
    pressure: touch.force,
    tiltX,
    tiltY,
    // Touch objects carry no per-sample timestamp; the owning TouchEvent's is
    // per-event, which is exactly the per-sample time for stylus input.
    timeStamp: typeof timeStamp === "number" && Number.isFinite(timeStamp) ? timeStamp : void 0
  };
}
function penSampleTimeMillis(sample) {
  return typeof sample.timeStamp === "number" && Number.isFinite(sample.timeStamp) ? sample.timeStamp : Date.now();
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
function packStrokePoints(points, start) {
  var _a, _b;
  const packed = new Float64Array((points.length - start) * 6);
  let offset = 0;
  for (let index = start; index < points.length; index++) {
    const point = points[index];
    packed[offset++] = point.x;
    packed[offset++] = point.y;
    packed[offset++] = point.pressure;
    packed[offset++] = (_a = point.tiltX) != null ? _a : Number.NaN;
    packed[offset++] = (_b = point.tiltY) != null ? _b : Number.NaN;
    packed[offset++] = point.t;
  }
  return packed;
}
function drawImmediateStrokeTail(ctx, stroke, width, height, confirmedSamples) {
  if (!Array.isArray(stroke.points)) {
    drawInkStroke(ctx, stroke, width, height);
    return;
  }
  if (stroke.points.length === 0 || confirmedSamples >= stroke.points.length) return;
  const start = Math.max(0, confirmedSamples - 1);
  drawInkStroke(ctx, { ...stroke, points: stroke.points.slice(start) }, width, height);
}
function boundedPreviewStroke(stroke) {
  if (!Array.isArray(stroke.points) || stroke.points.length <= COMPLETED_PREVIEW_SAMPLE_LIMIT) return stroke;
  const last = stroke.points.length - 1;
  const points = Array.from({ length: COMPLETED_PREVIEW_SAMPLE_LIMIT }, (_2, index) => stroke.points[Math.round(index * last / (COMPLETED_PREVIEW_SAMPLE_LIMIT - 1))]);
  return { ...stroke, points };
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
function reconcileNotebook(target, incoming, selectedPageId, previousPageIndex) {
  const dimensionsChanged = target.pageWidth !== incoming.pageWidth || target.pageHeight !== incoming.pageHeight;
  const previousPages = target.pages;
  const previousById = new Map(previousPages.map((page) => [page.id, page]));
  const pageChanges = /* @__PURE__ */ new Map();
  const pages = incoming.pages.map((incomingPage) => {
    const page = previousById.get(incomingPage.id);
    if (!page) {
      pageChanges.set(incomingPage.id, { ink: true, paper: true, rail: true });
      return incomingPage;
    }
    const paperChanged = page.paper !== incomingPage.paper;
    const railChanged = page.title !== incomingPage.title || paperChanged;
    const inkChanged = reconcilePage(page, incomingPage);
    pageChanges.set(page.id, { ink: inkChanged, paper: paperChanged, rail: railChanged });
    return page;
  });
  const pageListChanged = previousPages.length !== pages.length || previousPages.some((page, index) => {
    var _a;
    return page.id !== ((_a = pages[index]) == null ? void 0 : _a.id);
  });
  const selectedIndex = pages.findIndex((page) => page.id === selectedPageId);
  const pageIndex = selectedIndex >= 0 ? selectedIndex : Math.min(previousPageIndex, pages.length - 1);
  const currentPage = pages[pageIndex];
  const currentPageChanged = currentPage.id !== selectedPageId;
  const currentChanges = pageChanges.get(currentPage.id);
  target.schema = incoming.schema;
  target.title = incoming.title;
  target.pageWidth = incoming.pageWidth;
  target.pageHeight = incoming.pageHeight;
  target.pages = pageListChanged ? pages : previousPages;
  target.pageOrder = arraysEqual(target.pageOrder, incoming.pageOrder) ? target.pageOrder : [...incoming.pageOrder];
  target.deletedPages = recordsEqual(target.deletedPages, incoming.deletedPages) ? target.deletedPages : { ...incoming.deletedPages };
  target.pageOrderUpdatedAt = incoming.pageOrderUpdatedAt;
  target.updatedAt = incoming.updatedAt;
  return {
    pageIndex,
    pageRailChanged: pageListChanged || [...pageChanges.values()].some((change) => change.rail),
    currentPageChanged,
    currentInkChanged: currentPageChanged || (currentChanges == null ? void 0 : currentChanges.ink) === true,
    currentPaperChanged: !currentPageChanged && (currentChanges == null ? void 0 : currentChanges.paper) === true,
    dimensionsChanged
  };
}
function reconcilePage(target, incoming) {
  const previousStrokes = target.strokes;
  const previousById = new Map(previousStrokes.map((stroke) => [stroke.id, stroke]));
  const strokes = incoming.strokes.map((incomingStroke) => {
    const stroke = previousById.get(incomingStroke.id);
    if (!stroke || !strokeAppearanceEqual(stroke, incomingStroke)) return incomingStroke;
    stroke.updatedAt = incomingStroke.updatedAt;
    return stroke;
  });
  const inkChanged = previousStrokes.length !== strokes.length || previousStrokes.some((stroke, index) => stroke !== strokes[index]);
  target.title = incoming.title;
  target.paper = incoming.paper;
  if (inkChanged) target.strokes = strokes;
  target.deletedStrokeIds = arraysEqual(target.deletedStrokeIds, incoming.deletedStrokeIds) ? target.deletedStrokeIds : [...incoming.deletedStrokeIds];
  target.createdAt = incoming.createdAt;
  target.updatedAt = incoming.updatedAt;
  return inkChanged;
}
function strokeAppearanceEqual(left, right) {
  if (left.id !== right.id || left.pageId !== right.pageId || left.tool !== right.tool || left.color !== right.color || left.width !== right.width || left.opacity !== right.opacity || left.createdAt !== right.createdAt || left.points.length !== right.points.length) return false;
  for (let index = 0; index < left.points.length; index++) {
    const a2 = left.points[index];
    const b2 = right.points[index];
    if (a2.x !== b2.x || a2.y !== b2.y || a2.pressure !== b2.pressure || a2.t !== b2.t || a2.tiltX !== b2.tiltX || a2.tiltY !== b2.tiltY) return false;
  }
  return true;
}
function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function recordsEqual(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
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
function isPointerCaptureError(error) {
  if (Object.prototype.toString.call(error) !== "[object DOMException]") return false;
  const name = error.name;
  return name === "NotFoundError" || name === "InvalidStateError";
}
function formatControlValue(name, value) {
  const normalized = name.toLowerCase();
  if (normalized === "smooth") return value === 0 ? "Direct" : String(value);
  return normalized.endsWith("opacity") ? `${Math.round(value * 100)}%` : `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)} px`;
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
    const raw = await this.readRaw(file);
    return normalizeNotebook(JSON.parse(raw));
  }
  async readRaw(file) {
    return this.vault.read(file);
  }
  async writeIfUnchanged(file, expectedRaw, nextRaw) {
    let matched = false;
    try {
      await this.vault.process(file, (raw) => {
        if (raw !== expectedRaw) return raw;
        matched = true;
        this.selfWrites.set(file.path, nextRaw);
        return nextRaw;
      });
    } catch (error) {
      if (this.selfWrites.get(file.path) === nextRaw) this.selfWrites.delete(file.path);
      throw error;
    }
    return matched;
  }
  async save(file, notebook) {
    const next = { ...notebook, updatedAt: Date.now() };
    let merged = next;
    let expectedWrite = null;
    try {
      await this.vault.process(file, (raw) => {
        let latest;
        try {
          latest = normalizeNotebook(JSON.parse(raw));
        } catch (error) {
          throw new NotebookFormatError(`Cannot save ${file.path || "notebook"}: existing file is not valid JSON`);
        }
        merged = mergeNotebooks(latest, next);
        expectedWrite = serialize(merged);
        this.selfWrites.set(file.path, expectedWrite);
        return expectedWrite;
      });
    } catch (error) {
      if (expectedWrite !== null && this.selfWrites.get(file.path) === expectedWrite) this.selfWrites.delete(file.path);
      throw error;
    }
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
    this.unloaded = false;
  }
  onload() {
    this.unloaded = false;
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof import_obsidian3.TFile && file.path === this.spec.path) this.requestRender();
    }));
    this.requestRender();
  }
  onunload() {
    this.unloaded = true;
    this.renderRevision += 1;
  }
  requestRender() {
    const revision = ++this.renderRevision;
    void this.render(revision).catch((error) => this.renderError(revision, error));
  }
  async render(revision) {
    var _a;
    const el = this.containerEl;
    el.addClass("ink-embed");
    const file = this.app.vault.getAbstractFileByPath(this.spec.path);
    if (!(file instanceof import_obsidian3.TFile)) {
      this.renderError(revision, new Error(`Ink notebook not found: ${this.spec.path}`));
      return;
    }
    let notebook;
    try {
      notebook = normalizeNotebook(JSON.parse(await this.app.vault.cachedRead(file)));
    } catch (e2) {
      this.renderError(revision, new Error(`Ink notebook is damaged: ${this.spec.path}`));
      return;
    }
    if (!this.isCurrent(revision)) return;
    const page = this.spec.pageId ? notebook.pages.find((candidate) => candidate.id === this.spec.pageId) : notebook.pages[0];
    if (!page) {
      this.renderError(revision, new Error(`Ink page not found: ${(_a = this.spec.pageId) != null ? _a : "first page"}`));
      return;
    }
    const next = document.createElement("div");
    const frame = next.createDiv({ cls: `ink-embed-page ink-paper-${page.paper}` });
    frame.style.aspectRatio = `${notebook.pageWidth} / ${notebook.pageHeight}`;
    const canvas = frame.createEl("canvas", { attr: { "aria-label": `Ink preview: ${page.title}` } });
    drawPage(canvas, notebook, page);
    const button = next.createEl("button", { cls: "ink-embed-open", attr: { type: "button", "aria-label": "Open Ink notebook" } });
    (0, import_obsidian3.setIcon)(button, "external-link");
    button.createSpan({ text: "Open notebook" });
    button.addEventListener("click", () => {
      void this.open(file, page.id).catch((error) => new import_obsidian3.Notice(`Ink Notes could not open ${file.path}: ${error instanceof Error ? error.message : String(error)}`));
    });
    if (!this.isCurrent(revision)) return;
    el.replaceChildren(...Array.from(next.childNodes));
  }
  isCurrent(revision) {
    return !this.unloaded && revision === this.renderRevision;
  }
  renderError(revision, error) {
    if (this.isCurrent(revision)) renderError(this.containerEl, error);
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
    this.workers = new InkWorkerService((message) => new import_obsidian4.Notice(message));
    this.register(() => this.workers.dispose());
    this.registerView(VIEW_TYPE_INK, (leaf) => this.createView(leaf));
    this.registerExtensions([INK_EXTENSION], VIEW_TYPE_INK);
    this.addRibbonIcon("pen-line", "Open Ink Notes", () => this.runAsync(this.openNotebook(), "open a notebook"));
    this.addCommand({ id: "open-ink-notebook", name: "Open Ink Notebook", callback: () => this.runAsync(this.openNotebook(), "open a notebook") });
    this.addCommand({ id: "create-ink-notebook", name: "Create Ink Notebook", callback: () => this.runAsync(this.createNotebook(), "create a notebook") });
    this.registerMarkdownCodeBlockProcessor("ink", createInkEmbedProcessor(this.app, (file, pageId) => this.openFile(file, pageId)));
    this.register(this.store.observe((file) => this.queueRefresh(file)));
    this.register(() => {
      for (const timer of this.refreshTimers.values()) window.clearTimeout(timer);
      this.refreshTimers.clear();
    });
  }
  createView(leaf) {
    return new InkView(leaf, this.store, this.workers);
  }
  async openNotebook() {
    const files = await this.store.list();
    if (files.length === 0) {
      await this.createNotebook();
      return;
    }
    new NotebookSuggestModal(this.app, files, (file) => this.runAsync(this.openFile(file), `open ${file.path}`)).open();
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
  runAsync(action, operation) {
    void action.catch((error) => new import_obsidian4.Notice(`Ink Notes could not ${operation}: ${error instanceof Error ? error.message : String(error)}`));
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
