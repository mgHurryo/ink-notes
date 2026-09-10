import { context } from "esbuild";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inkWorkerPlugin } from "../build-tools.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const build = await context({
  absWorkingDir: root, entryPoints: ["dev/preview.ts"], bundle: true,
  platform: "browser", format: "iife", outfile: "dist/preview.js",
  alias: { obsidian: "./dev/obsidian.ts" },
  plugins: [await inkWorkerPlugin()],
});
await build.watch();
const routes = { "/": ["dev/index.html", "text/html"], "/styles.css": ["styles.css", "text/css"], "/preview.js": ["dist/preview.js", "text/javascript"] };
const server = createServer(async (req, res) => {
  const route = routes[req.url];
  if (!route) { res.writeHead(404).end(); return; }
  try { res.setHeader("Content-Type", route[1]); res.setHeader("Cache-Control", "no-store"); res.end(await readFile(new URL("../" + route[0], import.meta.url))); }
  catch { res.writeHead(503).end("Preview is building."); }
});
server.listen(Number(process.env.PORT || 4173), "127.0.0.1", () => console.log("Ink Notes preview: http://127.0.0.1:" + server.address().port));
