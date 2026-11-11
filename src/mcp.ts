// Vivijure Studio MCP Worker.
//
// A minimal, stateless Streamable-HTTP MCP server that lets an AI agent drive the Vivijure Studio
// API (docs/CONTRACT.md) through structured tools instead of raw curl/playwright. It is a SEPARATE
// Worker from the studio core (its own script + host, wrangler.mcp.toml); it holds NO studio
// bindings and reaches the studio purely over HTTP with the operator's studio bearer, so it can run
// against any studio by pointing STUDIO_URL at it.
//
// The credentials that keep the surfaces clean:
//   - MCP_TOKEN         gates THIS server (every /mcp request needs Authorization: Bearer <token>).
//   - MCP_TOKEN_EXTRA   an ADDITIVE list of further accepted gate tokens, so a new client gets its
//                       own credential without MCP_TOKEN ever being rewritten (fleet-chezmoi #1070).
//   - STUDIO_API_TOKEN  is the studio bearer this server sends onward; the MCP client never sees it.
// All are worker secrets seeded out-of-band. The gate fails closed when NO gate credential exists
// at all: neither secret set, or both empty once blank entries are dropped.
//
// Long-running renders are agent-driven: submit_film returns a job id, then the agent polls poll_film
// until done/failed. This server never long-polls or holds job state.

import type { McpEnv } from "./mcp-env.js";
import { TOOLS, TOOLS_BY_NAME, SCOPE_DENY_TEXT, rejectUndeclared, runTool, scopeAllows, type ToolScope } from "./mcp-tools.js";

// KEEP IN SYNC WITH package.json "version". This is the ONLY version an MCP client can read off the
// wire (`serverInfo` in the initialize reply), and it sat at 0.1.0 from v1.0.0 through v1.0.1 while
// package.json said otherwise -- so an agent probing serverInfo.version to decide whether a tool
// exists got the same answer before and after a release that added one. It is not derived from
// package.json because that would need a JSON import in the Worker bundle; the drift is prevented by
// tests/server-info-version.test.ts instead, which fails if these two ever disagree.
const SERVER_INFO = { name: "vivijure-studio", version: "2.1.0" };
const PROTOCOL_VERSION = "2025-06-18";

// Constant-time compare by SHA-256 digest, as vivijure-cf's auth-gate.ts does: hash both sides, then
// XOR-fold the two fixed-length digests. The scan always covers all 32 bytes, so neither the length of
// the presented token nor the position of the first mismatch shows in the timing.
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ua = new Uint8Array(da);
  const ub = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i] ^ ub[i];
  return diff === 0;
}

// Every credential that may open the gate: MCP_TOKEN plus every entry in MCP_TOKEN_EXTRA.
//
// MCP_TOKEN_EXTRA is ADDITIVE (fleet-chezmoi #1070; crew-bus solves the same problem the same
// way). Worker secrets are write-only, so widening access by rewriting MCP_TOKEN means
// re-supplying the operator's own credential from memory, and one typo silently 401s the
// operator. A second secret lets a new client be issued its own token while MCP_TOKEN is never
// touched, so no existing client can break whatever MCP_TOKEN_EXTRA contains.
//
// The two secrets are handled DIFFERENTLY, deliberately:
//   - MCP_TOKEN is ONE opaque value. It is never split and never trimmed, so a token that today
//     contains a comma, a newline or surrounding whitespace keeps authenticating exactly as it
//     does now. Splitting it would turn one secret into several shorter accepted ones, which is a
//     silent weakening rather than a feature.
//   - MCP_TOKEN_EXTRA is a LIST. Entries separate on comma and/or newline (CR tolerated so a
//     value pasted out of a file works), and each entry is trimmed.
//
// EMPTY ENTRIES ARE DROPPED, and that is the load-bearing line here. "crew-a," splits to
// ["crew-a", ""]; an empty candidate makes the expected header the bare string "Bearer ", which
// any client can send verbatim. A trailing comma or a stray newline in a secret would otherwise
// open the door to everyone. Driven red directly in tests/mcp-token-extra.test.ts.
//
// Fail-closed is STRUCTURAL, not a guard: with no candidates the comparison loop below never
// runs, so there is no expected value for any request to match.
//
// EXPORTED FOR TESTS, and not incidentally: a mutation pass showed that no HTTP-level
// assertion can observe whether the blank-entry filter below exists, because Headers
// normalisation strips a trailing space from `Authorization: "Bearer "` before this code
// ever sees it. The credential set is therefore asserted directly. Not re-exported from
// package.json; it is an internal seam, not public API.
export function gateCredentials(env: McpEnv): string[] {
  return gateEntries(env).map((e) => e.token);
}

/** One gate credential and the scope it holds (vivijure-cf#520's split).
 *
 *  SCOPES, and what an unscoped token gets:
 *   - MCP_TOKEN is the operator's own credential (see mcp-env.ts) and holds `operator`, as it always
 *     has in effect. It is still ONE opaque value, never split or prefix-parsed.
 *   - An MCP_TOKEN_EXTRA entry holds `consumer` unless it is written `operator:<token>`.
 *     `consumer:<token>` is accepted too, for clarity. A bare entry is CONSUMER: these are the seats
 *     issued to other clients, and the safe default is the narrower scope. Only those two exact words
 *     followed by ":" are read as a scope; anything else is the whole token.
 *  A consumer credential sees and calls consumer tools only. */
