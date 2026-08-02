import { describe, it, expect } from "vitest";
import { TOOLS_BY_NAME } from "../src/mcp-tools.js";

// cf#317 -- project + library write, and the two door-independent finishing routes.
//
// Before this, an agent could LIST and READ projects and renders and could not create, save,
// organize or delete one. `get_project`'s own description promised "incl. its last saved
// storyboard" while no tool could save one, so the read side advertised a write that did not exist.

const tool = (name: string) => {
  const t = TOOLS_BY_NAME.get(name);
  if (!t) throw new Error(`tool ${name} is not in the catalog`);
  return t;
};

const call = (name: string, args: Record<string, unknown>) => tool(name).build(args);

describe("cf#317 project + library write: method and path", () => {
  it.each([
    ["create_project", { name: "Nocturne" }, "POST", "/api/storyboard/projects"],
    ["save_storyboard", { id: "p1", storyboard: { scenes: [] } }, "POST", "/api/storyboard/projects/p1/storyboard"],
    ["update_project", { id: "p1", name: "New" }, "PATCH", "/api/storyboard/projects/p1"],
    ["delete_project", { id: "p1" }, "DELETE", "/api/storyboard/projects/p1"],
    ["render_tags", {}, "GET", "/api/storyboard/renders/tags"],
    ["update_render", { id: "r1", label: "keeper" }, "PATCH", "/api/storyboard/renders/r1"],
    ["delete_render", { id: "r1" }, "DELETE", "/api/storyboard/renders/r1"],
    ["add_render_audio", { id: "r1", audioKey: "audio/a.mp3" }, "POST", "/api/storyboard/renders/r1/add-audio"],
    ["add_render_narration", { id: "r1", text: "hello" }, "POST", "/api/storyboard/renders/r1/add-narration"],
  ])("%s -> %s %s", (name, args, method, path) => {
    const c = call(name, args as Record<string, unknown>);
    expect({ method: c.method, path: c.path }).toEqual({ method, path });
  });

  it("NEGATIVE CONTROL: the table above discriminates -- a wrong path is not accepted", () => {
    // Without this, an assertion helper that compared nothing would satisfy every row.
    expect(call("delete_project", { id: "p1" }).path).not.toBe("/api/storyboard/renders/p1");
  });
});

describe("cf#317 path ids are contained in their own segment", () => {
  it.each(["create_project", "save_storyboard", "update_project", "delete_project"])(
    "%s cannot be steered out of its path segment",
    (name) => {
      if (name === "create_project") {
        // No path param at all; asserted so the row is not silently skipped.
        expect(call(name, { name: "x" }).path).toBe("/api/storyboard/projects");
        return;
      }
      const c = call(name, { id: "../../admin", storyboard: {} });
      expect(c.path).toContain("%2F");
      expect(c.path).not.toContain("/../");
    },
  );
});

describe("cf#317 bodies: path params out, everything else forwarded", () => {
  it("the path id never appears in the request body", () => {
    const c = call("update_render", { id: "r1", label: "keeper", tags: ["a"] });
    expect(c.body).toEqual({ label: "keeper", tags: ["a"] });
  });

  it("an undocumented field is forwarded verbatim (forward-compatible with the contract)", () => {
    const c = call("create_project", { name: "N", some_future_field: 7 });
    expect(c.body).toEqual({ name: "N", some_future_field: 7 });
  });

  it("update_project forwards a storyboard verbatim, and the description names the either/or", () => {
    const sb = { scenes: [{ shot_id: "s1" }] };
    expect(call("update_project", { id: "p1", storyboard: sb }).body).toEqual({ storyboard: sb });
    // The studio applies EITHER storyboard OR name/prefs, never both in one call. An agent that does
    // not know that silently loses the rename, so the trap is stated where the agent reads.
    expect(tool("update_project").description).toMatch(/EITHER\/OR/);
  });
});

describe("cf#317 required arguments are refused with a message that names them", () => {
  it.each([
    ["create_project", {}, /name/],
    ["save_storyboard", { id: "p1" }, /storyboard/],
    ["save_storyboard", { storyboard: {} }, /id/],
    ["update_project", {}, /id/],
    ["delete_project", {}, /id/],
    ["update_render", {}, /id/],
    ["delete_render", {}, /id/],
    ["add_render_audio", { id: "r1" }, /audioKey/],
    ["add_render_narration", { id: "r1" }, /text/],
  ])("%s refuses %o", (name, args, re) => {
    expect(() => call(name, args as Record<string, unknown>)).toThrow(re);
  });

  it("POSITIVE CONTROL: each of those tools accepts its complete argument set", () => {
    // Without this the refusals above would pass identically if every build() simply always threw.
    expect(() => call("create_project", { name: "N" })).not.toThrow();
    expect(() => call("save_storyboard", { id: "p1", storyboard: {} })).not.toThrow();
    expect(() => call("add_render_audio", { id: "r1", audioKey: "audio/a.mp3" })).not.toThrow();
    expect(() => call("add_render_narration", { id: "r1", text: "t" })).not.toThrow();
  });
});

describe("cf#317 the render-door line is held, and stated where it can be checked", () => {
  it("no curated tool aims at a render submit / poll / cancel route", () => {
    // cf#334: three render doors disagree about whether a film has sound. Building curated tools on
    // either door before that is reconciled would bless the divergence, so the line is asserted here
    // rather than remembered. It is expected to be DELETED when cf#334 lands, deliberately.
    const blocked = [
      "/api/storyboard/render",
      "/api/storyboard/render/scatter",
      "/api/storyboard/render-from-keyframes",
      "/api/storyboard/renders/PLACEHOLDER/finalize",
      "/api/storyboard/renders/PLACEHOLDER/animate-cloud",
      "/api/storyboard/renders/PLACEHOLDER/animate-hybrid",
      "/api/storyboard/renders/PLACEHOLDER/regen-shot",
    ];
    const aimed: string[] = [];
    for (const [name, t] of TOOLS_BY_NAME) {
      if (name === "studio_request") continue;
      const args: Record<string, unknown> = {};
      const schema = t.inputSchema as { required?: string[]; properties?: Record<string, { type?: unknown }> };
      for (const k of schema.required ?? []) {
        const raw = schema.properties?.[k]?.type;
        const ty = Array.isArray(raw) ? raw[0] : raw;
        args[k] = ty === "object" ? {} : ty === "array" ? ["x"] : ty === "number" ? 1 : "PLACEHOLDER";
      }
      let path: string;
      try {
        path = t.build(args).path;
      } catch {
        continue;
      }
      if (blocked.includes(path)) aimed.push(`${name} -> ${path}`);
    }
    expect(aimed, "a curated tool now aims at a blocked render door").toEqual([]);
  });

  it("POSITIVE CONTROL: that scan really does read tool paths", () => {
    // The assertion above is `toEqual([])` shaped and would also pass if the loop iterated nothing.
    expect(TOOLS_BY_NAME.size).toBeGreaterThan(10);
    expect(call("delete_render", { id: "r1" }).path).toBe("/api/storyboard/renders/r1");
  });
});
