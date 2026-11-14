import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

// Model the host contract, not just the preview's browser-default slider:
// Obsidian paints the range track on the input and positions its own thumb.
const hostRanges = `
input[type="range"] { -webkit-appearance:none; appearance:none; background:#363636; height:3px; padding:0; }
input[type="range"]::-webkit-slider-runnable-track { height:6px; }
input[type="range"]::-webkit-slider-thumb { -webkit-appearance:none; position:relative; top:-7px; width:18px; height:18px; background:white; }
`;
const cases = [
  { name: "offset pane", width: 1500, height: 1000, style: "margin:80px 0 0 260px;width:1100px;height:850px;transform:translateZ(0)" },
  { name: "scaled pane", width: 1500, height: 1000, style: "margin:80px 0 0 260px;width:880px;height:680px;transform:scale(1.25);transform-origin:top left" },
  { name: "CSS zoom", width: 1500, height: 1000, style: "margin:64px 0 0 208px;width:880px;height:680px;zoom:1.25" },
  { name: "narrow light pane", width: 600, height: 720, style: "margin:50px 0 0 80px;width:420px;height:620px" },
  { name: "short pane", width: 1000, height: 750, style: "margin:440px 0 0 80px;width:840px;height:260px;transform:translateZ(0)" },
  { name: "toolbar below", width: 1500, height: 1000, style: "margin:80px 0 0 260px;width:1100px;height:850px" },
];
const tools = [
  ["Pen", "Tool settings"], ["Highlight", "Tool settings"],
  ["Erase", "Eraser settings"], ["Select", "Lasso settings"],
] as const;

for (const mode of ["ink", "pdf"] as const) {
  for (const layout of cases) {
    test(`${mode}: every tool menu stays anchored and styled in ${layout.name}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: layout.width, height: layout.height });
      await page.goto("/");
      await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
      if (mode === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
      await page.evaluate(({ css, layout }) => {
        const host = document.createElement("style");
        host.textContent = css;
        document.head.insertBefore(host, document.head.firstChild);
        const root = (window as any).__inkNotesPreview.view.toolbarRoot() as HTMLElement;
        root.style.cssText = layout.style;
        if (layout.name === "toolbar below") root.querySelector<HTMLElement>(".ink-toolbar, .ink-pdf-toolbar")!.style.order = "2";
        if (layout.name === "narrow light pane") {
          for (const [name, value] of Object.entries({
            "--background-primary": "#f5f6f8", "--background-secondary": "#ffffff",
            "--background-modifier-border": "#8a8f98", "--text-normal": "#1d232a", "--text-muted": "#4f5965",
          })) root.style.setProperty(name, value);
        }
      }, { css: hostRanges, layout });
      const root = page.locator(mode === "ink" ? ".ink-notes-view" : ".ink-pdf-view");

      for (const [label, dialog] of tools) {
        const button = page.getByRole("button", { name: label, exact: true });
        const panel = page.getByRole("dialog", { name: dialog, exact: true });
        if (await button.getAttribute("aria-pressed") !== "true") await button.click();
        await button.click();
        await expect(panel).toBeVisible();
        await page.waitForTimeout(180); // Complete the existing 150ms opening animation.
        const box = (await panel.boundingBox())!, anchor = (await button.boundingBox())!, pane = (await root.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(Math.max(0, pane.x) - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(Math.min(layout.width, pane.x + pane.width) + 1);
        expect(box.y).toBeGreaterThanOrEqual(Math.max(0, pane.y) - 1);
        expect(box.y + box.height).toBeLessThanOrEqual(Math.min(layout.height, pane.y + pane.height) + 1);
        const center = anchor.x + anchor.width / 2;
        expect(center).toBeGreaterThanOrEqual(box.x - 1);
        expect(center).toBeLessThanOrEqual(box.x + box.width + 1);
        const scale = await root.evaluate(el => el.getBoundingClientRect().height / (el as HTMLElement).offsetHeight);
        const gap = layout.name === "toolbar below" ? anchor.y - box.y - box.height : box.y - anchor.y - anchor.height;
        // offsetHeight rounds layout dimensions to whole CSS pixels.
        expect(Math.abs(gap - 10 * scale)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: resolve(`plan/status/UI-14/${testInfo.project.use.browserName ?? "chromium"}/${mode}-${layout.name}-${label}.png`) });

        const slider = panel.getByRole("slider").first();
        if (await slider.count()) {
          expect(await slider.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
          await slider.focus();
          await slider.press("End");
          expect(await slider.inputValue()).toBe(await slider.getAttribute("max"));
          // A tall panel must scroll its last setting into reach in a short pane.
          const last = panel.getByRole("slider").last();
          await last.scrollIntoViewIfNeeded();
          await last.focus();
          const lastBox = (await last.boundingBox())!;
          expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(box.y + box.height + 1);
        }
        if (label === "Pen" && layout.name === "offset pane") {
          const swatch = (await panel.locator('.ink-color-swatch').first().boundingBox())!;
          const plus = (await panel.locator('.ink-custom-color').first().boundingBox())!;
          expect(Math.abs(swatch.y + swatch.height / 2 - plus.y - plus.height / 2)).toBeLessThan(1);
        }
        if (layout.name === "offset pane") {
          await root.evaluate(el => { el.style.width = "900px"; });
          await expect.poll(async () => {
            const panelBox = (await panel.boundingBox())!, buttonBox = (await button.boundingBox())!;
            return Math.abs(panelBox.x + panelBox.width / 2 - buttonBox.x - buttonBox.width / 2);
          }).toBeLessThan(1);
        }
        await page.keyboard.press("Escape");
        await expect(panel).toBeHidden();
        await expect(root.locator(".is-closing")).toHaveCount(0);
        if (layout.name === "offset pane") await root.evaluate(el => { el.style.width = "1100px"; });
      }
    });
  }
}
