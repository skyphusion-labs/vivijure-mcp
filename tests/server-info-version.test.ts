// The wire-visible version must equal the published version.
//
// `serverInfo.version` in the MCP initialize reply is the ONLY version an MCP client can read off the
// wire. It was hardcoded 0.1.0 from vivijure-mcp-v1.0.0 through v1.0.1 while package.json said 1.0.0
// then 1.0.1, so an agent probing it to decide whether a tool exists got the same answer across a
// release that changed the tool set. This suite makes that drift impossible to reintroduce quietly:
// the next release that bumps package.json and forgets src/mcp.ts goes RED here.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

/** The literal in src/mcp.ts, read as SOURCE rather than imported: importing would pull the Worker
 *  entry and its env, and the thing under test is the literal a reader would edit. */
function serverInfoVersionFromSource(): string | null {
  const src = repoFile("src/mcp.ts");
  const m = src.match(/const SERVER_INFO = \{[^}]*version:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

describe("serverInfo.version tracks package.json", () => {
  it("finds the literal at all (control: the matcher can locate SERVER_INFO)", () => {
    // Without this, a renamed constant or reformatted object would make the matcher return null and
    // the real assertion below would compare null to null-ish and pass while checking nothing.
    expect(serverInfoVersionFromSource()).not.toBeNull();
  });

  it("matches the published package version", () => {
    const pkg = JSON.parse(repoFile("package.json")) as { version: string };
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(serverInfoVersionFromSource()).toBe(pkg.version);
  });

  it("control: the matcher DISCRIMINATES -- it rejects a constructed mismatch", () => {
    // Proves the assertion above can fail. A matcher that returns the same string for any input
    // would pass the real test regardless of what the source said.
    const offender = 'const SERVER_INFO = { name: "vivijure-studio", version: "0.1.0" };';
    const m = offender.match(/const SERVER_INFO = \{[^}]*version:\s*"([^"]+)"/);
    expect(m?.[1]).toBe("0.1.0");
    expect(m?.[1]).not.toBe(JSON.parse(repoFile("package.json")).version);
  });
});
