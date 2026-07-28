# Changelog -- vivijure-mcp

`@skyphusion-labs/vivijure-mcp` publishes to npm on a `vivijure-mcp-v<X.Y.Z>` tag push; the tag
prefix is what the publish workflow matches on. The tag is the version of record. This file records
the why behind each release. Newest first.

## Unreleased

- Nothing yet.

## v1.0.1 -- 2026-07-23

- **fix(security): bounded stream read when no `Content-Length` is present (#14).** The K3 verify
  finding: reading an upstream that declares no length, without a bound, is a memory-exhaustion
  path.
- **fix(security): K3 medium and low close-out** -- timing-safe bearer comparison, and a cap on
  response size.
- **ci: adversarial security audit workflow**, plus an ancestry guard on tag and release publish
  (fc#859), so a tag that is not an ancestor of `main` cannot publish to npm.
- **docs:** `AGENTS.md` recording the Cursor Cloud dev-environment instructions, and a live-demo
  footer pointing at `demo.vivijure.com` (#6).
  (Backfilled 2026-07-28 from the commit log: this tag was cut with no release notes, and this file
  did not exist at the tag.)

## v1.0.0 -- 2026-07-15

- **`@skyphusion-labs/vivijure-mcp` 1.0.0**, aligning the studio MCP with the constellation stable
  line. Tag prefix matches the npm publish workflow.
  (Backfilled 2026-07-28 from the v1.0.0 GitHub release; this file did not exist at the tag.)

## v0.1.0 -- 2026-07-13

- **Bootstrap `@skyphusion-labs/vivijure-mcp`.** First tag on the package.
  (Backfilled 2026-07-28 from the commit log; this tag carries no release notes.)
