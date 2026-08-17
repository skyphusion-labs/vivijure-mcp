import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOLS_BY_NAME, runTool, studioUrl, STUDIO_REQUEST_MAX_PATH_LEN } from "../src/mcp-tools.js";
import type { McpEnv } from "../src/mcp-env.js";

// studio_request is the only tool whose path is caller-controlled. A leading slash was not a
// bound: `//`, `/../`, encoded dots, and `http:` all start with `/` and can leave the studio
// origin or rewrite the path. This suite is the refusal path, not a description of it.

const ENV: McpEnv = {
  STUDIO_URL: "https://studio.example.com",
  STUDIO_API_TOKEN: "studio-secret",
  MCP_TOKEN: "gate-secret",
  CONTROL_PLANE_URL: "https://cp.example.com",
  CONTROL_PLANE_ADMIN_TOKEN: "opc-secret",
};

const studioRequest = TOOLS_BY_NAME.get("studio_request");
const controlPlaneRequest = TOOLS_BY_NAME.get("control_plane_request");
if (!studioRequest) throw new Error("studio_request missing from catalog");
if (!controlPlaneRequest) throw new Error("control_plane_request missing from catalog");

function buildStudio(path: string, extra: Record<string, unknown> = {}) {
  return studioRequest.build({ method: "GET", path, ...extra });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe("studio_request path allowlist", () => {
  it("accepts a CONTRACT /api/ path and keeps target=studio", () => {
    const call = buildStudio("/api/storyboard/renders");
    expect(call.path).toBe("/api/storyboard/renders");
    expect(call.target).toBe("studio");
    expect(call.method).toBe("GET");
  });

  it("allows GET POST PATCH PUT DELETE only", () => {
    for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"] as const) {
      const call = studioRequest.build({ method, path: "/api/x" });
      expect(call.method).toBe(method);
    }
    expect(() => studioRequest.build({ method: "OPTIONS", path: "/api/x" })).toThrow(/invalid method/);
    expect(() => studioRequest.build({ method: "TRACE", path: "/api/x" })).toThrow(/invalid method/);
  });

  it("an args.target override cannot retarget the control plane", () => {
    const call = buildStudio("/api/x", { target: "control_plane" });
    expect(call.target).toBe("studio");
    expect(call.path).toBe("/api/x");
  });

  const refused: [string, string, RegExp][] = [
    ["no leading /api/", "api/x", /\/api\//],
    ["leading slash but not /api/", "/health", /\/api\//],
    ["protocol-relative", "//evil.example/", /\/api\//],
    ["double slash inside", "/api//evil", /\/\//],
    ["dot-dot segment", "/api/../secret", /\.\.|segment/],
    ["encoded dots", "/api/%2e%2e/secret", /encoded dots/],
    ["uppercase encoded dots", "/api/%2E%2E/admin", /encoded dots/],
    ["http scheme in path", "/api/next/http:evil.example", /scheme/],
    ["https scheme in path", "/api/foo?next=https:evil.example", /scheme/],
    ["bare http url", "http://evil.example/api/x", /\/api\//],
    ["control-plane admin", "/api/admin/tenants", /control-plane/],
    ["control-plane platform", "/api/platform/version", /control-plane/],
  ];

  it("refuses each SSRF / traversal / control-plane shape (table can go red)", () => {
    expect(refused.length).toBeGreaterThan(8);
    for (const [, path, msg] of refused) {
      expect(() => buildStudio(path), path).toThrow(msg);
    }
  });

  it("NEGATIVE: a refused path never reaches fetch", async () => {
    const calls = stubFetch();
    for (const [, path] of refused) {
      let caught = false;
      try {
        studioRequest.build({ method: "GET", path });
      } catch {
        caught = true;
      }
      expect(caught, path).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("caps path length and the cap can fire", () => {
    const ok = `/api/${"a".repeat(STUDIO_REQUEST_MAX_PATH_LEN - "/api/".length)}`;
    expect(ok.length).toBe(STUDIO_REQUEST_MAX_PATH_LEN);
    expect(() => buildStudio(ok)).not.toThrow();
    const over = `${ok}x`;
    expect(() => buildStudio(over)).toThrow(/exceeds/);
  });
});

describe("studio_request fetch wiring", () => {
  it("sends redirect:manual so Authorization cannot hop", async () => {
    const calls = stubFetch();
    const result = await runTool(ENV, buildStudio("/api/storyboard/renders"));
    expect(result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].url).toBe("https://studio.example.com/api/storyboard/renders");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer studio-secret",
    );
  });

  it("does not use CONTROL_PLANE_* even when those bindings are set", async () => {
    const calls = stubFetch();
    const result = await runTool(ENV, buildStudio("/api/modules"));
    expect(result.isError).toBe(false);
    expect(calls[0].url.startsWith("https://studio.example.com/")).toBe(true);
    expect(calls[0].url.includes("cp.example.com")).toBe(false);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer studio-secret",
    );
    expect((calls[0].init.headers as Record<string, string>).Authorization).not.toContain("opc-secret");
  });

  it("studioUrl refuses an origin-changing path even if build() is bypassed", () => {
    expect(() =>
      studioUrl(ENV, { method: "GET", path: "@evil.example/api/x", target: "studio" }),
    ).toThrow(/origin/);
    expect(() =>
      studioUrl(ENV, { method: "GET", path: "https://evil.example/api/x", target: "studio" }),
    ).toThrow();
  });
});

describe("control_plane_request contrast", () => {
  it("still accepts /api/admin (the hatch this tool must not steal)", () => {
    const call = controlPlaneRequest.build({ method: "GET", path: "/api/admin/settings" });
    expect(call.target).toBe("control_plane");
    expect(call.path).toBe("/api/admin/settings");
  });
});
