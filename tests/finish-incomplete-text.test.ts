import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/mcp-tools.js";

// An agent reading `done` must be told it may not be a clean finish (vivijure-core#377).
describe("the agent is told a done film may be incomplete", () => {
  const poll = TOOLS.find((t) => t.name === "poll_film")!;
  it("poll_film says so, and names the retry", () => {
    expect(poll.description).toContain("finish_incomplete");
    expect(poll.description).toContain("NOT a clean finish");
    expect(poll.description).toContain("retry_film_finish");
    expect(poll.description).toContain("finish_waiting");
  });
  it("retry_film_finish posts to the film route", () => {
    const retry = TOOLS.find((t) => t.name === "retry_film_finish")!;
    expect(retry.build({ id: "film-1" })).toMatchObject({ method: "POST", path: "/api/render/film/film-1/finish-retry" });
    expect(() => retry.build({})).toThrow();
  });
});
