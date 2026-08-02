import { describe, it, expect } from "vitest";
import { TOOLS_BY_NAME, runTool } from "../src/mcp-tools.js";
import type { McpEnv } from "../src/mcp-env.js";

// cf#317 -- bytes IN.
//
// The claim these two tools rest on is not "an upload tool is convenient". It is that the studio's
// upload routes were NOT REACHABLE BY ANY MCP MEANS: they read a raw request body and dispatch on
// the content-type header, and every path through runTool sent `application/json`. The escape hatch
// looked like an answer and was not one. That claim is asserted here (the studio_request test at the
// bottom) rather than described, because it is the whole justification for new machinery.

const ENV = { STUDIO_URL: "https://studio.example", STUDIO_API_TOKEN: "t" } as McpEnv;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x7f, 0xff]);
const PNG_B64 = "iVBORw0KGgoAf/8=";

const tool = (name: string) => {
  const t = TOOLS_BY_NAME.get(name);
  if (!t) throw new Error(`tool ${name} is not in the catalog`);
  return t;
};

/** Run one tool call against a stubbed fetch and hand back exactly what went on the wire. */
async function captureWire(name: string, args: Record<string, unknown>) {
  const seen: { url?: string; init?: RequestInit } = {};
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.url = String(url);
    seen.init = init;
    return new Response(JSON.stringify({ key: "uploads/x.png" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    const t = tool(name);
    await runTool(ENV, t.build(args), { inlineImages: t.inlineImages === true });
  } finally {
    globalThis.fetch = orig;
  }
  const headers = (seen.init?.headers ?? {}) as Record<string, string>;
  return { url: seen.url, headers, body: seen.init?.body };
}

const bodyBytes = (b: unknown): Uint8Array => new Uint8Array(b as ArrayBuffer);

describe("cf#317 upload_image / upload_audio -- what build() emits", () => {
  it("upload_image aims at POST /api/upload and carries the decoded bytes, not JSON", () => {
    const call = tool("upload_image").build({ data_base64: PNG_B64, mime: "image/png" });
    expect({ method: call.method, path: call.path }).toEqual({ method: "POST", path: "/api/upload" });
    expect(call.body, "a bytes-in call must not also carry a JSON body").toBeUndefined();
    expect(call.rawBody?.contentType).toBe("image/png");
    expect(Array.from(call.rawBody!.bytes)).toEqual(Array.from(PNG));
  });

  it("upload_audio aims at POST /api/storyboard/audio-upload", () => {
    const call = tool("upload_audio").build({ data_base64: "AAEC", mime: "audio/mpeg" });
    expect({ method: call.method, path: call.path }).toEqual({
      method: "POST",
      path: "/api/storyboard/audio-upload",
    });
    expect(call.rawBody?.contentType).toBe("audio/mpeg");
  });

  // Every refusal is watched failing on a REAL bad input rather than asserted to exist. The message
  // is asserted too: a refusal that does not name which condition fired is a coincidence, not evidence.
  it.each([
    ["absent payload", {} as Record<string, unknown>, /data_base64/],
    ["empty payload", { data_base64: "   ", mime: "image/png" }, /data_base64/],
    ["a data: URL prefix", { data_base64: "data:image/png;base64,iVBORw==", mime: "image/png" }, /prefix/],
    ["invalid base64", { data_base64: "!!!not base64!!!", mime: "image/png" }, /valid base64/],
    ["zero decoded bytes", { data_base64: "", mime: "image/png" }, /data_base64/],
    ["a missing mime", { data_base64: PNG_B64 }, /mime/],
    ["a mime that is not a media type", { data_base64: PNG_B64, mime: "png" }, /media type/],
  ])("upload_image refuses %s", (_label, args, re) => {
    expect(() => tool("upload_image").build(args)).toThrow(re);
  });

  it("upload_image refuses a payload over the transport ceiling", () => {
    // 32 MB of decoded zeros. Built by repetition rather than by a constant copied from the source,
    // so the test cannot pass by agreeing with a number it was handed.
    const oversize = "A".repeat(Math.ceil(((32 * 1024 * 1024) + 1024) / 3) * 4);
    expect(() => tool("upload_image").build({ data_base64: oversize, mime: "image/png" })).toThrow(
      /transport ceiling/,
    );
  });

  it("POSITIVE CONTROL: a payload just under the ceiling is accepted", () => {
    // Without this, every refusal above would pass identically if build() simply always threw.
    const ok = "A".repeat(4 * 1024);
    expect(() => tool("upload_image").build({ data_base64: ok, mime: "image/png" })).not.toThrow();
  });
});

describe("cf#317 the wire: raw bytes go out as bytes", () => {
  it("upload_image sends the image content-type and the exact bytes", async () => {
    const wire = await captureWire("upload_image", { data_base64: PNG_B64, mime: "image/png" });
    expect(wire.url).toBe("https://studio.example/api/upload");
    expect(wire.headers["Content-Type"]).toBe("image/png");
    expect(Array.from(bodyBytes(wire.body))).toEqual(Array.from(PNG));
  });

  it("upload_audio sends the audio content-type", async () => {
    const wire = await captureWire("upload_audio", { data_base64: "AAEC", mime: "audio/mpeg" });
    expect(wire.url).toBe("https://studio.example/api/storyboard/audio-upload");
    expect(wire.headers["Content-Type"]).toBe("audio/mpeg");
  });

  it("NEGATIVE CONTROL: a JSON tool through the same runTool still sends application/json", async () => {
    // The raw-body branch has to DISCRIMINATE. If it did not, this would send image bytes too and
    // every assertion above would pass for the wrong reason.
    const wire = await captureWire("create_cast", { name: "Nadia" });
    expect(wire.headers["Content-Type"]).toBe("application/json");
    expect(typeof wire.body).toBe("string");
  });
});

describe("cf#317 why these tools had to exist", () => {
  it("studio_request CANNOT stand in: it sends JSON to a route that reads raw bytes", async () => {
    // This is the measurement behind the finding, kept executable. The escape hatch reaches every
    // route in the contract EXCEPT this class, and nothing in the parity numbers said so, because
    // route reach was measured and body encoding was not. If studio_request ever learns to send
    // bytes, this test fails and the finding gets re-read rather than quietly outliving its truth.
    const wire = await captureWire("studio_request", {
      method: "POST",
      path: "/api/upload",
      body: { data_base64: PNG_B64 },
    });
    expect(wire.url).toBe("https://studio.example/api/upload");
    expect(wire.headers["Content-Type"]).toBe("application/json");
  });
});
