import { execFileSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

// Each run must serve its own freshly built preview on a port nothing else
// can hold. The old setup (fixed port 4173 + reuseExistingServer: true)
// silently attached to whatever already listened there — a stale server, a
// sibling checkout's preview — and the whole suite then failed against
// foreign code even with a green master. Pin PREVIEW_PORT to debug on a
// known port; a busy pin now fails the run loudly instead of silently
// testing a stranger's server.
function freePreviewPort(): number {
  const probe = "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>console.log(p));});";
  return Number(execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" }).trim());
}

const port = process.env.PREVIEW_PORT ? Number(process.env.PREVIEW_PORT) : freePreviewPort();
// tests/visual/responsive.spec.ts spawns its own browser contexts against
// this URL, so the allocation has to reach the test workers through the env.
process.env.PREVIEW_PORT = String(port);
const previewUrl = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/visual",
  use: { baseURL: previewUrl, channel: "chrome", screenshot: "only-on-failure" },
  webServer: { command: "npm run preview", url: `${previewUrl}/preview.js`, reuseExistingServer: false,
    env: { PORT: String(port) } },
});
