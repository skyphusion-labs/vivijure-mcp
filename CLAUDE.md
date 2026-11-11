# CLAUDE.md

Guidance for Claude Code (and the crew) working in this repo.

## What this is

**`@skyphusion-labs/vivijure-mcp`: the Vivijure Studio + control-plane MCP door.** Stateless Model
Context Protocol Worker that proxies curated tools to a studio HTTP API (`STUDIO_URL`) and
optionally to the hosted control plane (`CONTROL_PLANE_URL`). Hosts (`vivijure-cf`,
`vivijure-local`) supply only wrangler/deploy config; implementation lives here.

- Tool catalog: `export const TOOLS` in `src/mcp-tools.ts` (**106** tools at 2.1.0; re-count from
  code if the number drifts -- do not treat this file as the ledger).
- Dual target: studio tools use `STUDIO_API_TOKEN`; `cp_*` tools use `CONTROL_PLANE_ADMIN_TOKEN`.
- Prod door example: `studio-mcp.vivijure.com` (operator-configured; not hard-wired in the package).
- Opt-in: a default self-host does **not** deploy MCP.
- Parity honesty: `docs/PARITY.md` (owner provision stays session-based; some render doors
  uncurated per cf#334).

Version: see root `package.json` / latest `vivijure-mcp-v*` tag / `CHANGELOG.md` (**2.1.0** train).

## Relation to the constellation

| Repo | Role |
|------|------|
| **This package** | MCP server + tool catalog (npm + Worker entry) |
| `vivijure-cf` / `vivijure-local` | Studio hosts; MCP points at their HTTPS API |
| `vivijure-core` | Shared orchestration; hosts implement CONTRACT |
| Studio CONTRACT | Host `docs/CONTRACT.md` (wire shapes tools map to) |
| `vivijure-control-plane` | Hosted multi-tenant plane; optional MCP target for admin ops |

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
   `package.json` and be an ancestor of `main`; an org admin creates it on the release PR's merge
   commit (see "Release / deploy").
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

Crew: `sudo -n -H -u <member> bash -lc '...'`; commits under `skyphusion-<member>`. Conrad on laptop only
as `Conrad Rockenhaus <conrad@skyphusion.org>`. Conventional Commits. The package is on the 2.x line (`package.json` is 2.1.0).

## Release / deploy

A release is a PR that bumps `package.json` and the CHANGELOG, merged through the normal gate; no
direct push to `main`. Then an org admin (the lead or Conrad; crew cannot create release tags)
tags that PR's MERGE COMMIT:

```bash
sha="$(gh pr view <release-pr> --json mergeCommit -q .mergeCommit.oid)"
git tag -a vivijure-mcp-vX.Y.Z -m "vivijure-mcp vX.Y.Z" "$sha"
git push origin vivijure-mcp-vX.Y.Z
```

**npm publish is `vivijure-mcp-v*` or a manual `workflow_dispatch`** (`.github/workflows/publish-npm.yml`).
A tag must match `package.json`. The workflow fetches `origin/main` and refuses a commit that is not
on it. A plain `v*` tag does not publish this package. Merges to `main` run CI only. The Worker that
imports the package is deployed by the host, not by this workflow.

## Release convention (bump-at-release)

One convention for every skyphusion-labs repo (Conrad, ruled 2026-11-10, fleet-chezmoi#1766). A version moves ONLY in a release PR: bump the version, then assemble the changelog. Feature and fix PRs do not bump. Releases go through a PR (fleet-chezmoi#1622) and the tag goes on that PR's merge commit.

- Version of record here: package.json (and package-lock.json).
- Tag shape: `vivijure-mcp-v*`.
- Check before a release PR: does a tag already exist for the version currently in the manifest? Yes means the cycle is closed, so the release PR bumps. No means a bump already landed outside a release PR; stop and read why before bumping again.
