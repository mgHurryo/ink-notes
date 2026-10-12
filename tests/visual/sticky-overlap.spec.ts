import { expect, test, type Page } from "@playwright/test";

test.use({ hasTouch: true, deviceScaleFactor: 2 });

async function ready(page: Page, mode: "ink" | "pdf", width = 820) {
  await page.setViewportSize({ width, height: 1000 }); await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
  if (mode === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
  await page.evaluate(() => {
    const v = (window as any).__inkNotesPreview.view, p = v.currentPage();
    const removed = p.strokes.map((s: any) => s.id); p.strokes = []; p.deletedStrokeIds.push(...removed);
    v.queueStrokePatch(p, [], removed); v.drawStrokes([]); v.addSticky();
  });
}
const notes = (page: Page) => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes);
async function draw(page: Page, x: number, y: number, dx = 70) {
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + 8, { steps: 12 }); await page.mouse.up();
}
async function pixels(page: Page, png: Buffer, point?: { x: number; y: number }) {
  return page.evaluate(async ({ data, point }) => {
    const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
    const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
    if (point) return Array.from(ctx.getImageData(Math.round(point.x * devicePixelRatio), Math.round(point.y * devicePixelRatio), 1, 1).data);
    const dataPixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0; for (let i = 0; i < dataPixels.length; i += 4) if (Math.max(dataPixels[i], dataPixels[i + 1], dataPixels[i + 2]) < 100) dark++;
    return [dark];
  }, { data: png.toString("base64"), point });
}

for (const mode of ["ink", "pdf"] as const) {
  test(`${mode}: whole overlapping cards paint, receive input and export in stable order`, async ({ page }) => {
    await ready(page, mode);
    const ids = await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view;
      let n = v.currentPage().stickyNotes[0]; v.changeSticky(n, { ...n, x: .12, y: .18, width: .52, title: "Lecture", text: "**Important definition**" });
      v.addSticky(); n = v.currentPage().stickyNotes[1];
      v.changeSticky(n, { ...n, x: .30, y: .30, width: .52, title: "Review", text: "**Remember this**", color: "#ffd5df" });
      return v.currentPage().stickyNotes.map((n: any) => n.id);
    });
    const back = page.locator(`[data-sticky-id="${ids[0]}"]`), front = page.locator(`[data-sticky-id="${ids[1]}"]`);
    await expect(front.locator("strong")).toHaveText("Remember this");
    const header = (await front.locator(".ink-sticky-header").boundingBox())!;
    const point = { x: header.x + 150, y: header.y + 8 };
    const color = await pixels(page, await page.screenshot(), point);
    expect(color[0]).toBeGreaterThan(245); expect(color[1]).toBeLessThan(235); expect(color[2]).toBeGreaterThan(210);
    expect(await page.evaluate(({ point, id }) => document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>("[data-sticky-id]")?.dataset.stickyId === id, { point, id: ids[1] })).toBe(true);
    // Verify rendered text pixels, not just hidden Markdown in the DOM.
    expect((await pixels(page, await front.getByLabel("Sticky handwriting board").screenshot()))[0]).toBeGreaterThan(300);
    expect(await front.locator("canvas").evaluate((el: HTMLCanvasElement) => el.getContext("2d")!.getImageData(2, 2, 1, 1).data[3])).toBe(0);
    const b = (await back.getByLabel("Sticky handwriting board").boundingBox())!;
    await draw(page, b.x + 25, b.y + 18, 50);
    expect((await notes(page)).map((n: any) => n.id)).toEqual(ids);
    const f = (await front.getByLabel("Sticky handwriting board").boundingBox())!;
    await draw(page, f.x + 25, f.y + 70);
    let saved = await notes(page); expect(saved[0].strokes).toHaveLength(1); expect(saved[1].strokes).toHaveLength(1);
    await page.getByRole("button", { name: "Erase", exact: true }).click(); await page.keyboard.press("Escape");
    await expect(page.locator(".ink-size-popover")).toBeHidden();
    await draw(page, f.x + 40, f.y + 71, 20);
    saved = await notes(page); expect(saved[0].strokes).toHaveLength(1); expect(saved[1].strokes).toHaveLength(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect((await notes(page)).map((n: any) => n.id)).toEqual(ids);
    expect((await notes(page))[1].strokes).toHaveLength(1);
    if (mode === "ink") expect(await page.evaluate(() => (window as any).__inkNotesPreview.exportStickies())).toMatchObject({ images: 2 });
    await page.screenshot({ path: `test-results/sticky-overlap-${mode}.png` });
  });

  test(`${mode}: the title is a finger move handle and an explicit text edit target`, async ({ page }) => {
    await ready(page, mode);
    const card = page.locator(".ink-sticky-note"), title = card.locator(".ink-sticky-title");
    const before = (await notes(page))[0], r = (await title.boundingBox())!;
    const session = await page.context().newCDPSession(page);
    const x = r.x + 20, y = r.y + r.height / 2;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 45, y: y + 30, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const moved = (await notes(page))[0]; expect(moved.x).toBeGreaterThan(before.x); expect(moved.y).toBeGreaterThan(before.y);
    expect(moved.strokes).toEqual(before.strokes); expect(moved.scrollX).toBe(0); expect(moved.scrollY).toBe(0);
    // Two native taps rename; moving a card must not be treated as a tap.
    const t = (await title.boundingBox())!;
    for (let i = 0; i < 2; i++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t.x + 20, y: t.y + t.height / 2, id: 1 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    await expect(card.getByRole("textbox", { name: "Sticky title" })).toBeVisible();
    await card.getByRole("textbox", { name: "Sticky title" }).fill("My reminder");
    await card.getByRole("textbox", { name: "Sticky title" }).press("Enter");
    await expect(title).toHaveText("My reminder");
    await card.getByRole("button", { name: "Fold", exact: true }).tap();
    const folded = (await notes(page))[0], label = (await title.boundingBox())!;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: label.x + 10, y: label.y + 5, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: label.x + 45, y: label.y + 30, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect((await notes(page))[0].x).toBeGreaterThan(folded.x); await expect(card).toHaveClass(/is-collapsed/);
    await title.tap(); await expect(card).not.toHaveClass(/is-collapsed/); await session.detach();
  });
}

