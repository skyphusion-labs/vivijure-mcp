import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { gateEntries, gateScope } from "../src/mcp.js";
import { SCOPE_DENY_TEXT, TOOLS, runTool } from "../src/mcp-tools.js";
import type { McpEnv } from "../src/mcp-env.js";

// Each MCP gate credential holds a scope, on the studio's own operator / consumer split
// (vivijure-cf#520). MCP_TOKEN is the operator's credential; an MCP_TOKEN_EXTRA entry is consumer
// unless written `operator:<token>`. A consumer credential lists and calls consumer tools only.

const ENV: McpEnv = {
  STUDIO_URL: "https://studio.example.com",
  STUDIO_API_TOKEN: "studio-secret",
  CONTROL_PLANE_URL: "https://cp.example.com",
  CONTROL_PLANE_ADMIN_TOKEN: "cp-secret",
  MCP_TOKEN: "operator-secret",
  MCP_TOKEN_EXTRA: "crew-a, operator:crew-op, consumer:crew-c",
};

function rpc(token: string, method: string, params?: Record<string, unknown>): Request {
  return new Request("https://studio-mcp.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
}
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await worker.fetch(rpc(token, "tools/call", { name, arguments: args }), ENV);
  return (await res.json()) as { result: { content: Array<{ text?: string }>; isError: boolean } };
}
async function listed(token: string): Promise<string[]> {
  const res = await worker.fetch(rpc(token, "tools/list"), ENV);
  return ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
}
function stubFetch() {
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return seen;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const OPERATOR_TOOLS = TOOLS.filter((t) => t.scope === "operator").map((t) => t.name).sort();
const CONSUMER_TOOLS = TOOLS.filter((t) => t.scope === "consumer").map((t) => t.name).sort();

describe("gate credentials carry a scope", () => {
  it("MCP_TOKEN is operator; an EXTRA entry is consumer unless prefixed operator:", () => {
    expect(gateEntries(ENV)).toEqual([
      { token: "operator-secret", scope: "operator" },
      { token: "crew-a", scope: "consumer" },
      { token: "crew-op", scope: "operator" },
      { token: "crew-c", scope: "consumer" },
    ]);
  });

  it("only the exact words operator / consumer are a prefix; an empty scoped token is dropped", () => {
    const env = { ...ENV, MCP_TOKEN: undefined, MCP_TOKEN_EXTRA: "admin:tok, op:tok2, operator:, operatorx:tok3" };
    expect(gateEntries(env)).toEqual([
      { token: "admin:tok", scope: "consumer" },
      { token: "op:tok2", scope: "consumer" },
      { token: "operatorx:tok3", scope: "consumer" },
    ]);
  });

  it("MCP_TOKEN is never prefix-parsed: a value starting with consumer: is still the operator's", () => {
    expect(gateEntries({ ...ENV, MCP_TOKEN: "consumer:abc", MCP_TOKEN_EXTRA: undefined }))
      .toEqual([{ token: "consumer:abc", scope: "operator" }]);
  });

  it("gateScope answers the matched scope, or null", async () => {
    expect(await gateScope("Bearer operator-secret", ENV)).toBe("operator");
    expect(await gateScope("Bearer crew-op", ENV)).toBe("operator");
    expect(await gateScope("Bearer crew-a", ENV)).toBe("consumer");
    expect(await gateScope("Bearer crew-c", ENV)).toBe("consumer");
    expect(await gateScope("Bearer nope", ENV)).toBeNull();
    // the scope prefix is not part of the token on the wire
    expect(await gateScope("Bearer operator:crew-op", ENV)).toBeNull();
  });
});

describe("a consumer credential lists and calls consumer tools only", () => {
  it("the split is the one this PR states: 47 operator, 69 consumer", () => {
    expect(OPERATOR_TOOLS.length).toBe(47);
    expect(CONSUMER_TOOLS.length).toBe(69);
    for (const n of ["studio_request", "control_plane_request", "storage_reconcile", "install_module", "patch_module_config"]) {
      expect(OPERATOR_TOOLS).toContain(n);
    }
    expect(OPERATOR_TOOLS.filter((n) => n.startsWith("cp_")).length).toBe(37);
  });

  it("tools/list: consumer sees the consumer set, operator sees all", async () => {
    expect((await listed("crew-a")).sort()).toEqual(CONSUMER_TOOLS);
    expect((await listed("crew-c")).sort()).toEqual(CONSUMER_TOOLS);
    expect((await listed("operator-secret")).length).toBe(TOOLS.length);
    expect((await listed("crew-op")).length).toBe(TOOLS.length);
  });

  for (const [name, args] of [
    ["cp_tenant_teardown", { id: "t1" }],
    ["control_plane_request", { method: "GET", path: "/api/admin/tenants" }],
    ["studio_request", { method: "GET", path: "/api/storyboard/projects" }],
    ["storage_reconcile", {}],
    ["patch_module_config", { name: "keyframe", config: {} }],
  ] as const) {
    it(`consumer calling ${name} is refused and nothing is sent`, async () => {
      const seen = stubFetch();
      const out = await call("crew-a", name, args as Record<string, unknown>);
      expect(out.result.isError).toBe(true);
      expect(out.result.content[0].text).toBe(SCOPE_DENY_TEXT);
      expect(seen).toEqual([]);
    });
  }

  it("consumer calling a consumer tool reaches the studio (witness)", async () => {
    const seen = stubFetch();
    const out = await call("crew-a", "list_projects");
    expect(out.result.isError).toBe(false);
    expect(seen).toEqual(["https://studio.example.com/api/storyboard/projects"]);
  });

  it("an operator credential reaches the control plane", async () => {
    const seen = stubFetch();
    const out = await call("crew-op", "cp_tenant_teardown", { id: "t1" });
    expect(out.result.isError).toBe(false);
    expect(seen).toEqual(["https://cp.example.com/api/admin/tenants/t1/teardown"]);
  });

  it("runTool refuses a control-plane call for a consumer scope, whatever built it", async () => {
    const seen = stubFetch();
    const out = await runTool(ENV, { method: "GET", path: "/api/admin/tenants", target: "control_plane" }, { scope: "consumer" });
    expect(out).toEqual({ content: [{ type: "text", text: SCOPE_DENY_TEXT }], isError: true });
    expect(seen).toEqual([]);
  });
});

// The scope each tool declares must agree with where it sends its request: a control-plane call is
// operator, and a studio call to one of the studio's operator routes (vivijure-cf src/studio.ts
// API_ROUTES, scope "operator") is operator. Built from synthesized arguments, so a new tool that
// gets this wrong is caught here and not by a reviewer.
const STUDIO_OPERATOR_ROUTES: Array<[string, RegExp]> = [
  ["GET", /^\/api\/storage\/usage$/],
  ["POST", /^\/api\/storage\/reconcile$/],
  ["GET", /^\/api\/tiers\/video-finish\/readiness$/],
  ["GET", /^\/api\/modules\/installed$/],
  ["POST", /^\/api\/modules\/install$/],
  ["DELETE", /^\/api\/modules\/install\/[^/]+$/],
  ["PATCH", /^\/api\/modules\/install\/[^/]+$/],
  ["GET", /^\/api\/modules\/[^/]+\/config$/],
  ["PATCH", /^\/api\/modules\/[^/]+\/config$/],
];
function synthArgs(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, { type?: unknown; enum?: unknown[] }>;
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) {
    if (Array.isArray(p.enum) && p.enum.length) { out[k] = p.enum[0]; continue; }
    const t = Array.isArray(p.type) ? p.type[0] : p.type;
    out[k] = t === "number" || t === "integer" ? 1 : t === "boolean" ? true : t === "array" ? [] : t === "object" ? {} : "x1";
  }
  return out;
}