export interface GateEntry {
  token: string;
  scope: ToolScope;
}

export function gateEntries(env: McpEnv): GateEntry[] {
  const out: GateEntry[] = [];
  if (typeof env.MCP_TOKEN === "string" && env.MCP_TOKEN.trim() !== "") {
    out.push({ token: env.MCP_TOKEN, scope: "operator" });
  }
  if (typeof env.MCP_TOKEN_EXTRA === "string") {
    for (const raw of env.MCP_TOKEN_EXTRA.split(/[,\r\n]/)) {
      const entry = raw.trim();
      if (entry === "") continue;
      const m = /^(operator|consumer):(.*)$/.exec(entry);
      if (m) {
        const token = m[2].trim();
        if (token !== "") out.push({ token, scope: m[1] as ToolScope });
      } else {
        out.push({ token: entry, scope: "consumer" });
      }
    }
  }
  return out;
}

// Compare against EVERY credential and OR-accumulate, with no early return: the runtime does not
// depend on which token was presented or on how early it matched. Returns a boolean and nothing
// else -- which credential opened the gate is never returned, logged or otherwise surfaced.
export async function gateScope(auth: string, env: McpEnv): Promise<ToolScope | null> {
  let consumer = 0;
  let operator = 0;
  for (const e of gateEntries(env)) {
    const hit = (await constantTimeEqual(auth, `Bearer ${e.token}`)) ? 1 : 0;
    if (e.scope === "operator") operator |= hit;
    else consumer |= hit;
  }
  // The same token listed twice with two scopes resolves to the wider one: the operator wrote both.
  if (operator) return "operator";
  if (consumer) return "consumer";
  return null;
}

/** Whether any credential opens the gate. Async: a caller that forgets to await gets a Promise, and a
 *  Promise is truthy, so the gate below awaits gateScope() directly and never uses this. */
export async function gateOpens(auth: string, env: McpEnv): Promise<boolean> {
  return (await gateScope(auth, env)) !== null;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(status === 202 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

// Public tool list: name + description + inputSchema only (no server-side build function). A
// credential lists only the tools its scope may call.
function publicTools(scope: ToolScope) {
  return TOOLS.filter((t) => scopeAllows(t.scope, scope)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

async function handleRpc(msg: RpcMessage, env: McpEnv, scope: ToolScope): Promise<unknown> {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: (params?.protocolVersion as string | undefined) || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: publicTools(scope) });
    case "tools/call": {
      const name = params?.name as string | undefined;
      const tool = name ? TOOLS_BY_NAME.get(name) : undefined;
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      // vivijure-cf#520's split, held at the MCP: a consumer credential calls consumer tools only.
      // Refused before any argument is read or any request is built.
      if (!scopeAllows(tool.scope, scope)) {
        return rpcResult(id, { content: [{ type: "text", text: SCOPE_DENY_TEXT }], isError: true });
      }
      const args = (params?.arguments as Record<string, unknown>) || {};
      let call;
      try {
        // submit_film only. preflight drops undeclared keys and still calls (mcp#26).
        // A typo on submit_film must not ride into a render that looks successful (mcp#61).
        // start_long_film spends the same way, so a typo there is refused too.
        if (name === "submit_film" || name === "start_long_film") rejectUndeclared(tool.inputSchema, args);
        call = tool.build(args);
      } catch (err) {
        // A bad argument is DATA, not a transport error: return it as an isError tool result so the
        // agent can correct itself rather than see a JSON-RPC failure.
        return rpcResult(id, {
          content: [{ type: "text", text: `Invalid arguments for ${name}: ${String(err)}` }],
          isError: true,
        });
      }
      const result = await runTool(env, call, { inlineImages: tool.inlineImages === true, scope });
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${String(method)}`);
  }
}

export default {
  async fetch(request: Request, env: McpEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "vivijure-studio-mcp",
        version: SERVER_INFO.version,
        tools: TOOLS.length,
        targets: {
          studio: Boolean(env.STUDIO_URL && env.STUDIO_API_TOKEN),
          control_plane: Boolean(env.CONTROL_PLANE_URL && env.CONTROL_PLANE_ADMIN_TOKEN),
        },
      });
    }
    if (url.pathname !== "/mcp") return json({ error: "not_found" }, 404);

    // Bearer gate, fail closed. Machine-to-machine only. Any credential in MCP_TOKEN or
    // MCP_TOKEN_EXTRA opens it; see gateCredentials() for why blank entries are dropped.
    const auth = request.headers.get("Authorization") ?? "";
    const scope = await gateScope(auth, env);
    if (scope === null) {
      return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
    }

    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    let payload: RpcMessage | RpcMessage[];
    try {
      payload = (await request.json()) as RpcMessage | RpcMessage[];
    } catch {
      return json(rpcError(null, -32700, "Parse error"));
    }

    const hasId = (m: RpcMessage) => m.id !== undefined && m.id !== null;

    if (Array.isArray(payload)) {
      const responses: unknown[] = [];
      for (const m of payload) {
        if (hasId(m)) responses.push(await handleRpc(m, env, scope));
      }
      return responses.length ? json(responses) : json(null, 202);
    }

    // Notifications (no id) get no body, just 202 Accepted.
    if (!hasId(payload)) return json(null, 202);

    return json(await handleRpc(payload, env, scope));
  },
};
