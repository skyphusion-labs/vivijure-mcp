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
import { TOOLS, TOOLS_BY_NAME, runTool } from "./mcp-tools.js";

// KEEP IN SYNC WITH package.json "version". This is the ONLY version an MCP client can read off the
// wire (`serverInfo` in the initialize reply), and it sat at 0.1.0 from v1.0.0 through v1.0.1 while
// package.json said otherwise -- so an agent probing serverInfo.version to decide whether a tool
// exists got the same answer before and after a release that added one. It is not derived from
// package.json because that would need a JSON import in the Worker bundle; the drift is prevented by
// tests/server-info-version.test.ts instead, which fails if these two ever disagree.
const SERVER_INFO = { name: "vivijure-studio", version: "1.3.0" };
const PROTOCOL_VERSION = "2025-06-18";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    let pad = 0;
    for (let i = 0; i < a.length; i++) pad |= a.charCodeAt(i) ^ a.charCodeAt(i);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
  const out: string[] = [];
  if (typeof env.MCP_TOKEN === "string" && env.MCP_TOKEN.trim() !== "") out.push(env.MCP_TOKEN);
  if (typeof env.MCP_TOKEN_EXTRA === "string") {
    for (const raw of env.MCP_TOKEN_EXTRA.split(/[,\r\n]/)) {
      const entry = raw.trim();
      if (entry !== "") out.push(entry);
    }
  }
  return out;
}

// Compare against EVERY credential and OR-accumulate, with no early return: the runtime does not
// depend on which token was presented or on how early it matched. Returns a boolean and nothing
// else -- which credential opened the gate is never returned, logged or otherwise surfaced.
export function gateOpens(auth: string, env: McpEnv): boolean {
  let opened = 0;
  for (const token of gateCredentials(env)) {
    opened |= timingSafeEqual(auth, `Bearer ${token}`) ? 1 : 0;
  }
  return opened !== 0;
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

// Public tool list: name + description + inputSchema only (no server-side build function).
const PUBLIC_TOOLS = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

async function handleRpc(msg: RpcMessage, env: McpEnv): Promise<unknown> {
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
      return rpcResult(id, { tools: PUBLIC_TOOLS });
    case "tools/call": {
      const name = params?.name as string | undefined;
      const tool = name ? TOOLS_BY_NAME.get(name) : undefined;
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      const args = (params?.arguments as Record<string, unknown>) || {};
      let call;
      try {
        call = tool.build(args);
      } catch (err) {
        // A bad argument is DATA, not a transport error: return it as an isError tool result so the
        // agent can correct itself rather than see a JSON-RPC failure.
        return rpcResult(id, {
          content: [{ type: "text", text: `Invalid arguments for ${name}: ${String(err)}` }],
          isError: true,
        });
      }
      const result = await runTool(env, call, { inlineImages: tool.inlineImages === true });
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
    if (!gateOpens(auth, env)) {
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
        if (hasId(m)) responses.push(await handleRpc(m, env));
      }
      return responses.length ? json(responses) : json(null, 202);
    }

    // Notifications (no id) get no body, just 202 Accepted.
    if (!hasId(payload)) return json(null, 202);

    return json(await handleRpc(payload, env));
  },
};
