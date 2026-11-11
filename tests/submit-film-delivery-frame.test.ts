import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/mcp.js";
import type { McpEnv } from "../src/mcp-env.js";

// submit_film declares and forwards the studio's delivery frame fields (vivijure-cf src/studio.ts
// filmDeliveryFrame: both or neither, whole numbers above 0). submit_film refuses an undeclared key
// (mcp#61), so before this both were refused. The studio judges the pair; the tool passes it through.

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
  return ((await res.json()) as { result: { isError: boolean } }).result;
}

describe("submit_film forwards the delivery frame", () => {
  it("forwards delivery_width and delivery_height verbatim", async () => {
    stub();
    const out = await submit({ ...BASE, delivery_width: 1920, delivery_height: 1080 });
    expect(out.isError).toBe(false);
    expect(sent[0]).toMatchObject({ delivery_width: 1920, delivery_height: 1080 });
  });

  it("passes one alone through as given; the studio judges the pair", async () => {
    stub();
    const out = await submit({ ...BASE, delivery_width: 1280 });
    expect(out.isError).toBe(false);
    expect(sent[0].delivery_width).toBe(1280);
    expect("delivery_height" in sent[0]).toBe(false);
  });

  it("still works without them, and sends neither", async () => {
    stub();
    const out = await submit(BASE);
    expect(out.isError).toBe(false);
    expect("delivery_width" in sent[0] || "delivery_height" in sent[0]).toBe(false);
  });
});
