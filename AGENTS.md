# Vivijure MCP

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

This package is `@skyphusion-labs/vivijure-mcp`. It is the MCP door for Vivijure Studio and for the control plane.

The Worker is stateless. It proxies tools to a studio HTTP API (`STUDIO_URL`). It can also proxy admin tools to a control plane (`CONTROL_PLANE_URL`). Hosts (`vivijure-cf`, `vivijure-local`) supply wrangler and deploy config. The implementation lives here.

The tool catalog is `export const TOOLS` in `src/mcp-tools.ts`. Count the tools in that file. Do not copy a count into this guide.

Studio tools use `STUDIO_API_TOKEN`. `cp_*` tools use `CONTROL_PLANE_ADMIN_TOKEN`.

A production hostname is operator config. The package does not hard-wire one. A default self-host does not deploy MCP.

Parity notes are in [docs/PARITY.md](docs/PARITY.md).

See root `package.json`, the latest `vivijure-mcp-v*` tag, and [CHANGELOG.md](CHANGELOG.md). Do not freeze a number here.

## Relation

| Repo | Role |
|------|------|
| This package | MCP server and tool catalog |
| `vivijure-cf` / `vivijure-local` | Studio hosts; MCP calls their HTTPS API |
| `vivijure-core` | Shared orchestration |
| Studio CONTRACT | Host `docs/CONTRACT.md` |
| `vivijure-control-plane` | Optional admin target |

Module and hook types come from `@skyphusion-labs/vivijure-core`. They do not come from a host `src/modules/types.ts`.

## Docs

- [docs/mcp.md](docs/mcp.md) -- deploy, wiring, tool reference, security boundary
- [README.md](README.md) -- layout and install
- Host example: `vivijure-cf/wrangler.mcp.toml.example`

## Commands

```bash
npm run typecheck
npm test
npm run test:coverage
npm run build
```

`npm run typecheck` is the CI gate. Run it before you push. `prepublishOnly` runs typecheck, test, and build.

## Deploy

1. npm publish runs on tag `vivijure-mcp-v*` (`.github/workflows/publish-npm.yml`). The tag must match `package.json`. The commit must be on `main`. An org admin creates the tag on the release pull request merge commit.
2. The host deploys the Worker. Pin the published package. Set `main` to `node_modules/@skyphusion-labs/vivijure-mcp/dist/mcp.js`. Set secrets `MCP_TOKEN` and `STUDIO_API_TOKEN`. Set var `STUDIO_URL`.

A publish does not update a live door. The host must redeploy the Worker that imports the package.

A plain `v*` tag does not publish this package. A merge to `main` runs CI only.

## Architecture

The agent presents `MCP_TOKEN`. The Worker forwards `STUDIO_API_TOKEN`. The studio bearer does not leave the Worker.

This Worker has no D1, R2, or module binding. It uses HTTP to `STUDIO_URL` only.

The Worker holds no job. The agent calls `submit_film`, then `poll_film`.

One tool maps to one route, plus the `studio_request` escape hatch. Tests gate catalog drift against [docs/mcp.md](docs/mcp.md).

## Release

A release is a pull request that bumps `package.json` and [CHANGELOG.md](CHANGELOG.md). A feature pull request does not bump. A fix pull request does not bump. There is no direct push to `main`.

The version of record is `package.json` (and the lockfile). The tag shape is `vivijure-mcp-v*`.

Before a release pull request, check tags. If the current manifest version already has a tag, the cycle is closed, so the release pull request bumps. If it has no tag, stop. Read why before you bump again.

An org admin tags the merge commit:

```bash
sha="$(gh pr view <release-pr> --json mergeCommit -q .mergeCommit.oid)"
git tag -a vivijure-mcp-vX.Y.Z -m "vivijure-mcp vX.Y.Z" "$sha"
git push origin vivijure-mcp-vX.Y.Z
```

`publish-npm.yml` also accepts `workflow_dispatch`. It fetches `origin/main` and refuses a commit that is not on it.

Verify the live artifact: `/health`, tools/list, and a real tool call. Do not stop at green CI.

## Docs language and safety

Write Simplified Technical English. Use short sentences. Put one idea in each sentence. Use the active present tense. Use plain words. Use the same word every time.

Do not use an em dash (U+2014). Do not use an en dash (U+2013). Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability. Do not turn a measured result into a promise.

The CSAM ban includes synthetic images. Do not weaken that check.

Do not put a secret in a tracked file. Do not freeze an endpoint id in this file.
