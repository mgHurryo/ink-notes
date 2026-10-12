import { expect, test, type CDPSession, type Locator, type Page } from "@playwright/test";

test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

async function ready(page: Page, mode: "ink" | "pdf") {
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  if (mode === "pdf") {
    await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
    await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view;
      v.desktopZoom(1 / v.zoom); v.finishDesktopZoom();
      v.inputScroller().scrollTop = 0;
    });
  }
  await page.evaluate(() => {
    const v = (window as any).__inkNotesPreview.view;
    const p = v.currentPage(), removed = p.strokes.map((s: any) => s.id);
    p.strokes = []; p.deletedStrokeIds.push(...removed);
    v.queueStrokePatch(p, [], removed); v.drawStrokes([]);
  });
  await page.getByRole("button", { name: "Add sticky note", exact: true }).click();
  return page.context().newCDPSession(page);
}

async function tap(session: CDPSession, target: Locator) {
  const r = (await target.boundingBox())!;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const state = (page: Page) => page.evaluate(() => {
  const v = (window as any).__inkNotesPreview.view;
  return { page: v.currentPage(), active: v.activePointerId, gesture: v.touchGesture, index: v.pageIndex ?? v.noteIndex };
});

async function screenshotInk(page: Page, png: Buffer) {
  return page.evaluate(async (data) => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let x = 0, y = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) {
      x += (i / 4) % canvas.width; y += Math.floor(i / 4 / canvas.width); count++;
    }
    return { x: x / count, y: y / count, count };
  }, png.toString("base64"));
}

