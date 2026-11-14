import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("mobile plugin bundle", () => {
  it("does not read Node environment globals while loading", () => {
    const bundle = readFileSync(new URL("../main.js", import.meta.url), "utf8");
    expect(bundle).not.toContain("process.env.NODE_ENV");
  });
});
