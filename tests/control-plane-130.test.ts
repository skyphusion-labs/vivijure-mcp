import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TOOLS_BY_NAME, runTool, type StudioCall } from "../src/mcp-tools.js";

function call(name: string, args: Record<string, unknown> = {}): StudioCall {
  const tool = TOOLS_BY_NAME.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.build(args);
}

describe("control plane tools (1.3)", () => {
  it("cp_* tools target control_plane paths under /api/admin or /api/platform", () => {
    const samples: [string, Record<string, unknown>, string, string][] = [
      ["cp_whoami", {}, "GET", "/api/admin/whoami"],
      ["cp_list_tenants", {}, "GET", "/api/admin/tenants"],
      ["cp_tenant_upgrade_studio", { id: "ten_abc" }, "POST", "/api/admin/tenants/ten_abc/upgrade-studio"],
      ["cp_tenant_smoke_render", { id: "ten_abc" }, "POST", "/api/admin/tenants/ten_abc/smoke-render"],
      ["cp_platform_version", {}, "GET", "/api/platform/version"],
      ["control_plane_request", { method: "GET", path: "/api/admin/settings" }, "GET", "/api/admin/settings"],
    ];
    for (const [name, args, method, path] of samples) {
      const c = call(name, args);
      expect(c.target, name).toBe("control_plane");
      expect(c.method, name).toBe(method);
      expect(c.path, name).toBe(path);
    }
  });

  it("studio tools default to studio target", () => {
    const c = call("studio_modules");
    expect(c.target ?? "studio").toBe("studio");
    expect(c.path).toBe("/api/modules");
  });

  it("runTool fails closed when control plane token is unset", async () => {
    const result = await runTool(
      { MCP_TOKEN: "x", CONTROL_PLANE_URL: "https://cp.example.com" },
      { method: "GET", path: "/api/admin/whoami", target: "control_plane" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toMatch(/CONTROL_PLANE_ADMIN_TOKEN/);
    }
  });

  it("runTool sends CONTROL_PLANE_ADMIN_TOKEN to the plane host", async () => {
    const fetches: { url: string; auth: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches.push({
        url: String(input),
        auth: (init?.headers as Record<string, string>)?.Authorization ?? null,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const result = await runTool(
        {
          CONTROL_PLANE_URL: "https://cp.example.com/",
          CONTROL_PLANE_ADMIN_TOKEN: "opc_secret",
          STUDIO_URL: "https://studio.example.com",
          STUDIO_API_TOKEN: "studio_secret",
        },
        { method: "GET", path: "/api/admin/whoami", target: "control_plane" },
      );
      expect(result.isError).toBe(false);
      expect(fetches).toHaveLength(1);
      expect(fetches[0].url).toBe("https://cp.example.com/api/admin/whoami");
      expect(fetches[0].auth).toBe("Bearer opc_secret");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("studio 1.3 gap tools", () => {
  it("maps high-value panel routes", () => {
    expect(call("whoami").path).toBe("/api/whoami");
    expect(call("train_cast_wan_lora", { id: "c1" }).path).toBe(
      "/api/cast/c1/train-wan-lora",
    );
    expect(call("submit_clips", { bundle_key: "b", scenes: [{ shot_id: "1" }] }).path).toBe(
      "/api/render/clips",
    );
    expect(call("install_module", { script_name: "mod-a" }).body).toEqual({
      script_name: "mod-a",
    });
  });
});