for (const mode of ["ink", "pdf"] as const) test.describe(mode, () => {
test("native finger activates sticky controls and commits drafts without starting page gestures", async ({ page }) => {
  const session = await ready(page, mode), card = page.locator(".ink-sticky-note");
  await tap(session, card.getByRole("button", { name: "Fold", exact: true }));
  await expect(card).toHaveClass(/is-collapsed/);
  await tap(session, card.getByRole("button", { name: "Expand", exact: true }));
  await expect(card).not.toHaveClass(/is-collapsed/);
  await tap(session, card.getByRole("button", { name: "Type on sticky note", exact: true }));
  const input = card.getByRole("textbox", { name: "Sticky Markdown" });
  await expect(input).toBeFocused();
  await tap(session, input); await expect(input).toBeFocused();
  await input.fill("**A touch draft**");
  await tap(session, card.getByRole("button", { name: "Fold", exact: true }));
  await expect(card).toHaveClass(/is-collapsed/);
  expect((await state(page)).page.stickyNotes[0].text).toBe("**A touch draft**");
  await tap(session, card.getByRole("button", { name: "Expand", exact: true }));
  await expect(card.locator("strong")).toHaveText("A touch draft");
  await tap(session, card.getByRole("button", { name: "Sticky note options", exact: true }));
  await expect(page.getByRole("button", { name: "Copy link to sticky note", exact: true })).toBeVisible();
  await tap(session, page.getByRole("button", { name: "Blue", exact: true }));
  expect((await state(page)).page.stickyNotes[0].color).toBe("#cfe9ff");
  const final = await state(page);
  expect(final.active).toBeNull(); expect(final.gesture).toBeNull(); expect(final.page.strokes).toHaveLength(0);
  await session.detach();
});

test("Pencil pointer activates chrome without ink; native drag applies the current text draft", async ({ page }) => {
  const session = await ready(page, mode), card = page.locator(".ink-sticky-note");
  const b = (await card.getByRole("button", { name: "Type on sticky note", exact: true }).boundingBox())!;
  const point = { x: b.x + b.width / 2, y: b.y + b.height / 2, button: "left", pointerType: "pen", clickCount: 1 } as const;
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
  await card.getByRole("textbox", { name: "Sticky Markdown" }).fill("A draft before moving");
  const original = (await state(page)).page.stickyNotes[0];
  const r = (await card.getByRole("button", { name: "Move sticky note", exact: true }).boundingBox())!;
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 30, y: y + 20, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(card.getByRole("textbox", { name: "Sticky Markdown" })).toHaveCount(0);
  await expect(card.locator(".ink-sticky-markdown")).toHaveText("A draft before moving");
  await tap(session, card.getByRole("button", { name: "Fold", exact: true }));
  await expect(card).toHaveClass(/is-collapsed/);
  const final = await state(page);
  expect(final.page.stickyNotes[0].x).toBeGreaterThan(original.x);
  expect(final.active).toBeNull(); expect(final.page.strokes).toHaveLength(0); expect(final.page.stickyNotes[0].strokes).toHaveLength(0);
  await session.detach();
});

test("native finger grip and resize own their full stream without moving the page", async ({ page }) => {
  const session = await ready(page, mode), card = page.locator(".ink-sticky-note");
  for (const label of ["Move sticky note", "Resize note"]) {
    const before = await state(page), r = (await card.getByRole("button", { name: label, exact: true }).boundingBox())!;
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 40, y: y + 30, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const after = await state(page), original = before.page.stickyNotes[0], note = after.page.stickyNotes[0];
    expect(label === "Resize note" ? note.width : note.x).toBeGreaterThan(label === "Resize note" ? original.width : original.x);
    expect(after.gesture).toBeNull(); expect(after.active).toBeNull(); expect(after.index).toBe(before.index);
  }
  await session.detach();
});

test("dismissing text with a page swipe refreshes the board without requiring another click", async ({ page }) => {
  const session = await ready(page, mode), card = page.locator(".ink-sticky-note");
  await tap(session, card.getByRole("button", { name: "Type on sticky note", exact: true }));
  await card.getByRole("textbox", { name: "Sticky Markdown" }).fill("A draft before a page swipe");
  const r = (await card.getByLabel("Sticky handwriting board").boundingBox())!;
  const x = r.x + r.width + 50, y = r.y + 120;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 65, y, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(card.locator(".ink-sticky-markdown")).toHaveText("A draft before a page swipe");
  expect((await state(page)).page.strokes).toHaveLength(0);
  await session.detach();
});

for (const tool of ["Pen", "Highlight"]) for (const motion of ["vertical", "horizontal", "zoomed horizontal"]) test(`${tool}: ${motion} page motion keeps native Pencil ink fixed inside the board`, async ({ page }) => {
  const axis = motion === "vertical" ? "vertical" : "horizontal";
  const session = await ready(page, mode), board = page.getByLabel("Sticky handwriting board");
  await page.getByRole("button", { name: tool, exact: true }).click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const v = (window as any).__inkNotesPreview.view;
    v.brushPopover?.close();
    v.state.pen.color = "#202020"; v.state.highlighter.color = "#202020";
    v.state.highlighter.opacity = 1;
  });
  await expect(page.locator(".ink-size-popover")).toBeHidden();
  if (motion === "zoomed horizontal") await page.evaluate(() => {
    const v = (window as any).__inkNotesPreview.view, note = v.currentPage().stickyNotes[0];
    v.changeSticky(note, { ...note, x: .6, width: .25, height: .2 });
    v.desktopZoom(2 / v.zoom); v.finishDesktopZoom?.(); v.finishPinchRender?.();
    const scroller = v.inputScroller(); scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth; scroller.scrollTop = 0;
  });
  const r = (await board.boundingBox())!;
  await board.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const touch = (offset: number) => {
      const t = new Touch({ target: el, identifier: 11, clientX: r.x + 30 + offset, clientY: r.y + 50 + offset / 4, force: .5 });
      Object.defineProperty(t, "touchType", { value: "stylus" }); return t;
    };
    for (const [type, offset] of [["touchstart", 0], ["touchmove", 50], ["touchmove", 110], ["touchend", 110]] as const) {
      const t = touch(offset);
      el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [t], changedTouches: [t] }));
    }
  });
  // Exercise both browser Pencil paths, including Pointer-to-native-Touch
  // ownership transfer, with existing board ink already present.
  const pen = { button: "left", pointerType: "pen", clickCount: 1, force: .5 } as const;
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", ...pen, x: r.x + 30, y: r.y + 95 });
  for (const dx of [45, 90, 110]) await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved", ...pen, buttons: 1, x: r.x + 30 + dx, y: r.y + 95 + dx / 4,
  });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...pen, x: r.x + 140, y: r.y + 122.5 });
  await board.evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (const [type, offset] of [["down", 0], ["move", 60], ["move", 110], ["up", 110]] as const) {
      const point = { clientX: r.x + 30 + offset, clientY: r.y + 145 + offset / 4 };
      el.dispatchEvent(new PointerEvent(`pointer${type}`, { ...point, pointerId: 17, pointerType: "pen", button: 0,
        buttons: type === "up" ? 0 : 1, pressure: .5, bubbles: true, cancelable: true }));
      const t = new Touch({ ...point, target: el, identifier: 18, force: .5 });
      Object.defineProperty(t, "touchType", { value: "stylus" });
      el.dispatchEvent(new TouchEvent(`touch${type === "down" ? "start" : type === "up" ? "end" : "move"}`, {
        bubbles: true, cancelable: true, touches: type === "up" ? [] : [t], changedTouches: [t],
      }));
    }
  });
  const before = await state(page);
  expect(before.page.stickyNotes[0].strokes).toHaveLength(3);
  const ink = () => board.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let x = 0, y = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 0 && pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) {
      x += (i / 4) % canvas.width; y += Math.floor(i / 4 / canvas.width); count++;
    }
    return { x: x / count / canvas.width, y: y / count / canvas.height, count };
  });
  const baseline = await ink(); expect(baseline.count).toBeGreaterThan(0);
  const baselineImage = await screenshotInk(page, await board.screenshot());
  if (motion === "zoomed horizontal") await page.evaluate(() => {
    const scroller = (window as any).__inkNotesPreview.view.inputScroller();
    scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
  });
  const start = (await board.boundingBox())!;
  const x = start.x + 190, y = start.y + 110;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  for (const dy of [-25, -55, -85]) {
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: axis === "horizontal" ? x + dy : x, y: axis === "vertical" ? y + dy : y, id: 1 }] });
    if (axis === "horizontal") expect((await board.boundingBox())!.x - start.x).toBeCloseTo(dy, 0);
    const current = await ink(); expect(current.x).toBeCloseTo(baseline.x, 3); expect(current.y).toBeCloseTo(baseline.y, 3);
    const screenInk = await screenshotInk(page, await board.screenshot());
    // Fractional board bounds can shift screenshot rasterization by one
    // device pixel. Navigation must never displace ink within the board.
    expect(screenInk.count).toBeGreaterThan(0);
    expect(Math.abs(screenInk.x - baselineImage.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(screenInk.y - baselineImage.y)).toBeLessThanOrEqual(1);
    const previewPixels = await page.locator(".ink-preview-canvas, .ink-confirmed-preview-canvas, .ink-tile-layer canvas").evaluateAll((canvases: HTMLCanvasElement[]) =>
      canvases.reduce((sum, canvas) => {
        const copy = document.createElement("canvas"); copy.width = canvas.width; copy.height = canvas.height;
        const ctx = copy.getContext("2d")!; ctx.drawImage(canvas, 0, 0);
        return sum + ctx.getImageData(0, 0, copy.width, copy.height).data.filter((value, i) => i % 4 === 3 && value > 0).length;
      }, 0));
    expect(previewPixels).toBe(0);
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  if (axis === "vertical") expect((await board.boundingBox())!.y).toBeLessThan(start.y - 50);
  // Include settled viewport redraw and the delayed sidecar/worker save.
  await page.waitForTimeout(700);
  expect((await ink()).x).toBeCloseTo(baseline.x, 3); expect((await ink()).y).toBeCloseTo(baseline.y, 3);
  expect((await state(page)).page.stickyNotes[0]).toEqual(before.page.stickyNotes[0]);
  expect((await state(page)).page.strokes).toHaveLength(0);
  await session.detach();
});
});
