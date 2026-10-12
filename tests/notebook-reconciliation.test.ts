import { describe, expect, it } from "vitest";
import { createNotebook, createPage } from "../src/model";
import type { InkStroke } from "../src/model";
import { reconcileNotebook } from "../src/notebook-reconciliation";

function fixture() {
  const book = createNotebook(), page = book.pages[0];
  const stroke: InkStroke = { id:"local", pageId:page.id, tool:"pen", color:"#000", width:4, opacity:1,
    points:[{x:.1,y:.1,pressure:.5,t:1}, {x:.2,y:.2,pressure:.5,t:2}],
    dynamics:{taper:0,pressure:100,speed:0}, createdAt:1, updatedAt:1 };
  page.strokes.push(stroke);
  return { book, page, stroke };
}

describe("shared notebook reconciliation", () => {
  it("retains page, stroke and point references for equivalent metadata and normalized defaults", () => {
    const { book, page, stroke } = fixture(), points = stroke.points, strokes = page.strokes;
    const remote = structuredClone(book);
    remote.updatedAt++; remote.pages[0].updatedAt++;
    remote.pages[0].strokes[0].updatedAt++; remote.pages[0].strokes[0].dynamics = undefined;
    const result = reconcileNotebook(book, remote, page.id, 0);
    expect(result.currentInkChanged).toBe(false); expect(result.changedPageIds).toEqual([]);
    expect(result.metadataOnlyChanges).toEqual([{stroke, previousUpdatedAt:1}]);
    expect(book.pages[0]).toBe(page); expect(page.strokes).toBe(strokes);
    expect(page.strokes[0]).toBe(stroke); expect(stroke.points).toBe(points); expect(stroke.updatedAt).toBe(2);
  });

  it.each(["points", "color", "opacity", "width", "taper", "pressure", "speed", "pressureCurve"])("detects a peer %s appearance change", field => {
    const { book, page, stroke } = fixture(), remote = structuredClone(book), next = remote.pages[0].strokes[0];
    if (field === "points") next.points[0].pressure = .9;
    if (field === "color") next.color = "#123456";
    if (field === "opacity") next.opacity = .5;
    if (field === "width") next.width = 8;
    if (field === "taper" || field === "pressure" || field === "speed") next.dynamics![field] = 50;
    if (field === "pressureCurve") next.dynamics!.pressureCurve = [[0,0], [.5,.9], [1,1]];
    const result = reconcileNotebook(book, remote, page.id, 0);
    expect(result.currentInkChanged).toBe(true); expect(result.changedPageIds).toEqual([page.id]);
    expect(book.pages[0]).toBe(page); expect(page.strokes[0]).not.toBe(stroke);
  });

  it("limits peer additions and tombstones to their own page and preserves selected-page identity after reorder", () => {
    const { book, page, stroke } = fixture(), other = createPage("Other");
    book.pages.push(other); book.pageOrder.push(other.id);
    let remote = structuredClone(book);
    remote.pages[1].strokes.push({...structuredClone(stroke), id:"remote", pageId:other.id});
    let result = reconcileNotebook(book, remote, page.id, 0);
    expect(result.currentInkChanged).toBe(false); expect(result.changedPageIds).toEqual([other.id]);
    remote = structuredClone(book); remote.pages.reverse(); remote.pageOrder.reverse();
    result = reconcileNotebook(book, remote, page.id, 0);
    expect(result.pageIndex).toBe(1); expect(result.currentPageChanged).toBe(false); expect(book.pages[1]).toBe(page);
    remote = structuredClone(book); remote.pages[1].strokes = []; remote.pages[1].deletedStrokeIds.push(stroke.id);
    result = reconcileNotebook(book, remote, page.id, 1);
    expect(result.currentInkChanged).toBe(true); expect(page.strokes).toHaveLength(0);
    expect(page.deletedStrokeIds).toContain(stroke.id);
  });
});