describe("each tool's scope agrees with where it sends its request", () => {
  it("control-plane calls and studio operator routes are operator; every built tool is checked", () => {
    let built = 0;
    const wrong: string[] = [];
    for (const t of TOOLS) {
      let c;
      try { c = t.build(synthArgs(t.inputSchema)); } catch { continue; }
      built++;
      const path = c.path.split("?")[0];
      const needsOperator = c.target === "control_plane"
        || STUDIO_OPERATOR_ROUTES.some(([m, re]) => m === c.method && re.test(path));
      if (needsOperator && t.scope !== "operator") wrong.push(`${t.name} ${c.method} ${path}`);
    }
    expect(wrong).toEqual([]);
    // Not vacuous: most tools must build from synthesized arguments.
    expect(built).toBeGreaterThanOrEqual(90);
  });
});

describe("an id of '.' or '..' is refused before any path is built", () => {
  for (const id of ["..", "."]) {
    it(`cp_tenant_teardown {id: "${id}"} (operator) sends nothing`, async () => {
      const seen = stubFetch();
      const out = await call("operator-secret", "cp_tenant_teardown", { id });
      expect(out.result.isError).toBe(true);
      expect(out.result.content[0].text).toContain("is not an id");
      expect(seen).toEqual([]);
    });
    it(`get_project {id: "${id}"} (consumer) sends nothing`, async () => {
      const seen = stubFetch();
      const out = await call("crew-a", "get_project", { id });
      expect(out.result.isError).toBe(true);
      expect(seen).toEqual([]);
    });
  }

  it("an id that merely contains dots is still an id (witness)", async () => {
    const seen = stubFetch();
    await call("crew-a", "get_project", { id: "a..b" });
    expect(seen).toEqual(["https://studio.example.com/api/storyboard/projects/a..b"]);
  });

  it("an artifact key with a '.' or empty segment is refused", async () => {
    for (const key of ["renders/./film.mp4", "renders//film.mp4", "renders/../x"]) {
      const seen = stubFetch();
      const out = await call("crew-a", "artifact_url", { key });
      expect(out.result.isError).toBe(true);
      expect(seen).toEqual([]);
    }
  });
});

describe("the gate compares SHA-256 digests", () => {
  it("hashes the presented header and every candidate, whatever their lengths", async () => {
    const spy = vi.spyOn(crypto.subtle, "digest");
    expect(await gateScope("Bearer x", ENV)).toBeNull();
    // 4 credentials, 2 digests each (the presented header and the candidate).
    expect(spy).toHaveBeenCalledTimes(8);
    const lengths = new Set(spy.mock.calls.map((c) => (c[1] as Uint8Array).byteLength));
    expect(lengths.has("Bearer x".length)).toBe(true);
  });
});
