// mcp#70: a tag without the vivijure-mcp-v prefix publishes nothing, and a
// missing workflow run looks the same as a green one. The checker fails that
// tag, and the workflow that runs it must trigger on a tag the publish
// workflow ignores. Narrowing this file back to vivijure-mcp-v* goes red.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { releaseTagFailure } from "../scripts/release-tag.mjs";

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

function pushTagPatterns(yml: string): string[] {
  const block = yml.match(/^on:\n(?:[ \t].*\n)*? {2}push:\n(?:[ \t].*\n)*? {4}tags:\n((?: {6}- .*\n)+)/m);
  if (!block) return [];
  return [...block[1].matchAll(/- ["']([^"']+)["']/g)].map((m) => m[1]);
}

/** GitHub tag filter: `*` does not match `/`. Enough for the patterns this repo uses. */
function githubTagGlob(pattern: string, tag: string): boolean {
  if (pattern === "**") return true;
  const body = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${body.join("[^/]*")}$`).test(tag);
}

function seenBy(yml: string, tag: string): boolean {
  return pushTagPatterns(yml).some((pattern) => githubTagGlob(pattern, tag));
}

describe("release tag prefix", () => {
  it("accepts the publish prefix", () => {
    expect(releaseTagFailure("vivijure-mcp-v2.1.0")).toBeNull();
  });

  it("fails a bare v tag and says nothing was published", () => {
    const err = releaseTagFailure("v1.4.1");
    expect(err).toContain("vivijure-mcp-v");
    expect(err).toContain("publishes nothing");
    expect(releaseTagFailure("vivijure-mcp-2.1.0")).toContain("publishes nothing");
    expect(releaseTagFailure("")).toContain("publishes nothing");
  });

  it("release-tag.yml sees a bare v tag that publish-npm.yml ignores", () => {
    const release = repoFile(".github/workflows/release-tag.yml");
    const publish = repoFile(".github/workflows/publish-npm.yml");
    expect(pushTagPatterns(release).length).toBeGreaterThan(0);
    expect(pushTagPatterns(publish).length).toBeGreaterThan(0);
    expect(seenBy(release, "v1.4.1")).toBe(true);
    expect(seenBy(publish, "v1.4.1")).toBe(false);
    expect(seenBy(publish, "vivijure-mcp-v2.1.0")).toBe(true);
    expect(release).toContain("node scripts/release-tag.mjs");
  });
});
