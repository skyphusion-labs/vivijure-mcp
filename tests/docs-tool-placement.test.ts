import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TOOLS } from "../src/mcp-tools.js";

// docs/mcp.md placement -- the class tests/docs-tool-catalog.test.ts structurally cannot see.
//
// That guard asserts every tool NAME appears somewhere in the reference. It is blind to WHERE.
// Resolving the three-way merge conflict in #23, both sides had appended content after
// `set_cast_portrait`, and appending rather than interleaving would have filed TEN CAST TOOLS
// under a "Finishing a completed render" heading. Every automated check would still have passed:
// the names were all present, the count was right, every tool built a call. The doc would simply
// have told an agent's operator that `train_cast_lora` is a finishing step.
//
// WHY THIS IS COUNTS AND NOT A FULL MAPPING. The obvious assertion, that the document lists tools
// in TOOLS order, is FALSE and was measured to be false before this file was written: the doc
// groups by AUDIENCE ("Registry and reads" collects every free read, including `render_tags`) while
// the array groups by IMPLEMENTATION. Both orderings are correct for their purpose. A rule that
// forced them to agree would be wrong, and a full tool -> heading map would be a 42-entry
// hand-maintained copy that churns on every editorial change.
//
// Per-section COUNTS are the cheapest thing that still catches the defect: a block of tools moving
// between sections changes two counts and cannot be silent. The fixture is deliberately a snapshot.
// Its hand-maintained-ness is the POINT -- a snapshot that drifts FAILS, it does not quietly agree,
// so changing the shape of this document stays a conscious act rather than a side effect.

const DOC = readFileSync(`${process.cwd()}/docs/mcp.md`, "utf8");

/** Tool names per `###` section of the Tool reference, in document order. */
function sections(): { heading: string; tools: string[] }[] {
  const ref = DOC.slice(DOC.indexOf("## Tool reference"));
  const body = ref.slice(0, ref.indexOf("\n## ", 1));
  const out: { heading: string; tools: string[] }[] = [];
  const seen = new Set<string>();
  let cur: { heading: string; tools: string[] } | null = null;
  for (const line of body.split("\n")) {
    const h = line.match(/^### (.+)$/);
    if (h) {
      cur = { heading: h[1], tools: [] };
      out.push(cur);
      continue;
    }
    for (const m of line.matchAll(/\*\*`([a-z_]+)`\*\*/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      // A tool documented BEFORE the first heading is an orphan and is deliberately not
      // attributed to a section, so the total below will not add up and this fails loudly.
      if (cur) cur.tools.push(m[1]);
    }
  }
  return out;
}

// Snapshot. To change it, change the document first and then bring this into line DELIBERATELY.
const EXPECTED: [string, number][] = [
  ["Registry and reads (free, safe to call any time)", 9],
  ["Cast", 13],
  ["Projects and the render library (write)", 6],
  ["Finishing a completed render", 2],
  ["Planning (LLM calls; costs inference, not GPU render time)", 4],
  ["Render (SPENDS MONEY)", 3],
  ["Bytes in (bring your own image or audio)", 2],
  ["Artifacts (see what you made)", 2],
  ["Escape hatch", 1],
];

describe("docs/mcp.md tool placement", () => {
  it("the parser finds sections and tools at all", () => {
    // Positive-evidence floor: every assertion below is shaped so an empty parse would satisfy it
    // (zero sections trivially match zero mismatches). Success and no-op are the same exit status
    // almost everywhere, so the floor is asserted before anything is concluded from the result.
    const s = sections();
    expect(s.length, "no ### sections parsed out of the Tool reference").toBeGreaterThan(0);
    expect(s.reduce((n, x) => n + x.tools.length, 0), "no tools parsed").toBeGreaterThan(0);
  });

  it("every tool is documented UNDER a section, not above the first heading", () => {
    const placed = sections().flatMap((s) => s.tools);
    const missing = TOOLS.map((t) => t.name).filter((n) => !placed.includes(n));
    expect(missing, "tools not attributed to any ### section").toEqual([]);
    expect(placed.length).toBe(TOOLS.length);
  });

  it("no section is left with zero tools", () => {
    // The other half of a botched interleave: content moved OUT from under its heading leaves the
    // heading behind, and a reader sees a section that promises tools and lists none.
    const empty = sections().filter((s) => s.tools.length === 0).map((s) => s.heading);
    expect(empty, "section headings with no tools under them").toEqual([]);
  });

  it("section order and per-section tool counts match the snapshot", () => {
    const actual = sections().map((s) => [s.heading, s.tools.length] as [string, number]);
    // Compared as a whole so a REORDER fails as loudly as a miscount; comparing sets would let a
    // block of tools move between two sections of equal size and pass.
    expect(actual).toEqual(EXPECTED);
  });

  it("NEGATIVE CONTROL: the parser attributes a tool to the section it sits in, not the next one", () => {
    // Without this, a parser that attributed everything to the LAST heading would satisfy the
    // count assertion whenever the totals happened to line up.
    const s = sections();
    const cast = s.find((x) => x.heading === "Cast");
    expect(cast?.tools, "create_cast is not under Cast").toContain("create_cast");
    const hatch = s.find((x) => x.heading === "Escape hatch");
    expect(hatch?.tools, "studio_request leaked out of Escape hatch").toEqual(["studio_request"]);
  });
});
