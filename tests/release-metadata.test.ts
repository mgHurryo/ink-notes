import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Release metadata must move together: every chore(release) bump edits
// package.json, package-lock.json, manifest.json, versions.json and
// CHANGELOG.md in one commit. These guards fail when a release commit
// forgets the changelog entry or the versions.json key, as happened for
// 0.1.5-beta.16..18.
const readRepoFile = (name: string): string => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), "utf8");

const manifest = JSON.parse(readRepoFile("manifest.json")) as { version: string };
const packageJson = JSON.parse(readRepoFile("package.json")) as { version: string };
const packageLock = JSON.parse(readRepoFile("package-lock.json")) as { version: string };
const versions = JSON.parse(readRepoFile("versions.json")) as Record<string, string>;
const changelog = readRepoFile("CHANGELOG.md");

describe("release metadata consistency", () => {
  it("keeps manifest.json, package.json and package-lock.json versions in sync", () => {
    expect(packageLock.version).toBe(packageJson.version);
    expect(manifest.version).toBe(packageJson.version);
  });

  it("has a CHANGELOG heading for the current version", () => {
    expect(changelog).toContain(`## ${manifest.version} - `);
  });

  it("maps the current version in versions.json", () => {
    expect(versions[manifest.version]).toEqual(expect.any(String));
  });
});
