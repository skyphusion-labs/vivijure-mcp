import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { STRICT_ARGUMENT_TOOLS } from "../src/mcp.js";
import type { McpEnv } from "../src/mcp-env.js";

// The remaining long-film routes (vivijure-cf docs/CONTRACT.md 2.22a), all consumer routes on the
// studio, driven through the worker with a consumer gate token. Retry, retake and the ceiling raise
// spend, so they refuse an undeclared argument. Delete cannot be undone, so it needs confirm: true.

const ENV: McpEnv = { STUDIO_URL: "https://studio.example.com", STUDIO_API_TOKEN: "studio-secret", MCP_TOKEN: "op", MCP_TOKEN_EXTRA: "crew-a" };
const S = "https://studio.example.com";
let calls: Array<{ url: string; method: string; body: unknown }> = [];
function stub() {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: String(init?.method), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }));
}
afterEach(() => vi.unstubAllGlobals());
async function callTool(name: string, args: Record<string, unknown>) {
  const res = await worker.fetch(new Request("https://studio-mcp.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer crew-a" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), ENV);
  return ((await res.json()) as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
}

describe("each tool calls its studio route", () => {
  const cases: Array<[string, Record<string, unknown>, { url: string; method: string; body: unknown }]> = [
    ["list_long_films", {}, { url: `${S}/api/film`, method: "GET", body: undefined }],
    ["get_long_film_part_shots", { id: "p1", part: 2 }, { url: `${S}/api/film/p1/parts/2/shots`, method: "GET", body: undefined }],
    ["retry_long_film_part", { id: "p1", part: 0 }, { url: `${S}/api/film/p1/parts/0/retry`, method: "POST", body: { shots: "failed" } }],
    ["retake_long_film_shot",
      { id: "p1", shot: "s7", prompt: "closer", line: "hi", voice_id: "v1", new_still: true, seed: 42, rebuy_previous: true },
      { url: `${S}/api/film/p1/shots/s7/retake`, method: "POST", body: { prompt: "closer", line: "hi", voice_id: "v1", new_still: true, seed: 42, rebuy_previous: true } }],
    ["cancel_long_film_retake", { id: "p1", part: 1 }, { url: `${S}/api/film/p1/parts/1/retake/cancel`, method: "POST", body: undefined }],
    ["raise_long_film_ceiling", { id: "p1", spend_ceiling_usd: 80 }, { url: `${S}/api/film/p1/ceiling`, method: "POST", body: { spend_ceiling_usd: 80 } }],
    ["delete_long_film", { id: "p1", confirm: true }, { url: `${S}/api/film/p1`, method: "DELETE", body: undefined }],
  ];
  for (const [name, args, want] of cases) {
    it(name, async () => {
      stub();
      const out = await callTool(name, args);
      expect(out.isError).toBe(false);
      expect(calls).toEqual([want]);
    });
  }

  it("a retake with only the shot sends an empty edit set", async () => {
    stub();
    await callTool("retake_long_film_shot", { id: "p1", shot: "s7" });
    expect(calls[0].body).toEqual({});
  });
});

describe("the spending tools refuse an undeclared argument", () => {
  it("the strict set is the five tools that spend", () => {
    expect([...STRICT_ARGUMENT_TOOLS].sort()).toEqual(
      ["raise_long_film_ceiling", "retake_long_film_shot", "retry_long_film_part", "start_long_film", "submit_film"],
    );
  });
  for (const [name, args] of [
    ["retry_long_film_part", { id: "p1", part: 0, shots: "all" }],
    ["retake_long_film_shot", { id: "p1", shot: "s7", new_stil: true }],
    ["raise_long_film_ceiling", { id: "p1", spend_ceiling_usd: 80, ceiling: 90 }],
  ] as const) {
    it(`${name} refuses an undeclared key and sends nothing`, async () => {
      stub();
      const out = await callTool(name, args as Record<string, unknown>);
      expect(out.isError).toBe(true);
      expect(calls).toEqual([]);
    });
  }
});

describe("delete_long_film needs confirm: true", () => {
  for (const confirm of [undefined, false, "true", 1]) {
    it(`confirm ${JSON.stringify(confirm)} is refused and nothing is sent`, async () => {
      stub();
      const out = await callTool("delete_long_film", { id: "p1", ...(confirm === undefined ? {} : { confirm }) });
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toContain("confirm: true");
      expect(calls).toEqual([]);
    });
  }
});

describe("ids and part indexes are checked before a path is built", () => {
  it("refuses '..' ids, a '..' shot, and a part that is not a whole number from 0", async () => {
    stub();
    const bad: Array<[string, Record<string, unknown>]> = [
      ["get_long_film_part_shots", { id: "..", part: 0 }],
      ["retake_long_film_shot", { id: "p1", shot: ".." }],
      ["get_long_film_part_shots", { id: "p1", part: -1 }],
      ["cancel_long_film_retake", { id: "p1", part: 1.5 }],
      ["retry_long_film_part", { id: "p1", part: "0" }],
    ];
    for (const [name, args] of bad) expect((await callTool(name, args)).isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("submit_film forwards reuse_finished (vivijure-cf#1166)", () => {
  it("forwards it as given, and sends none when it is not passed", async () => {
    stub();
    const base = { bundle_key: "bundles/x.tar", scenes: [{ shot_id: "s1", prompt: "a", seconds: 4 }], motion_backend: "own-gpu" };
    expect((await callTool("submit_film", { ...base, reuse_finished: true })).isError).toBe(false);
    expect((calls[0].body as Record<string, unknown>).reuse_finished).toBe(true);
    await callTool("submit_film", base);
    expect("reuse_finished" in (calls[1].body as Record<string, unknown>)).toBe(false);
  });
});
