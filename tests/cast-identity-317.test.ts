import { describe, it, expect } from "vitest";
import { TOOLS_BY_NAME } from "../src/mcp-tools.js";

// cf#317 -- cast and identity, the ten routes an agent needed to set a character up and could not
// reach with a curated tool. Identity is step one of driving a film: portrait, reference set, LoRA.

const tool = (name: string) => {
  const t = TOOLS_BY_NAME.get(name);
  if (!t) throw new Error(`tool ${name} is not in the catalog`);
  return t;
};
const call = (name: string, args: Record<string, unknown>) => tool(name).build(args);

describe("cf#317 cast tools: method and path", () => {
  it.each([
    ["delete_cast", { id: "c1" }, "DELETE", "/api/cast/c1"],
    ["clear_cast_portrait", { id: "c1" }, "DELETE", "/api/cast/c1/portrait"],
    ["add_cast_ref", { id: "c1", from_chat_artifact: "uploads/a.png" }, "POST", "/api/cast/c1/ref"],
    ["add_cast_source", { id: "c1", from_chat_artifact: "uploads/a.png" }, "POST", "/api/cast/c1/source"],
    ["generate_cast_refs", { id: "c1" }, "POST", "/api/cast/c1/generate-refs"],
    ["poll_cast_refs", { id: "c1", job_id: "j1" }, "GET", "/api/cast/c1/refs-job/j1"],
    ["train_cast_lora", { id: "c1" }, "POST", "/api/cast/c1/train-lora"],
    ["cast_lora_status", { id: "c1" }, "GET", "/api/cast/c1/lora-status"],
  ])("%s -> %s %s", (name, args, method, path) => {
    const c = call(name, args as Record<string, unknown>);
    expect({ method: c.method, path: c.path }).toEqual({ method, path });
  });
});

describe("cf#317 the two wildcard key routes keep their slashes", () => {
  // These are `*refKey` / `*sourceKey` routes: the key spans slashes, so encodeURIComponent on the
  // whole thing would collapse the path into one segment and the route would never match. This is
  // the same class that once reported two working artifact tools as orphans in the parity test.
  it("remove_cast_ref keeps the key's path shape", () => {
    expect(call("remove_cast_ref", { id: "c1", ref_key: "cast/7/refs/a b.png" }).path).toBe(
      "/api/cast/c1/refs/cast/7/refs/a%20b.png",
    );
  });

  it("remove_cast_source keeps the key's path shape", () => {
    expect(call("remove_cast_source", { id: "c1", source_key: "cast/7/sources/x.png" }).path).toBe(
      "/api/cast/c1/source/cast/7/sources/x.png",
    );
  });

  it("the key SURVIVES the studio's own catch-all decode, which is the claim that matters", () => {
    // A literal path string is not the property under test; what matters is that the studio recovers
    // the key it was given. This mirrors the rule CONTRACT.md 2.0 states for a `*param` segment
    // (slice the remaining segments, decodeURIComponent EACH, rejoin with "/") -- a mirror, so it is
    // named as one rather than presented as the studio's code.
    const decodeCatchAll = (path: string, prefixSegments: number) =>
      path.split("/").slice(prefixSegments).map(decodeURIComponent).join("/");

    const key = "cast/7/refs/a b.png";
    const ours = call("remove_cast_ref", { id: "c1", ref_key: key }).path;
    // "" + "api" + "cast" + "c1" + "refs" = 5 leading segments before the catch-all.
    expect(decodeCatchAll(ours, 5)).toBe(key);

    // The panel encodes the WHOLE key as one segment. Different shape on the wire, same recovered
    // key -- so these tools are not quietly addressing a different object than the cast page does.
    const panelStyle = `/api/cast/c1/refs/${encodeURIComponent(key)}`;
    expect(decodeCatchAll(panelStyle, 5)).toBe(key);
  });

  it("NEGATIVE CONTROL: a traversal key is refused before any request is built", () => {
    expect(() => call("remove_cast_ref", { id: "c1", ref_key: "cast/../../etc" })).toThrow(/invalid artifact key/);
    expect(() => call("remove_cast_source", { id: "c1", source_key: "/absolute/x" })).toThrow(/invalid artifact key/);
    expect(() => call("remove_cast_ref", { id: "c1", ref_key: "https://evil/x" })).toThrow(/invalid artifact key/);
  });

  it("POSITIVE CONTROL: an ordinary key is NOT refused", () => {
    // Without this, the three refusals above would pass identically if keyPath rejected everything.
    expect(() => call("remove_cast_ref", { id: "c1", ref_key: "cast/7/refs/ok.png" })).not.toThrow();
  });
});

describe("cf#317 required arguments", () => {
  it.each([
    ["delete_cast", {}, /id/],
    ["clear_cast_portrait", {}, /id/],
    ["add_cast_ref", { id: "c1" }, /from_chat_artifact/],
    ["add_cast_source", { id: "c1" }, /from_chat_artifact/],
    ["remove_cast_ref", { id: "c1" }, /ref_key/],
    ["remove_cast_source", { id: "c1" }, /source_key/],
    ["generate_cast_refs", {}, /id/],
    ["poll_cast_refs", { id: "c1" }, /job_id/],
    ["train_cast_lora", {}, /id/],
    ["cast_lora_status", {}, /id/],
  ])("%s refuses %o", (name, args, re) => {
    expect(() => call(name, args as Record<string, unknown>)).toThrow(re);
  });

  it("POSITIVE CONTROL: the same tools accept a complete argument set", () => {
    expect(() => call("add_cast_ref", { id: "c1", from_chat_artifact: "uploads/a.png" })).not.toThrow();
    expect(() => call("poll_cast_refs", { id: "c1", job_id: "j" })).not.toThrow();
    expect(() => call("generate_cast_refs", { id: "c1", art_style: "anime" })).not.toThrow();
  });
});

describe("cf#317 bodies", () => {
  it("the path id is stripped from the body; everything else is forwarded", () => {
    expect(call("generate_cast_refs", { id: "c1", art_style: "anime", source_keys: ["k"] }).body).toEqual({
      art_style: "anime",
      source_keys: ["k"],
    });
  });

  it("a DELETE carries no body, which is why the key routes are path-shaped", () => {
    // The studio also accepts { key } in a JSON body on /ref and /source. runTool never sends a body
    // on DELETE, so that form is unreachable from here -- the path form is not a preference.
    expect(call("remove_cast_ref", { id: "c1", ref_key: "cast/7/refs/a.png" }).body).toBeUndefined();
  });
});

describe("cf#317 the spend routes say so where the agent reads", () => {
  it.each(["generate_cast_refs", "train_cast_lora"])("%s names the spend in its description", (name) => {
    expect(tool(name).description).toMatch(/SPENDS/);
  });

  it("NEGATIVE CONTROL: a free route does not claim to spend", () => {
    // Without this the assertion above passes for a matcher that matches every description.
    expect(tool("cast_lora_status").description).not.toMatch(/SPENDS/);
  });
});
