# Changelog -- vivijure-mcp

`@skyphusion-labs/vivijure-mcp` publishes to npm on a `vivijure-mcp-v<X.Y.Z>` tag push; the tag
prefix is what the publish workflow matches on. The tag is the version of record. This file records
the why behind each release. Newest first.

## Unreleased

- Nothing yet.

## v1.1.0 -- 2026-08-02

MINOR, additive: two new tools. An agent can now SEE what the studio made, instead of being told its
byte count.

- **feat(mcp): `view_artifact` and `artifact_url` (#19, cf#317).** Every artifact route used to come
  back as a summary line, **including images**, which MCP carries natively. That refusal was ours
  rather than the protocol's, so an agent could plan a film, cast it, submit it, watch it complete,
  and then have no way to look at what it made.
  - `view_artifact` (`GET /api/artifact/<key>`) returns an image as an **MCP image block**. Capped at
    4 MB and **refused honestly above that rather than truncated**, because a silently shortened
    image is a wrong answer that looks like an answer.
  - `artifact_url` (`GET /api/artifact-url/<key>`) returns a short-lived presigned link plus the real
    content type and size, for what MCP structurally cannot carry. This is how a finished film gets
    watched: the link opens in a browser with no studio credential attached.
- **Image inlining is opt-in per tool** (`McpTool.inlineImages`), not a change to `runTool`'s
  default. `studio_request` keeps summarizing everything binary, deliberately, because a default-on
  version would push megabytes through the transport on any stray artifact call. That negative is
  **asserted by a test**, not assumed.
- Keys are validated in `build()` before any request leaves the Worker (traversal, absolute path,
  scheme), and each segment is percent-encoded so a key containing a space survives the URL while the
  slashes that make it a path are preserved.

**Why this is a separate release rather than part of #19.** #19 merged without a version bump, so for
four commits there was no version number that could ever deliver the feature: `main` still declared
`1.0.1`, which is exactly what npm already had. The code being on `main` is not the same as the code
being reachable, and a consumer resolving `^1.0.1` had no way to tell the difference. Found while
scoping cf#278 phase 1, measured two independent ways (the resolved lockfile tarball contained no
`view_artifact`, and the deployed Worker answered with the OLD tool-summary wording on the wire).

**Coupling, stated plainly.** `artifact_url` depends on `GET /api/artifact-url` in **vivijure-cf**,
which shipped in cf **v1.16.0** and is live and smoked. Against an older studio the tool returns a
`404` **as data**, which is the honest answer rather than a broken link. `view_artifact` needs no
studio change at all. Consumers still have to bump their dependency: this package reaches the
deployed Worker through npm, so publishing is necessary and not sufficient.

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
