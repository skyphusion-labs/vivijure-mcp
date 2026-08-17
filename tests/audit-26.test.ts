import { describe, it, expect } from "vitest";
import { TOOLS_BY_NAME } from "../src/mcp-tools.js";

// mcp#26 leftovers: advertise (and forward) route params the studio already honors.
// bodyWithout forwards undeclared keys, so the real gap is discoverability -- tools/list
// / inputSchema is the agent-facing map. Assert the map AND the forwarded body/query.

const tool = (name: string) => {
  const t = TOOLS_BY_NAME.get(name);
  if (!t) throw new Error(`tool ${name} is not in the catalog`);
  return t;
};
const props = (name: string) =>
  (tool(name).inputSchema as { properties: Record<string, unknown> }).properties;
const required = (name: string) =>
  ((tool(name).inputSchema as { required?: string[] }).required ?? []);
const call = (name: string, args: Record<string, unknown>) => tool(name).build(args);

describe("mcp#26 bundle_storyboard reverse-bridge", () => {
  it("schema advertises startImage and sceneStartImages", () => {
    const p = Object.keys(props("bundle_storyboard"));
    expect(p).toContain("startImage");
    expect(p).toContain("sceneStartImages");
    expect(tool("bundle_storyboard").description).toMatch(/reverse-bridge|sceneStartImages/);
  });

  it("forwards startImage and sceneStartImages in the body", () => {
    const startImage = { key: "uploads/open.png" };
    const sceneStartImages = { shot_01: { key: "uploads/s1.png" } };
    const built = call("bundle_storyboard", {
      storyboard: { title: "t", scenes: [{ id: "shot_01" }] },
      characterRefs: { A: { name: "Ada", prompt: "p", trainingImages: [] } },
      startImage,
      sceneStartImages,
    });
    expect(built).toMatchObject({ method: "POST", path: "/api/storyboard/bundle" });
    expect(built.body).toMatchObject({ startImage, sceneStartImages });
  });

  it("omits startImage / sceneStartImages when not passed", () => {
    const built = call("bundle_storyboard", {
      storyboard: { title: "t", scenes: [] },
      characterRefs: {},
    });
    const body = built.body as Record<string, unknown>;
    expect("startImage" in body).toBe(false);
    expect("sceneStartImages" in body).toBe(false);
  });
});

describe("mcp#26 chat system_prompt + attachments", () => {
  it("schema advertises system_prompt and attachments", () => {
    const p = Object.keys(props("chat"));
    expect(p).toContain("system_prompt");
    expect(p).toContain("attachments");
    expect(tool("chat").description).toMatch(/system_prompt/);
    expect(tool("chat").description).toMatch(/attachments/);
  });

  it("forwards system_prompt and attachments in the body", () => {
    const attachments = [
      { type: "image", data: "data:image/png;base64,aaa", mime: "image/png", filename: "ref.png" },
    ];
    const built = call("chat", {
      model: "flux",
      user_input: "a face",
      system_prompt: "no text",
      attachments,
    });
    expect(built).toMatchObject({ method: "POST", path: "/api/chat" });
    expect(built.body).toMatchObject({
      model: "flux",
      user_input: "a face",
      system_prompt: "no text",
      attachments,
    });
  });

  it("omits system_prompt / attachments when not passed", () => {
    const built = call("chat", { model: "gpt", user_input: "hi" });
    const body = built.body as Record<string, unknown>;
    expect("system_prompt" in body).toBe(false);
    expect("attachments" in body).toBe(false);
  });
});

describe("mcp#26 train_cast_lora model family", () => {
  it("schema advertises model_family and modelFamily", () => {
    const p = Object.keys(props("train_cast_lora"));
    expect(p).toContain("model_family");
    expect(p).toContain("modelFamily");
    expect(tool("train_cast_lora").description).toMatch(/model_family/);
  });

  it("forwards model_family and strips the path id", () => {
    const built = call("train_cast_lora", { id: "c1", model_family: "wan" });
    expect(built).toMatchObject({ method: "POST", path: "/api/cast/c1/train-lora" });
    expect(built.body).toEqual({ model_family: "wan" });
  });

  it("forwards the modelFamily alias", () => {
    const built = call("train_cast_lora", { id: "c1", modelFamily: "sdxl" });
    expect(built.body).toEqual({ modelFamily: "sdxl" });
  });

  it("omits model_family when not passed", () => {
    const built = call("train_cast_lora", { id: "c1" });
    expect(built.body).toEqual({});
  });
});

describe("mcp#26 score hook: score_bed + poll_job", () => {
  it("score_bed schema advertises the fields the route honors", () => {
    const p = Object.keys(props("score_bed"));
    expect(p).toEqual(
      expect.arrayContaining(["kind", "prompt", "text", "storyboard", "module", "seconds", "config"]),
    );
    expect(tool("score_bed").description).toMatch(/score-hook|score hook/i);
  });

  it("score_bed forwards kind/text/module/seconds/config", () => {
    const built = call("score_bed", {
      kind: "narration",
      text: "hello",
      module: "narration-gen",
      seconds: 12,
      config: { voice: "ada" },
    });
    expect(built).toMatchObject({ method: "POST", path: "/api/storyboard/score-bed" });
    expect(built.body).toEqual({
      kind: "narration",
      text: "hello",
      module: "narration-gen",
      seconds: 12,
      config: { voice: "ada" },
    });
  });

  it("poll_job requires module and forwards it as a query param", () => {
    expect(required("poll_job")).toEqual(expect.arrayContaining(["id", "module"]));
    expect(() => call("poll_job", { id: "job-1" })).toThrow(/module/);
    const built = call("poll_job", { id: "job-1", module: "music-gen" });
    expect(built).toMatchObject({
      method: "GET",
      path: "/api/job/job-1",
      query: { module: "music-gen" },
    });
    expect(built.body).toBeUndefined();
  });
});

describe("mcp#26 notify hook: no send route", () => {
  it("there is no invented notify / send_notify tool", () => {
    expect(TOOLS_BY_NAME.has("notify")).toBe(false);
    expect(TOOLS_BY_NAME.has("send_notify")).toBe(false);
    expect(TOOLS_BY_NAME.has("notify_email")).toBe(false);
  });

  it("install-config tools name notify as their hook surface", () => {
    expect(tool("get_module_config").description).toMatch(/notify/i);
    expect(tool("patch_module_config").description).toMatch(/notify/i);
  });
});
