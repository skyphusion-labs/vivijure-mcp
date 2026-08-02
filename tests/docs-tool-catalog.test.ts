import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TOOLS } from "../src/mcp-tools.js";

// docs/mcp.md is the agent-facing tool reference, and it carried TWO different hand-maintained tool
// counts that disagreed with each other -- "all 19 tools" in the contents list and "Twenty-one tools"
// in the reference heading, in one file, neither matching a code change. A count nobody re-derives is
// a claim that goes stale in the direction of whatever was true when it was typed.
//
// The counts are now DERIVED here rather than trusted. The doc keeps one number and this fails when
// the catalog moves without it.

const DOC = readFileSync(`${process.cwd()}/docs/mcp.md`, "utf8");
// Prose is hard-wrapped, so a phrase can straddle a newline; flatten before matching text.
const FLAT = DOC.replace(/\s+/g, " ");

describe("docs/mcp.md tracks the tool catalog", () => {
  it("the stated tool count is the real tool count", () => {
    const m = FLAT.match(/\*\*(\d+)\*\* tools in \*\*(\d+)\*\* groups/);
    // Positive control: a doc that stopped stating a count would otherwise make this vacuous.
    expect(m, "docs/mcp.md no longer states a tool count in the guarded form").not.toBeNull();
    expect(Number(m![1])).toBe(TOOLS.length);
  });

  it("the stated group count is the number of subsections under Tool reference", () => {
    const ref = DOC.slice(DOC.indexOf("## Tool reference"));
    const body = ref.slice(0, ref.indexOf("\n## ", 1));
    const groups = body.match(/^### /gm) ?? [];
    expect(groups.length, "no ### subsections parsed out of the Tool reference section").toBeGreaterThan(0);
    const m = FLAT.match(/\*\*(\d+)\*\* tools in \*\*(\d+)\*\* groups/);
    expect(Number(m![2])).toBe(groups.length);
  });

  it("every tool in the catalog is documented by name", () => {
    const missing = TOOLS.filter((t) => !FLAT.includes("`" + t.name + "`")).map((t) => t.name);
    expect(missing, "tools in the catalog with no mention in docs/mcp.md").toEqual([]);
  });

  it("NEGATIVE CONTROL: the name matcher does not match a tool that does not exist", () => {
    // Without this, the assertion above passes for a matcher that matches everything.
    expect(FLAT.includes("`joan_cf317_not_a_tool`")).toBe(false);
  });
});
