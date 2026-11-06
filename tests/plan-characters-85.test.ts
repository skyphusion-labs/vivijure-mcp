import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOLS_BY_NAME } from "../src/mcp-tools.js";

// mcp#85: plan_storyboard described `characters` only as "Optional character definitions.", so an
// agent guessed a shape ({ name, description }) and the studio answered 500. The studio now refuses a
// bad entry with 400 (vivijure-cf#1137); the tool states the shape so the first call is right.

const tool = TOOLS_BY_NAME.get("plan_storyboard");
if (!tool) throw new Error("plan_storyboard is not in the catalog");
type ArraySchema = {
  type: string;
  description: string;
  items: { type: string; properties: Record<string, { type: string; enum?: string[] }>; required: string[] };
};
const props = (tool.inputSchema as { properties: Record<string, unknown>; required: string[] }).properties;
const characters = props.characters as ArraySchema;

describe("mcp#85 plan_storyboard states the characters entry shape", () => {
  it("each entry is an object requiring slot, name and bible, with slot limited to A-D", () => {
    expect(characters.type).toBe("array");
    expect(characters.items.type).toBe("object");
    expect(characters.items.required).toEqual(["slot", "name", "bible"]);
    expect(Object.keys(characters.items.properties).sort()).toEqual(["bible", "name", "slot"]);
    expect(characters.items.properties.slot.enum).toEqual(["A", "B", "C", "D"]);
  });

  it("the descriptions say it in words, for clients that do not read item schemas", () => {
    expect(characters.description).toContain("{ slot, name, bible }");
    expect(characters.description).toContain("slot is one of A, B, C, D and appears once");
    expect(tool.description).toContain("Each characters entry is { slot, name, bible }");
    expect(tool.description).not.toContain("Optional character definitions");
  });

  it("characters stays optional and is forwarded unchanged", () => {
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["brief", "model"]);
    const cast = [{ slot: "A", name: "Mara", bible: "" }];
    const call = tool.build({ brief: "b", model: "m", characters: cast });
    expect(call).toMatchObject({ method: "POST", path: "/api/storyboard/plan", body: { brief: "b", model: "m", characters: cast } });
  });

  it("docs/mcp.md carries the same shape", () => {
    const doc = readFileSync(join(__dirname, "..", "docs", "mcp.md"), "utf8").replace(/\s+/g, " ");
    expect(doc).toContain("Each entry is `{ slot, name, bible }`, all three required");
  });
});
