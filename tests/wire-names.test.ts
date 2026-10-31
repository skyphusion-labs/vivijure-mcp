import { describe, it, expect } from "vitest";
import { TOOLS_BY_NAME } from "../src/mcp-tools.js";

// These two tools sent field names the studio route does not read. audio_analyze answered 400
// "audioKey required" on every call. render_frames sent `times`, which the route ignores.
const tool = (name: string) => {
  const t = TOOLS_BY_NAME.get(name);
  if (!t) throw new Error(`tool ${name} is not in the catalog`);
  return t;
};

describe("wire names match the studio route", () => {
  it("audio_analyze sends audioKey, the only field the route reads", () => {
    const call = tool("audio_analyze").build({ key: "out/a.mp3" });
    expect(call.path).toBe("/api/audio/analyze");
    expect(call.body).toEqual({ audioKey: "out/a.mp3" });
  });

  it("render_frames publishes and forwards count and at, and no longer publishes times", () => {
    const t = tool("render_frames");
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props).sort()).toEqual(["at", "count", "key"]);
    const call = t.build({ key: "renders/f/film.mp4", count: 1, at: 4.5 });
    expect(call.body).toEqual({ key: "renders/f/film.mp4", count: 1, at: 4.5 });
  });

  it("submit_clips publishes and forwards shots, the only list the route reads", () => {
    const t = tool("submit_clips");
    const schema = t.inputSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties).sort()).toEqual(["config", "motion_backend", "project", "shots"]);
    expect(schema.required).toEqual(["shots"]);
    const shots = [{ shot_id: "shot_01", keyframe_url: "https://x/k.png", prompt: "p", seconds: 6 }];
    const call = t.build({ project: "p", motion_backend: "minimax-hailuo", shots });
    expect(call.path).toBe("/api/render/clips");
    expect(call.body).toEqual({ project: "p", motion_backend: "minimax-hailuo", shots });
  });

  it("submit_clips refuses an empty or missing shot list before it spends", () => {
    expect(() => tool("submit_clips").build({})).toThrow("shots");
    expect(() => tool("submit_clips").build({ shots: [] })).toThrow("shots");
  });
});
