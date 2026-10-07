import { fileURLToPath, URL } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/obsidian.mock.ts", import.meta.url)),
      "ink-worker-source": fileURLToPath(new URL("./tests/worker-source.mock.ts", import.meta.url)),
    },
  },
  test: {
    // tests/visual belongs to Playwright (playwright.config.ts): vitest must
    // skip those specs in every invocation, because its runner cannot execute
    // Playwright's test() and fails the whole suite. The npm test script also
    // passes --exclude, but a bare `vitest run` (CI, editors) reads only this.
    exclude: [...configDefaults.exclude, "tests/visual/**"],
  },
});
