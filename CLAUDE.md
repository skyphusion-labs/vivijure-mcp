# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this is

**`@skyphusion-labs/vivijure-mcp`: the Vivijure Studio MCP door.** Stateless Model Context Protocol
Worker that proxies curated tools to a studio HTTP API (`STUDIO_URL`). Hosts
(`vivijure-cf`, `vivijure-local`) supply only wrangler/deploy config; implementation lives here.

- Tool catalog: `export const TOOLS` in `src/mcp-tools.ts` (**42** tools at last count; re-count from
  code if the number drifts -- do not treat this file as the ledger).
- Prod door example: `studio-mcp.vivijure.com` (operator-configured; not hard-wired in the package).
- Opt-in: a default self-host does **not** deploy MCP.

Version: see root `package.json` / latest `vivijure-mcp-v*` tag / `CHANGELOG.md`.

## Relation to the constellation

| Repo | Role |
|------|------|
| **This package** | MCP server + tool catalog (npm + Worker entry) |
| `vivijure-cf` / `vivijure-local` | Studio hosts; MCP points at their HTTPS API |
| `vivijure-core` | Shared orchestration; hosts implement CONTRACT |
| Studio CONTRACT | Host `docs/CONTRACT.md` (wire shapes tools map to) |
| `vivijure-control-plane` | Hosted multi-tenant plane (not required for MCP) |

Module / hook types for studio work come from **`@skyphusion-labs/vivijure-core`**, not host
`src/modules/types.ts`.

## Documentation map

- `docs/mcp.md` -- deploy, agent wiring, full tool reference, security boundary
- `README.md` -- package layout + install
- Host examples: `vivijure-cf/wrangler.mcp.toml.example` (and local equivalent)

## Commands

```bash
npm run typecheck       # tsc --noEmit -- CI gate; run before push
npm test                # vitest run
npm run test:coverage   # vitest + coverage
npm run build           # tsc -p tsconfig.build.json -> dist/
```

`prepublishOnly` runs typecheck + test + build.

## Deploy model

1. **npm publish** on tag `vivijure-mcp-v*` (see `.github/workflows/publish-npm.yml`). Tag must match
   `package.json` and be an ancestor of `main`.
2. **Worker deploy** is host-side: pin the published package, set `main` to
   `node_modules/@skyphusion-labs/vivijure-mcp/dist/mcp.js`, secrets `MCP_TOKEN` + `STUDIO_API_TOKEN`,
   var `STUDIO_URL`. Host CI may deploy MCP on studio `v*` when `MCP_HOST` / `MCP_STUDIO_URL` are set.

Publishing is necessary and not sufficient for a live door: hosts must redeploy the Worker that
imports the package.

## Architecture (load-bearing)

- **Two credentials.** Agent presents `MCP_TOKEN`; Worker forwards `STUDIO_API_TOKEN`. Studio bearer
  never leaves the Worker.
- **No studio bindings.** No D1/R2/module bindings; pure HTTP to `STUDIO_URL`.
- **Stateless.** Renders are agent-driven (`submit_film` then `poll_film`); Worker holds no job state.
- **One tool, one route** (plus `studio_request` escape hatch). Catalog drift is gated by tests
  against `docs/mcp.md`.

## Hard rules

- **CSAM bright-line (NON-NEGOTIABLE):** zero tolerance including synthetic.
- **Typecheck is the CI gate.** Run `npm run typecheck` before push.
- **Verify the artifact** (live `/health`, tools/list, a real tool call), not only green CI.
- **Ignore Cursor `AGENTS.md`** if present.
- **No em-dashes / en-dashes.** Use `--` or commas.
- **Never freeze endpoint IDs or open sprint boards** in this file.
- **Never a plaintext secret in a tracked file.**

## Crew + identity

Crew: `sudo -u <member> bash -lc '...'`; commits under `skyphusion-<member>`. Conrad on laptop only
as `Conrad Rockenhaus <conrad@skyphusion.org>`. Conventional Commits; SemVer on the package 1.x line.

## Release / deploy

**Tag-gated production deploy.** Merges to `main` run CI only; they do not ship production.
Cut an annotated SemVer tag on `main` to release (`git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`).
Deploy workflows assert the tag commit is an ancestor of `origin/main`.