test("blank board double tap edits text, while finger-as-pen taps stay ink", async ({ page }) => {
  await ready(page, "ink");
  const card = page.locator(".ink-sticky-note"), board = card.getByLabel("Sticky handwriting board");
  const r = (await board.boundingBox())!, session = await page.context().newCDPSession(page);
  const tap = async () => {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x + 80, y: r.y + 90, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await tap(); await tap(); await expect(card.getByRole("textbox", { name: "Sticky Markdown" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => { (window as any).__inkNotesPreview.view.state.fingerAsPen = true; });
  await tap(); await tap(); await expect(card.getByRole("textbox", { name: "Sticky Markdown" })).toHaveCount(0);
  expect((await notes(page))[0].strokes.length).toBeGreaterThan(0); await session.detach();
});

test("narrow frames retain readable actions in the native menu; outside and repeated presses dismiss it", async ({ page }) => {
  await ready(page, "ink", 360);
  await page.evaluate(() => {
    const v = (window as any).__inkNotesPreview.view, n = v.currentPage().stickyNotes[0]; v.changeSticky(n, { ...n, width: .42 });
  });
  const card = page.locator(".ink-sticky-note"), options = card.getByRole("button", { name: "Sticky note options", exact: true });
  await expect(card.getByRole("button", { name: "Type on sticky note", exact: true })).toBeHidden();
  const cr = (await card.boundingBox())!, br = (await options.boundingBox())!;
  expect(br.width).toBeGreaterThanOrEqual(44); expect(br.x + br.width).toBeLessThanOrEqual(cr.x + cr.width);
  await options.tap(); await expect(page.locator(".menu")).toBeVisible();
  await options.tap(); await expect(page.locator(".menu")).toHaveCount(0);
  await options.tap(); await page.locator(".menu").getByRole("button", { name: "Type on sticky note", exact: true }).tap();
  await card.getByRole("textbox", { name: "Sticky Markdown" }).fill("**Small frame**");
  await card.getByRole("textbox", { name: "Sticky Markdown" }).press("Control+Enter");
  await options.tap(); await page.locator(".menu").getByRole("button", { name: "Fold", exact: true }).tap();
  await expect(card).toHaveClass(/is-collapsed/); await card.locator(".ink-sticky-title").tap();
  await expect(card).not.toHaveClass(/is-collapsed/); await expect(card.locator("strong")).toHaveText("Small frame");
  await options.tap(); await page.mouse.click(340, 500); await expect(page.locator(".menu")).toHaveCount(0);
});

test("repeated creation exposes distinct title positions and mobile UI uses the same controls", async ({ page }) => {
  await ready(page, "ink", 360);
  await page.getByRole("button", { name: "Add sticky note", exact: true }).click();
  const created = await notes(page); expect(created).toHaveLength(2);
  expect([created[0].x, created[0].y]).not.toEqual([created[1].x, created[1].y]);
  const front = page.locator(".ink-sticky-note").last();
  for (const name of ["Fold", "Type on sticky note", "Sticky note options"]) {
    const r = (await front.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(r.width).toBeGreaterThanOrEqual(44); expect(r.height).toBeGreaterThanOrEqual(43);
  }
  await page.screenshot({ path: "test-results/sticky-mobile-overlap.png" });
});
