# Changelog -- vivijure-mcp

`@skyphusion-labs/vivijure-mcp` publishes to npm on a `vivijure-mcp-v<X.Y.Z>` tag push; the tag
prefix is what the publish workflow matches on. The tag is the version of record. This file records
the why behind each release. Newest first.

## Unreleased

- **feat(mcp): `MCP_TOKEN_EXTRA`, an additive second gate secret.** The gate now accepts `MCP_TOKEN`
  OR any entry in `MCP_TOKEN_EXTRA` (comma- and/or newline-separated), so a new client can be issued
  its own credential without rewriting the operator's `MCP_TOKEN`. Worker secrets are write-only, so
  widening access by rewriting `MCP_TOKEN` means re-supplying the operator's own token from memory
  and one typo silently 401s the operator. Blank entries are dropped: `"tok,"` splits to
  `["tok", ""]`, and an empty credential would make the expected header the bare string `"Bearer "`.
  Fail-closed is unchanged and structural (no gate credential anywhere => every request refused);
  every candidate is compared with no early return, so the runtime does not reveal which token
  matched, and the Worker never records or returns which one opened the gate. `MCP_TOKEN` itself is
  never split and never trimmed, so a token containing a separator keeps working exactly as before.
  BEHAVIOUR CHANGE, one case only: a whitespace-only `MCP_TOKEN` used to admit a client sending the
  matching all-space bearer and now yields no credential at all.
- **docs:** full README front door; complete 1.3 tool reference (settings, demo, control plane);
  control-plane deploy section, hosted ops walkthrough, expanded troubleshooting; PARITY cross-link.

## v1.3.0 -- 2026-08-07

MINOR, additive: **studio panel parity tools + hosted control-plane admin tools** (42 -> 109).

- **feat(mcp): dual target.** `CONTROL_PLANE_URL` + `CONTROL_PLANE_ADMIN_TOKEN` optional bindings;
  `StudioCall.target` selects studio vs control plane; `/health` reports which targets are armed.
  Studio tools still work with only `STUDIO_*` configured.
- **feat(mcp): studio panel gaps.** prefs, whoami, storage usage/reconcile, module install/config,
  Wan cast LoRA train, cast import/export, score-bed + job poll, enhance/yaml/markers/analyze,
  render-plan, clips submit/poll, frames, demo suite, list_models.
- **feat(mcp): control-plane operator surface (`cp_*`).** Tenant census, upgrade studio/modules,
  refresh bindings, invoke-key handoff, reprovision RunPod, smoke render, suspend/resume/teardown,
  credits, preservation holds, metering, KEK, operators, settings, audit, hosted storage usage,
  plus `control_plane_request` escape hatch.
