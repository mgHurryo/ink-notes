import { build } from "esbuild";
import { inkWorkerPlugin } from "./build-tools.mjs";

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  platform: "node",
  target: "es2018",
  outdir: ".",
  sourcemap: true,
  plugins: [await inkWorkerPlugin()],
});
