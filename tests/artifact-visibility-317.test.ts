import { describe, it, expect, afterEach, vi } from "vitest";
import worker from "../src/mcp.js";
import { TOOLS_BY_NAME, runTool } from "../src/mcp-tools.js";
import type { McpEnv } from "../src/mcp-env.js";

// cf#317: the agent must be able to SEE what it made.
//
// Before this, every artifact route came back as a byte count -- including images, which MCP can
// carry natively. `view_artifact` returns an image as an MCP image block; `artifact_url` returns a
// short-lived presigned link for the things MCP structurally cannot carry (video, audio, tar).
//
// The tests that matter here are the negative ones: that a VIDEO is still refused rather than
// dumped, that the escape hatch did NOT quietly gain image inlining, and that a bad key is rejected
// before it reaches the studio. A green "the image came back" on its own proves very little.

const ENV: McpEnv = {
  STUDIO_URL: "https://studio.example.com",
  STUDIO_API_TOKEN: "studio-secret",
  MCP_TOKEN: "gate-secret",
};
const AUTH = { Authorization: `Bearer ${ENV.MCP_TOKEN}` };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

let calls: string[] = [];
function stubBytes(bytes: Uint8Array, contentType: string, status = 200) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(bytes, {
      status,
      headers: { "content-type": contentType, "content-length": String(bytes.byteLength) },
    });
  }) as unknown as typeof fetch;
}

// A real 1x1 PNG: file magic plus enough structure that "is this actually a PNG" is answerable.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);
// An mp4 ftyp box header -- enough to be recognizable as video, not an image.
const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

function mcpCall(name: string, args: Record<string, unknown>): Request {
  return new Request("https://studio-mcp.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

describe("cf#317 view_artifact returns an image an agent can actually see", () => {
  it("returns an MCP image block carrying the real bytes", async () => {
    stubBytes(PNG, "image/png");
    const res = await worker.fetch(mcpCall("view_artifact", { key: "cast/portrait-1.png" }), ENV);
    const body = (await res.json()) as { result: { content: { type: string; data?: string; mimeType?: string }[] } };
    const image = body.result.content.find((c) => c.type === "image");
    expect(image, "no image block in the tool result").toBeDefined();
    expect(image!.mimeType).toBe("image/png");
    // Verify at the ARTIFACT: decode what we handed back and check the PNG magic survived the trip,
    // rather than trusting that a base64 string of the right shape is the right bytes.
    const decoded = Uint8Array.from(atob(image!.data!), (c) => c.charCodeAt(0));
    expect(decoded.byteLength).toBe(PNG.byteLength);
    expect([...decoded.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it("requests the artifact route with the key intact", async () => {
    stubBytes(PNG, "image/png");
    await worker.fetch(mcpCall("view_artifact", { key: "renders/film-x/keyframes/shot_01.png" }), ENV);
    expect(calls[0]).toBe("https://studio.example.com/api/artifact/renders/film-x/keyframes/shot_01.png");
  });

  // NEGATIVE CONTROL. MCP has no video block. If this ever starts returning an image or dumping
  // bytes, the honest-refusal property is gone and a multi-MB film is riding the transport.
  it("still REFUSES video, and says why", async () => {
    stubBytes(MP4, "video/mp4");
    const res = await worker.fetch(mcpCall("view_artifact", { key: "renders/film-x/film.mp4" }), ENV);
    const body = (await res.json()) as { result: { content: { type: string; text?: string }[] } };
    expect(body.result.content.every((c) => c.type === "text")).toBe(true);
    expect(body.result.content[0].text).toContain("not inlined");
    expect(body.result.content[0].text).toContain("artifact_url");
  });

  // NEGATIVE CONTROL on the opt-in itself. The generic escape hatch must NOT have gained inlining:
  // that flag is per-tool on purpose, and a default-on version would push megabytes through any
  // stray studio_request call.
  it("studio_request does NOT inline an image (the opt-in is per tool)", async () => {
    stubBytes(PNG, "image/png");
    const res = await worker.fetch(
      mcpCall("studio_request", { method: "GET", path: "/api/artifact/cast/portrait-1.png" }),
      ENV,
    );
    const body = (await res.json()) as { result: { content: { type: string; text?: string }[] } };
    expect(body.result.content.every((c) => c.type === "text")).toBe(true);
    expect(body.result.content[0].text).toContain("not inlined");
  });

  it("refuses an oversized image instead of truncating it", async () => {
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set(PNG.subarray(0, 8), 0);
    stubBytes(big, "image/png");
    const out = await runTool(ENV, { method: "GET", path: "/api/artifact/cast/huge.png" }, { inlineImages: true });
    expect(out.content.every((c) => c.type === "text")).toBe(true);
    expect((out.content[0] as { text: string }).text).toContain("inline cap");
  });

  it("a 4xx image response is not inlined as a picture", async () => {
    // An error body that happens to carry an image content-type must read as an error, not as art.
    stubBytes(PNG, "image/png", 404);
    const out = await runTool(ENV, { method: "GET", path: "/api/artifact/cast/gone.png" }, { inlineImages: true });
    expect(out.isError).toBe(true);
    expect(out.content.every((c) => c.type === "text")).toBe(true);
  });
});

describe("cf#317 artifact_url hands back a fetchable link", () => {
  it("calls the presign route and forwards a clamped-at-the-studio lifetime", async () => {
    calls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          key: "renders/film-x/film.mp4",
          url: "https://acct.r2.cloudflarestorage.com/vivijure/renders/film-x/film.mp4?X-Amz-Signature=abc",
          expires_in: 300,
          content_type: "video/mp4",
          size: 3811331,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await worker.fetch(
      mcpCall("artifact_url", { key: "renders/film-x/film.mp4", expires_in: 600 }),
      ENV,
    );
    expect(calls[0]).toBe(
      "https://studio.example.com/api/artifact-url/renders/film-x/film.mp4?expires_in=600",
    );
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    expect(body.result.content[0].text).toContain("X-Amz-Signature");
    expect(body.result.content[0].text).toContain("video/mp4");
  });

  it("omits expires_in when the caller does not ask for one (studio default applies)", async () => {
    calls = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await worker.fetch(mcpCall("artifact_url", { key: "renders/film-x/film.mp4" }), ENV);
    expect(calls[0]).toBe("https://studio.example.com/api/artifact-url/renders/film-x/film.mp4");
  });
});

describe("cf#317 key validation happens before the studio is called", () => {
  const bad = ["../secrets/env.json", "/etc/passwd", "https://evil.example/x", "renders/../../etc/passwd"];

  for (const key of bad) {
    it(`rejects '${key}' as a bad argument, with no outbound request`, async () => {
      calls = [];
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

      const res = await worker.fetch(mcpCall("view_artifact", { key }), ENV);
      const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain("Invalid arguments");
      expect(calls, "a rejected key must never reach the studio").toEqual([]);
    });
  }

  // CONTROL: the rejections above must not be passing because every key is rejected.
  it("positive control: a normal key IS accepted and does reach the studio", async () => {
    stubBytes(PNG, "image/png");
    const res = await worker.fetch(mcpCall("view_artifact", { key: "cast/portrait-1.png" }), ENV);
    const body = (await res.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBe(false);
    expect(calls.length).toBe(1);
  });

  it("percent-encodes a segment without destroying the path", () => {
    const call = TOOLS_BY_NAME.get("view_artifact")!.build({ key: "renders/my film/shot 01.png" });
    expect(call.path).toBe("/api/artifact/renders/my%20film/shot%2001.png");
  });
});
