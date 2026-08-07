# @skyphusion-labs/vivijure-mcp

**Agent MCP for [Vivijure Studio](https://vivijure.com)** -- drive the film studio from Claude, Cursor,
or any MCP client. Stateless [Model Context Protocol](https://modelcontextprotocol.io/) server that
proxies curated tools to the studio HTTP API (`docs/CONTRACT.md` in host repos), and optionally to
the hosted **control plane** admin API (tenant upgrade, smoke render, suspend, credits, …).

Works against **both studio hosts**
([`vivijure-cf`](https://github.com/skyphusion-labs/vivijure-cf) on Cloudflare, or
[`vivijure-local`](https://github.com/skyphusion-labs/vivijure-local) on a home PC / any cloud server)
by setting `STUDIO_URL`. Optional `CONTROL_PLANE_URL` + `CONTROL_PLANE_ADMIN_TOKEN` enable `cp_*`
operator tools against
[`vivijure-control-plane`](https://github.com/skyphusion-labs/vivijure-control-plane). Shared
orchestration for studio hosts lives in
[`vivijure-core`](https://github.com/skyphusion-labs/vivijure-core).

Parity matrix: [docs/PARITY.md](docs/PARITY.md).

**Vivijure Studio:** https://vivijure.com · **Live demo:** https://demo.vivijure.com · **Skyphusion Labs:** https://skyphusion.org

## Install

```bash
npm install @skyphusion-labs/vivijure-mcp
```

## Deploy (Cloudflare Workers)

Host repos ship `wrangler.mcp.toml.example`. Entry:

```toml
main = "node_modules/@skyphusion-labs/vivijure-mcp/dist/mcp.js"
```

See [docs/mcp.md](docs/mcp.md) for secrets, agent wiring, and the full tool catalog.

## Package layout

| Import | Role |
|--------|------|
| `@skyphusion-labs/vivijure-mcp` | Default Worker export (`fetch` handler) |
| `@skyphusion-labs/vivijure-mcp/mcp-env` | `McpEnv` bindings |
| `@skyphusion-labs/vivijure-mcp/mcp-tools` | Tool catalog + `runTool` |

## License

AGPL-3.0-only
