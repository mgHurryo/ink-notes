import { defineConfig } from "@playwright/test";

const previewPort = Number(process.env.PREVIEW_PORT || 4173);
const previewUrl = `http://127.0.0.1:${previewPort}`;

export default defineConfig({
  testDir: "tests/visual",
  use: { baseURL: previewUrl, channel: "chrome", screenshot: "only-on-failure" },
  webServer: { command: "npm run preview", url: `${previewUrl}/preview.js`, reuseExistingServer: true,
    env: { PORT: String(previewPort) } },
});
