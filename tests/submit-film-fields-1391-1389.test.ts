import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/mcp.js";
import type { McpEnv } from "../src/mcp-env.js";

// submit_film declares and forwards the studio's newer POST /api/render/film fields:
//   dialogue_backend  string                       vivijure-cf#1391 (PR cf#1409)
//   dialogue_config   { [moduleName]: object }     vivijure-cf#1391 (PR cf#1409)
//   delivery_fps      whole number above 0         vivijure-cf#1389 (PR cf#1411)
// submit_film refuses an undeclared key (mcp#61), so before this each of these was refused outright.

const ENV: McpEnv = { STUDIO_URL: "https://studio.example.com", STUDIO_API_TOKEN: "studio-secret", MCP_TOKEN: "gate-secret" };
const BASE = { bundle_key: "bundles/x.tar", scenes: [{ shot_id: "s1", prompt: "a wide shot", seconds: 4 }], motion_backend: "own-gpu" };

let sent: Array<Record<string, unknown>> = [];
function stub() {
  sent = [];
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, film_id: "film-1", phase: "keyframe" }), { status: 201, headers: { "content-type": "application/json" } });
  }));
}
afterEach(() => vi.unstubAllGlobals());

async function submit(args: Record<string, unknown>) {
  const res = await worker.fetch(new Request("https://studio-mcp.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer gate-secret" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submit_film", arguments: args } }),
  }), ENV);
  return ((await res.json()) as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
}

describe("submit_film forwards the newer film fields", () => {
  const cases: Array<[string, unknown]> = [
    ["dialogue_backend", "dialogue-gen"],
    ["dialogue_config", { "dialogue-gen": { temperature: 0.4 } }],
    ["delivery_fps", 30],
  ];
  for (const [key, value] of cases) {
    it(`forwards ${key} verbatim, and only it`, async () => {
      stub();
      const out = await submit({ ...BASE, [key]: value });
      expect(out.isError).toBe(false);
      expect(sent).toHaveLength(1);
      expect(sent[0][key]).toEqual(value);
      for (const [other] of cases) if (other !== key) expect(other in sent[0]).toBe(false);
    });
  }

  it("forwards all three together", async () => {
    stub();
    const out = await submit({ ...BASE, dialogue_backend: "dialogue-gen", dialogue_config: { "dialogue-gen": {} }, delivery_fps: 24 });
    expect(out.isError).toBe(false);
    expect(sent[0]).toMatchObject({ dialogue_backend: "dialogue-gen", dialogue_config: { "dialogue-gen": {} }, delivery_fps: 24 });
  });

  it("still works without them, and sends none of them", async () => {
    stub();
    const out = await submit(BASE);
    expect(out.isError).toBe(false);
    expect(sent).toHaveLength(1);
    for (const k of ["dialogue_backend", "dialogue_config", "delivery_fps"]) expect(k in sent[0]).toBe(false);
  });

  it("an undeclared key is still refused (the mcp#61 gate is intact)", async () => {
    stub();
    const out = await submit({ ...BASE, dialog_backend: "dialogue-gen" });
    expect(out.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
