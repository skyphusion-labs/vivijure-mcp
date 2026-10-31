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
});
