// MCP_TOKEN_EXTRA: an ADDITIVE second gate secret, so a new client gets its own credential
// without rewriting the operator's MCP_TOKEN (fleet-chezmoi #1070 shape, crew-bus prior art).
//
// Every test here is driven RED against the pre-change worker before being trusted; a test that
// passes against the unfixed code proves nothing. The red/green table is in the PR body.

import { describe, it, expect } from "vitest";
import worker, { gateCredentials, gateOpens } from "../src/mcp.js";
import type { McpEnv } from "../src/mcp-env.js";

const BASE: McpEnv = {
  STUDIO_URL: "https://studio.example.com",
  STUDIO_API_TOKEN: "studio-secret",
};

function ping(headers: Record<string, string> = {}): Request {
  return new Request("https://studio-mcp.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

// status 200 == the gate opened (a ping needs no fetch stub); 401 == refused.
async function status(env: McpEnv, headers: Record<string, string>): Promise<number> {
  return (await worker.fetch(ping(headers), env)).status;
}

describe("MCP gate: MCP_TOKEN_EXTRA is additive", () => {
  it("MCP_TOKEN alone still authenticates (no regression)", async () => {
    const env = { ...BASE, MCP_TOKEN: "operator-secret" };
    expect(await status(env, bearer("operator-secret"))).toBe(200);
  });

  it("MCP_TOKEN still authenticates while MCP_TOKEN_EXTRA is populated", async () => {
    const env = { ...BASE, MCP_TOKEN: "operator-secret", MCP_TOKEN_EXTRA: "crew-a,crew-b" };
    expect(await status(env, bearer("operator-secret"))).toBe(200);
  });

  it("a token from MCP_TOKEN_EXTRA authenticates", async () => {
    const env = { ...BASE, MCP_TOKEN: "operator-secret", MCP_TOKEN_EXTRA: "crew-a,crew-b" };
    expect(await status(env, bearer("crew-a"))).toBe(200);
    expect(await status(env, bearer("crew-b"))).toBe(200);
  });

  it("MCP_TOKEN_EXTRA works with MCP_TOKEN unset (extra alone is a valid gate)", async () => {
    const env = { ...BASE, MCP_TOKEN_EXTRA: "crew-a" };
    expect(await status(env, bearer("crew-a"))).toBe(200);
  });

  it("separates on newline as well as comma, and trims entries", async () => {
    const env = { ...BASE, MCP_TOKEN_EXTRA: "crew-a\n  crew-b  ,\ncrew-c\r\n" };
    expect(await status(env, bearer("crew-a"))).toBe(200);
    expect(await status(env, bearer("crew-b"))).toBe(200);
    expect(await status(env, bearer("crew-c"))).toBe(200);
  });

  it("a token in NEITHER secret is refused 401", async () => {
    const env = { ...BASE, MCP_TOKEN: "operator-secret", MCP_TOKEN_EXTRA: "crew-a,crew-b" };
    expect(await status(env, bearer("not-issued"))).toBe(401);
  });

  // THE EMPTY-ENTRY HOLE, asserted where it is OBSERVABLE.
  //
  // Splitting "crew-a," yields ["crew-a", ""]. An empty credential makes the expected header the
  // bare string "Bearer ", so any client sending exactly that would authenticate: one trailing
  // comma in a secret opens the door to everyone.
  //
  // These assert on gateCredentials()/gateOpens() rather than through worker.fetch() ON PURPOSE,
  // and the reason is the point. A mutation pass (drop the blank-entry filter, run the suite)
  // showed EVERY HTTP-level assertion of this hole staying green: Headers normalisation strips the
  // trailing space, so `Authorization: "Bearer "` arrives as "Bearer" and never equals the
  // "Bearer " an empty credential produces. Measured, with an interior-space control proving the
  // stripping is trailing-only. So over fetch the hole is masked by the PLATFORM, not by this
  // module -- which is exactly why the filter has to exist here and be proved here.
  it("drops a blank entry left by a trailing comma", () => {
    expect(gateCredentials({ ...BASE, MCP_TOKEN_EXTRA: "crew-a," })).toEqual(["crew-a"]);
    expect(gateCredentials({ ...BASE, MCP_TOKEN_EXTRA: "crew-a,,crew-b," })).toEqual([
      "crew-a",
      "crew-b",
    ]);
  });

  it("drops a blank entry left by a trailing or embedded newline", () => {
    expect(gateCredentials({ ...BASE, MCP_TOKEN_EXTRA: "crew-a\n" })).toEqual(["crew-a"]);
    expect(gateCredentials({ ...BASE, MCP_TOKEN_EXTRA: "crew-a\r\n\ncrew-b\n" })).toEqual([
      "crew-a",
      "crew-b",
    ]);
  });

  it("yields NO credential from a whitespace-only or separator-only MCP_TOKEN_EXTRA", () => {
    expect(gateCredentials({ ...BASE, MCP_TOKEN_EXTRA: " , \n , " })).toEqual([]);
    expect(gateCredentials({ ...BASE, MCP_TOKEN_EXTRA: ",,\n\n" })).toEqual([]);
    expect(gateCredentials({ ...BASE, MCP_TOKEN_EXTRA: "   " })).toEqual([]);
    expect(gateCredentials({ ...BASE, MCP_TOKEN_EXTRA: "" })).toEqual([]);
  });

  // The bare "Bearer " a blank credential would admit, tested against the gate predicate directly.
  // With the filter: no credential is empty, so this is false whatever the secret's punctuation.
  it("never opens the gate for a bare `Bearer ` however the secret is punctuated", () => {
    for (const extra of ["crew-a,", "crew-a\n", " , \n , ", ",,", "crew-a,,crew-b,"]) {
      const env = { ...BASE, MCP_TOKEN: "operator-secret", MCP_TOKEN_EXTRA: extra };
      expect(gateOpens("Bearer ", env)).toBe(false);
      expect(gateOpens("Bearer", env)).toBe(false);
      expect(gateOpens("", env)).toBe(false);
      // control: the same env must still admit a real credential, or the falses above prove nothing.
      expect(gateOpens("Bearer operator-secret", env)).toBe(true);
    }
  });

  it("yields a whitespace-only MCP_TOKEN as no credential either", () => {
    expect(gateCredentials({ ...BASE, MCP_TOKEN: "   " })).toEqual([]);
    expect(gateCredentials({ ...BASE, MCP_TOKEN: "" })).toEqual([]);
    expect(gateCredentials({ ...BASE, MCP_TOKEN: "\n" })).toEqual([]);
    // control: a real value IS yielded, verbatim and unsplit.
    expect(gateCredentials({ ...BASE, MCP_TOKEN: " left,right " })).toEqual([" left,right "]);
  });

  // Kept over fetch as well, but stated for what it is: this pair is a TRANSPORT check (the door
  // refuses a blank bearer end to end); it is NOT evidence about the filter, per the note above.
  it("refuses a blank bearer over HTTP with a trailing separator in MCP_TOKEN_EXTRA", async () => {
    const env = { ...BASE, MCP_TOKEN: "operator-secret", MCP_TOKEN_EXTRA: "crew-a," };
    expect(await status(env, { Authorization: "Bearer " })).toBe(401);
    expect(await status(env, {})).toBe(401);
    // control: the same env must still admit the real token, or the 401s above prove nothing.
    expect(await status(env, bearer("crew-a"))).toBe(200);
  });

  it("fails closed with BOTH secrets unset", async () => {
    expect(await status(BASE, { Authorization: "Bearer " })).toBe(401);
    expect(await status(BASE, bearer("anything"))).toBe(401);
    expect(await status(BASE, {})).toBe(401);
  });

  it("fails closed with MCP_TOKEN unset and MCP_TOKEN_EXTRA empty after filtering", async () => {
    const env = { ...BASE, MCP_TOKEN_EXTRA: ",,\n\n , " };
    expect(await status(env, bearer("anything"))).toBe(401);
    expect(await status(env, { Authorization: "Bearer " })).toBe(401);
    expect(await status(env, { Authorization: "Bearer ,," })).toBe(401);
  });

  it("does not accept the whole MCP_TOKEN_EXTRA string as one token", async () => {
    const env = { ...BASE, MCP_TOKEN_EXTRA: "crew-a,crew-b" };
    expect(await status(env, bearer("crew-a,crew-b"))).toBe(401);
  });

  // BEHAVIOUR CHANGE, deliberate and the only one this file makes to existing MCP_TOKEN handling.
  // Before: a whitespace-only MCP_TOKEN was truthy, so the gate expected "Bearer <that whitespace>"
  // and a client sending exactly that authenticated. Now it yields no credential at all. Same rule
  // as the blank MCP_TOKEN_EXTRA entries, applied to the same door.
  it("treats a whitespace-only MCP_TOKEN as no credential (fails closed)", async () => {
    const env = { ...BASE, MCP_TOKEN: "   " };
    expect(await status(env, bearer("   "))).toBe(401);
    expect(await status(env, { Authorization: "Bearer " })).toBe(401);
    expect(await status(env, bearer("anything"))).toBe(401);
  });

  // MCP_TOKEN is a single opaque value and is NOT split: splitting it would turn one existing
  // secret containing a comma into two shorter accepted tokens, which is a silent weakening.
  it("never splits MCP_TOKEN itself", async () => {
    const env = { ...BASE, MCP_TOKEN: "left,right" };
    expect(await status(env, bearer("left,right"))).toBe(200);
    expect(await status(env, bearer("left"))).toBe(401);
    expect(await status(env, bearer("right"))).toBe(401);
  });
});
