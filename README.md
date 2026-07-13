# @skyphusion-labs/vivijure-mcp

Stateless [Model Context Protocol](https://modelcontextprotocol.io/) server for [Vivijure Studio](https://vivijure.com).
Proxies curated tools to the studio HTTP API (`docs/CONTRACT.md` in host repos). Works against **any** studio host
(`vivijure-cf`, `vivijure-local`, or the legacy monolith) by setting `STUDIO_URL`.

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
