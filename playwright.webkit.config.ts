import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: ["sticky-webkit.spec.ts", "sticky-layout.spec.ts", "sticky-text-boxes.spec.ts"],
  use: { ...base.use, channel: undefined, browserName: "webkit", hasTouch: true, deviceScaleFactor: 2 },
});
