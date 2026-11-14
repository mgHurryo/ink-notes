import { build } from "esbuild";
import { inkWorkerPlugin } from "./build-tools.mjs";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  // wheel-gestures reads this at module initialization. Inline the release
  // value so Obsidian Mobile does not need a Node `process` global.
  define: { "process.env.NODE_ENV": '"production"' },
  format: "cjs",
  platform: "node",
  target: "es2018",
  outdir: ".",
  sourcemap: true,
  plugins: [await inkWorkerPlugin()],
});
