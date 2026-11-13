import { defineConfig } from "@playwright/test";
import webkit from "./playwright.webkit.config";

export default defineConfig({
  ...webkit,
  testMatch: ["page-tags.spec.ts"],
});
