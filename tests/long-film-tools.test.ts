import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/mcp.js";
import type { McpEnv } from "../src/mcp-env.js";

// Long films built as parts (vivijure-cf docs/CONTRACT.md 2.22a): start_long_film -> POST /api/film,
// poll_long_film -> GET /api/film/:id, resume_long_film -> POST /api/film/:id/resume. All three are
// consumer routes on the studio, so a consumer gate token (a bare MCP_TOKEN_EXTRA entry) drives them.

const ENV: McpEnv = { STUDIO_URL: "https://studio.example.com", STUDIO_API_TOKEN: "studio-secret", MCP_TOKEN: "op", MCP_TOKEN_EXTRA: "crew-a" };
let calls: Array<{ url: string; method: string; body: unknown }> = [];
function stub() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true, film_id: "parent-1", phase: "planned" }), { status: 201, headers: { "content-type": "application/json" } });
  }));
}
afterEach(() => vi.unstubAllGlobals());

async function rpc(method: string, params?: Record<string, unknown>) {
  const res = await worker.fetch(new Request("https://studio-mcp.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer crew-a" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  }), ENV);
  return (await res.json()) as { result: { isError?: boolean; content?: Array<{ text: string }>; tools?: Array<{ name: string }> } };
}
const callTool = (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args });

// The body as the studio's table defines it, with shared carrying the dialogue and delivery fields.
const BODY = {
  project: "harbor",
  idempotency_key: "k-1",
  storyboard: { title: "Harbor", scenes: [{ id: "s1", prompt: "a wide shot", target_seconds: 4 }] },
  character_refs: {},
  dialogue_lines: [{ shot_id: "s1", text: "hello" }],
  part_size: 12,
  shared: {
    motion_backend: "own-gpu", style: "photoreal", delivery_width: 1920, delivery_height: 1080,
    dialogue_backend: "dialogue-gen", dialogue_config: { "dialogue-gen": { temperature: 0.4 } }, delivery_fps: 24,
  },
  part_overrides: [{ index: 1, motion_backend: "cf-seedance" }],
  spend_ceiling_usd: 40,
  cost_usd_per_shot_est: 0.5,
  pause_after_first_part: true,
  project_id: "proj-1",
};

describe("start_long_film", () => {
  it("a consumer token lists all three long-film tools", async () => {
    const names = (await rpc("tools/list")).result.tools!.map((t) => t.name);
    for (const n of ["start_long_film", "poll_long_film", "resume_long_film"]) expect(names).toContain(n);
  });

  it("posts the body to /api/film verbatim, shared fields included", async () => {
    stub();
    const out = await callTool("start_long_film", BODY);
    expect(out.result.isError).toBe(false);
    expect(calls).toEqual([{ url: "https://studio.example.com/api/film", method: "POST", body: BODY }]);
    expect((calls[0].body as typeof BODY).shared).toMatchObject({ dialogue_backend: "dialogue-gen", delivery_fps: 24 });
  });

  it("takes breaks instead of part_size, and the idempotencyKey alias", async () => {
    stub();
    const { part_size: _p, idempotency_key: _k, ...rest } = BODY;
    const out = await callTool("start_long_film", { ...rest, breaks: [8, 16], idempotencyKey: "k-2" });
    expect(out.result.isError).toBe(false);
    expect(calls[0].body).toMatchObject({ breaks: [8, 16], idempotencyKey: "k-2" });
  });

  it("refuses a call with no idempotency key, and sends nothing", async () => {
    stub();
    const { idempotency_key: _k, ...rest } = BODY;
    const out = await callTool("start_long_film", rest);
    expect(out.result.isError).toBe(true);
    expect(out.result.content![0].text).toContain("idempotency_key");
    expect(calls).toEqual([]);
  });

  it("refuses an undeclared argument, as submit_film does, and sends nothing", async () => {
    stub();
    const out = await callTool("start_long_film", { ...BODY, spend_ceiling: 40 });
    expect(out.result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("poll_long_film and resume_long_film", () => {
  it("poll reads GET /api/film/:id", async () => {
    stub();
    const out = await callTool("poll_long_film", { id: "parent-1" });
    expect(out.result.isError).toBe(false);
    expect(calls).toEqual([{ url: "https://studio.example.com/api/film/parent-1", method: "GET", body: undefined }]);
  });

  it("resume posts /api/film/:id/resume", async () => {
    stub();
    const out = await callTool("resume_long_film", { id: "parent-1" });
    expect(out.result.isError).toBe(false);
    expect(calls).toEqual([{ url: "https://studio.example.com/api/film/parent-1/resume", method: "POST", body: undefined }]);
  });

  it("an id of '..' is refused before any path is built", async () => {
    stub();
    for (const name of ["poll_long_film", "resume_long_film"]) {
      const out = await callTool(name, { id: ".." });
      expect(out.result.isError).toBe(true);
    }
    expect(calls).toEqual([]);
  });
});