- **docs:** `docs/PARITY.md` honesty matrix (owner provision stays session-based; storyboard/render
  alternate doors remain uncurated per cf#334).
- **Still deliberate gaps:** `POST /api/tenant/provision` (owner session + AUP + key custody, not
  admin bearer); `/api/storyboard/render*` / finalize / animate / scatter / regen curated block
  until sound-door reconciliation (escape hatch only).

- **docs(mcp): honest `preflight` schema (mcp#26).** Dropped `bundleKey` / `audioKey` (route never
  reads them; advertising them was false confidence). Added `motionBackend` + `quality` so the
  duration-grid clamp (#707/#751) is drivable from MCP.

## v1.2.1 -- 2026-08-03

- **fix(mcp): expose `keyframe_backend` + `qualityTier` on `submit_film` (vivijure-cf#380, vivijure-cf#382, mcp#26).** Both route params existed on `POST /api/render/film` with no schema entry, so an omitted value resolved to a confident-looking wrong default instead of erroring: `keyframe_backend` fell through to `serving[0]` (the local-gpu door, live projection order), and `qualityTier` recorded `"final"` on every MCP-submitted film regardless of what ran. Mirrors `motion_backend`'s existing style; the studio-side `?? "final"` default is unchanged (out of scope, see cf#382).

## v1.2.0 -- 2026-08-02

MINOR, additive: **21 new tools** (21 -> 42), closing the cf#317 parity gap for everything that does
not touch the render door. An agent can now create a project, save a storyboard, set a character up
end to end, bring in its own image or audio bytes, organize the render library, and finish a
completed film -- all things a human could already do in the panel and an agent could not.

**Deliberately NOT in this release: render submit, poll and cancel.** vivijure-cf#334 found that the
studio's render doors disagree about whether a film has sound, and curated tools built on either door
would bless that divergence permanently. A test asserts no curated tool aims at a blocked render
route; it is written to be deleted when that reconciliation lands.

**One correction to the measurement this lane published.** The cf#317 enumeration reported "panel
routes unreachable by any MCP means: 0". It was 3: the studio's upload routes read a RAW body and
`studio_request` sends `application/json`, so route REACH was measured and body ENCODING never was.
The error ran in the flattering direction, which is why nothing downstream would have surfaced it.

- **feat(mcp): cast and identity, ten tools (cf#317).** Identity is step one of driving a film and an
  agent could only create, read and rename a cast member. It could not add or remove a training
  reference, add or remove a source photo, ask the studio to generate a reference set, train the
  identity LoRA, read the training state, clear a portrait, or delete a member. `delete_cast`,
  `clear_cast_portrait`, `add_cast_ref`, `remove_cast_ref`, `add_cast_source`, `remove_cast_source`,
  `generate_cast_refs`, `poll_cast_refs`, `train_cast_lora`, `cast_lora_status`.
- **The two key-removal routes are PATH-shaped, and that is forced, not preferred.** The studio also
  accepts the key in a JSON body, but `runTool` never sends a body on a `DELETE`, so that form is
  unreachable from this MCP. `DELETE /api/cast/:id/refs/*refKey` and its source sibling are the only
  reachable form, and both were absent from `CONTRACT.md` -- the escape hatch could not have been
  pointed at them either.
- **fix(docs/tool): `set_cast_portrait` described a chat-only path that was never the constraint.**
  `from_chat_artifact` copies from ANY studio artifact key. Meanwhile the sibling `{ key, mime }`
  form is NARROWER than CONTRACT.md 2.7 says: it requires a key already staged under
  `cast/<internal id>/`, so a general staged key is refused. Both facts now sit in the tool
  description, where an agent reads them.
- **feat(mcp): project and render-library WRITE, plus the two door-independent finishing routes
  (cf#317).** An agent could list and read projects and renders and could not create, save, organize
  or delete one. Nine tools: `create_project`, `save_storyboard`, `update_project`, `delete_project`,
  `render_tags`, `update_render`, `delete_render`, `add_render_audio`, `add_render_narration`.
  - **`save_storyboard` closes a promise the read side was already making.** `get_project`'s own
    description says it returns the project "incl. its last saved storyboard" while nothing in the
    catalog could save one, so an agent could plan and refine a storyboard and never persist it.
  - **`update_project` documents the studio's either/or.** If `storyboard` is present the route
    ignores `name` and `prefs` in the same call, silently. An agent that does not know that loses the
    rename and gets a `200`, so the trap is stated in the tool description where the agent reads it.
  - **The render-door line is asserted, not remembered.** A test scans every curated tool's emitted
    path and fails if one aims at a render submit / poll / cancel route (cf#334). It is expected to be
    deleted when that reconciliation lands; until then it is what stops the divergence being blessed
    by 29 new tools.
- **fix(mcp): `list_renders` published the wrong default.** Both its description and its schema said
  "default 100"; the studio's `DEFAULT_RENDERS_LIMIT` is **50** and `CONTRACT.md` 2.25 says 50. An
  agent sizing a page from the tool description was reasoning about a number the studio does not use.
- **feat(mcp): `upload_image` and `upload_audio` -- bytes IN (cf#317).** The studio's upload routes
  read a **raw** request body and dispatch on the content-type header, and every path through
  `runTool` sent `application/json`. So `POST /api/upload`, `POST /api/storyboard/audio-upload` and
  `POST /api/storyboard/character-ref` were **not reachable by any MCP means** -- `studio_request`
  looked like the answer and answered `400` on the content-type before reading anything else. An
  agent could generate an image with `chat` and could not bring one in, and could not bring in audio
  at all. That gap is asserted by a test against the shipped `studio_request`, not described.
  - `upload_image` -> `POST /api/upload`; `upload_audio` -> `POST /api/storyboard/audio-upload`.
    Both take `data_base64` + `mime` and return the studio's `{ key, mime, size }`.
  - **This reverses a stated design position.** `docs/mcp.md` said *"No binary uploads either ...
    nothing is ever base64-smuggled through a tool call."* That was true of the PROTOCOL for
    responses and never true of requests, and it is reversed here under the cf#317 ruling that an
    agent must reach what a human can. The bound it was protecting is kept: exactly two named tools,
    one transport ceiling, and `studio_request` still cannot send bytes.
  - A `data:` URL prefix is **refused, not stripped** -- the payload's declared type and the `mime`
    argument can disagree, and the studio persists the content-type we send, so quietly preferring
    either would write a wrong type onto the object.
  - The 32 MB ceiling is labelled as **this MCP's transport limit, not the studio's rule**. Each
    route enforces its own cap and answers `400` with its real number; copying those numbers here
    would be a hand-maintained duplicate of a server-side rule.
- **`StudioCall` now carries an optional `rawBody`, exclusive with `body` BY TYPE.** A build() that
  set both does not compile (proven by a negative control run against the compiler), so "which body
  wins" is not a rule a future tool can forget.
- **fix(docs): `docs/mcp.md` carried two disagreeing tool counts** -- "all 19 tools" in the contents
  list and "Twenty-one tools" in the reference heading, in the same file, neither matching the
  catalog. Both hand-maintained. There is now ONE count, and `tests/docs-tool-catalog.test.ts`
  derives it from `TOOLS` along with the group count and the presence of every tool name, so the
  reference cannot drift from the catalog silently. Watched failing on a wrong count before it was
  trusted.

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

- **fix: the wire-visible version was wrong, and had been since v1.0.0.** `serverInfo.version` in the
  MCP `initialize` reply is the ONLY version an MCP client can read off the wire, and it was
  hardcoded `0.1.0` through v1.0.0 and v1.0.1 while `package.json` said otherwise. It now reads
  `1.1.0`, so all three locations agree for the first time since v0.1.0. This sat directly on this
  release's own thesis: an agent probing `serverInfo.version` to decide whether `view_artifact`
  exists would have got the same answer before and after the release that added it. Guarded by
  `tests/server-info-version.test.ts`, which fails if the literal and `package.json` ever disagree,
  and which was **watched failing** on the reintroduced `0.1.0` before being trusted. Not derived
  from `package.json` directly, because that needs a JSON import in the Worker bundle; that is a
  build question and deliberately not scoped into a release.
- **fix: lockfile drift.** v1.0.1 shipped with `package-lock.json` still at `1.0.0`. This is the
  first release since v1.0.0 where the lockfile and `package.json` agree.

**One type-level caveat, deliberately NOT treated as MAJOR.** `runTool`'s return type widened from
`{ type: "text"; text: string }[]` to `McpContent[]`, and `./mcp-tools` is a public subpath export, so
a TypeScript consumer reading `result.content[0].text` compiles under 1.0.1 and does not under 1.1.0.
Checked rather than assumed: the one known consumer, `vivijure-cf`, reaches this package through the
built Worker entry (`main` in `wrangler.mcp.toml.example`) and never touches `runTool`'s type, so
nothing real breaks. Recorded here rather than left silent so a reader does not later find it and
conclude a MAJOR was missed.

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
