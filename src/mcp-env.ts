// Env binding for @skyphusion-labs/vivijure-mcp.
//
// Hosts deploy this as a separate Worker (vivijure-cf / vivijure-local wrangler.mcp.toml).
// Optional control-plane bindings let the same Worker drive hosted-platform admin ops
// (vivijure-control-plane /api/admin/*) without mixing credentials into the studio token.

export interface McpEnv {
  // The studio base URL the MCP proxies to, e.g. "https://vivijure.skyphusion.org". A [vars] entry
  // (not a secret): it is a public hostname. No trailing slash is required; the proxy normalizes it.
  STUDIO_URL?: string;

  // The studio bearer (vivijure #423 token-mode STUDIO_API_TOKEN). Sent as `Authorization: Bearer`
  // on every proxied studio call. A worker SECRET, seeded out-of-band
  // (wrangler secret put STUDIO_API_TOKEN -c wrangler.mcp.toml); never a var, never in CI. When
  // unset, studio-target tools fail closed (control-plane tools may still run if configured).
  STUDIO_API_TOKEN?: string;

  // Optional hosted control plane base URL, e.g. "https://studio.vivijure.com". [vars], public.
  // When set with CONTROL_PLANE_ADMIN_TOKEN, cp_* tools and control_plane_request are live.
  CONTROL_PLANE_URL?: string;

  // Operator/admin bearer for vivijure-control-plane `/api/admin/*` (CONTROL_PLANE_ADMIN_TOKEN or a
  // scoped opc_ credential). SECRET. Distinct from STUDIO_API_TOKEN and MCP_TOKEN. Never used on
  // studio routes. Unset => control-plane tools fail closed.
  CONTROL_PLANE_ADMIN_TOKEN?: string;

  // The MCP gate. Every /mcp request must present `Authorization: Bearer <MCP_TOKEN>`. A worker
  // SECRET. When unset the Worker refuses all requests (fail closed). Machine-to-machine only:
  // this is a DISTINCT credential from STUDIO_API_TOKEN so an MCP client never learns the studio
  // bearer, and the two can be rotated independently.
  MCP_TOKEN?: string;
}
