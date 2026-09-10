import { build } from "esbuild";

export async function inkWorkerPlugin() {
  const result = await build({
    entryPoints: ["src/ink-worker.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2018",
    write: false,
  });
  const source = result.outputFiles[0].text;
  return {
    name: "ink-worker-source",
    setup(builder) {
      builder.onResolve({ filter: /^ink-worker-source$/ }, () => ({ path: "ink-worker-source", namespace: "ink-worker" }));
      builder.onLoad({ filter: /.*/, namespace: "ink-worker" }, () => ({
        contents: `export default ${JSON.stringify(source)};`,
        loader: "js",
      }));
    },
  };
}
