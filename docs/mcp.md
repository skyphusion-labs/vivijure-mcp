# Vivijure Studio MCP

> **Package vs host:** this npm package is the MCP Worker source. Deploy scripts, wrangler templates,
> and studio runbooks (`deploy:mcp`, `DEPLOYMENT.md`, `quickstart.md`) live in the **studio host**
> (`vivijure-cf` or `vivijure-local`), not in this repo.


Drive your Vivijure studio from an AI agent (Claude Code, Cursor, or any Model Context Protocol
client) instead of raw `curl` or the browser. Implementation lives in **`@skyphusion-labs/vivijure-mcp`**
(`src/mcp.ts`). Host repos (`vivijure-cf`, `vivijure-local`) supply only wrangler/deploy config.

It is **opt-in and off by default.** A default self-host does not deploy it. If you never point an
agent at your studio, you can skip this page entirely.

This page is written so you can go from a working studio to a working agent connection using only
what is written here. If a step does not work, see [Troubleshooting](#troubleshooting) at the bottom.

## Contents

- [Why a separate Worker](#why-a-separate-worker)
- [Before you start](#before-you-start)
- [Deploy the MCP Worker](#deploy-the-mcp-worker)
- [Optional: control plane target](#optional-control-plane-target)
- [Check that it works](#check-that-it-works)
- [Connect your agent](#connect-your-agent)
- [How tool calls behave](#how-tool-calls-behave)
- [Tool reference](#tool-reference) (every tool, with arguments)
- [A render, end to end](#a-render-end-to-end)
- [Hosted tenant ops, end to end](#hosted-tenant-ops-end-to-end)
- [Security boundary](#security-boundary)
- [Troubleshooting](#troubleshooting)
- [Parity](#parity)
- [Files](#files)

## Why a separate Worker

- **Two credentials, two surfaces.** The agent presents `MCP_TOKEN` to the MCP; the studio bearer
  (`STUDIO_API_TOKEN`) never leaves the Worker. You can rotate either one without touching the other.
- **No studio bindings.** The MCP holds no D1, R2, or module bindings. It reaches the studio purely
  over HTTP at `STUDIO_URL`, so it can point at any instance: your self-hosted studio, or one running
  somewhere else.
- **Stateless.** Long-running renders are agent-driven: `submit_film` returns a job id, then the
  agent calls `poll_film` until the `phase` is `done` (a presigned `download_url` appears) or
  `failed`. The Worker holds no job state and never long-polls.

```mermaid
flowchart LR
  Agent["Agent (Cursor / Claude Code)"] -->|"POST /mcp  Bearer MCP_TOKEN"| MCP["vivijure-studio-mcp"]
  MCP -->|"Bearer STUDIO_API_TOKEN"| Studio["Studio core (STUDIO_URL)"]
  MCP -->|"Bearer CONTROL_PLANE_ADMIN_TOKEN"| CP["Control plane (optional)"]
  Studio -->|"download_url (presigned 6h)"| Agent
```

## Before you start

You need:

1. **A deployed studio** reachable over HTTPS (see [DEPLOYMENT.md](DEPLOYMENT.md) or
   [quickstart.md](quickstart.md)), running in token mode (`AUTH_MODE=token`, the default).
2. **A studio API token for the MCP to use.** Best practice is a **named consumer token**, not the
   operator token, per the per-function-keys rule: if it ever leaks you revoke one consumer, and
   MCP-driven requests show up in observability as `api-token:studio-mcp` instead of blending into
   operator traffic. Mint one on the studio side:

   ```sh
   scripts/studio-consumer-token.sh mint studio-mcp
   ```

   This inserts only the token's SHA-256 hash into the studio's D1 `api_tokens` table and writes the
   plaintext to a local `chmod 600` file exactly once. That value is what you will seed as the MCP
   Worker's `STUDIO_API_TOKEN` secret in the next section (the secret NAME on the MCP Worker is
   always `STUDIO_API_TOKEN`, whatever class of studio token you put in it). Reusing the operator
   token works too; it is just worse hygiene. Details: [SECURITY.md](SECURITY.md) section 1b.
3. **A custom domain** for the MCP host (for example `studio-mcp.example.com`) on the same
   Cloudflare zone. `workers.dev` is deliberately disabled in the example config.
4. `wrangler` authenticated against your Cloudflare account (the same setup the studio deploy uses).

## Deploy the MCP Worker

The Worker reads these values:

| Value | Kind | What it is |
|-------|------|------------|
| `STUDIO_URL` | var (in `wrangler.mcp.toml`) | The base URL of your studio, e.g. `https://studio.example.com`. No trailing slash needed (it is normalized). |
| `STUDIO_API_TOKEN` | secret | The studio bearer the MCP presents on every forwarded call (the named consumer token from above). |
| `MCP_TOKEN` | secret | The gate. Every agent request must carry `Authorization: Bearer <MCP_TOKEN>`. Treated as ONE opaque value: never split, never trimmed. |
| `MCP_TOKEN_EXTRA` | secret (optional) | ADDITIVE further gate tokens, comma- and/or newline-separated. Any entry opens the gate exactly like `MCP_TOKEN`. Issue a second client its own credential here so `MCP_TOKEN` is never rewritten. Blank entries (a trailing comma, a stray newline) are dropped. |
| `CONTROL_PLANE_URL` | var (optional) | Hosted control plane base, e.g. `https://studio.vivijure.com`. Enables `cp_*` tools. |
| `CONTROL_PLANE_ADMIN_TOKEN` | secret (optional) | Admin/operator bearer for `/api/admin/*`. Distinct from the studio token. |

Studio + MCP gate secrets are seeded once, out-of-band, never in CI. Control-plane secrets are
optional (see [Optional: control plane target](#optional-control-plane-target)).

```sh
# 1. Render wrangler.mcp.toml from the committed example (host + studio URL), or copy the example
#    and fill the two ${...} placeholders by hand.
MCP_HOST="studio-mcp.example.com" MCP_STUDIO_URL="https://studio.example.com" \
  envsubst '$MCP_HOST $MCP_STUDIO_URL' < wrangler.mcp.toml.example > wrangler.mcp.toml

# 2. Deploy the Worker.
npm run deploy:mcp

# 3. Seed the studio bearer (the named consumer token minted in "Before you start").
wrangler secret put STUDIO_API_TOKEN -c wrangler.mcp.toml

# 4. Mint + set the MCP gate token (keep a chmod 600 copy to wire clients with; delete it once
#    your client config holds it).
umask 077 && openssl rand -hex 32 > mcp-token.txt
wrangler secret put MCP_TOKEN -c wrangler.mcp.toml < mcp-token.txt

# 5. OPTIONAL: issue a SECOND client its own gate token without touching MCP_TOKEN.
#    Worker secrets are write-only, so widening access by rewriting MCP_TOKEN means re-supplying
#    your own token from memory and one typo silently 401s you. Put additional tokens here instead;
#    any entry opens the gate exactly like MCP_TOKEN, and MCP_TOKEN is never rewritten.
#    Comma- and/or newline-separated. This secret REPLACES its previous value on every put, so
#    re-supply the full list of extra tokens each time (that list never contains MCP_TOKEN).
umask 077 && openssl rand -hex 32 > mcp-token-crew.txt
printf '%s' "$(cat mcp-token-crew.txt)" | wrangler secret put MCP_TOKEN_EXTRA -c wrangler.mcp.toml
```

To revoke one extra client, re-put `MCP_TOKEN_EXTRA` without its entry; to revoke all of them, put
an empty value (the Worker then falls back to `MCP_TOKEN` alone). Revoking `MCP_TOKEN` itself is
still a `wrangler secret put MCP_TOKEN`. With NO gate token anywhere -- neither secret set, or both
empty once blank entries are dropped -- the Worker refuses every request; it never opens up.

**The CI path (this repo's tag-gated deploy):** the MCP deploys as the last step of a `v*` tag
deploy ONLY when both `MCP_HOST` and `MCP_STUDIO_URL` repo **variables** are set; when they are not,
the step is a clean no-op, so a fork that never opts in never deploys it. The two secrets are never
set in CI; seed them once with steps 3 and 4 above and they survive redeploys.

**Local dev:** `npm run dev:mcp` runs the Worker under `wrangler dev` against whatever
`STUDIO_URL` your rendered `wrangler.mcp.toml` points at.

## Optional: control plane target

For **hosted** multi-tenant ops (upgrade a tenant studio, smoke render, suspend, credits), the same
MCP Worker can forward to [vivijure-control-plane](https://github.com/skyphusion-labs/vivijure-control-plane).

1. Add to `[vars]` in `wrangler.mcp.toml`:

   ```toml
   CONTROL_PLANE_URL = "https://studio.vivijure.com"
   ```

2. Seed an operator credential (prefer a **scoped** `opc_…` token from
   `POST /api/admin/operators`, not the root `CONTROL_PLANE_ADMIN_TOKEN`, when possible):

   ```sh
   wrangler secret put CONTROL_PLANE_ADMIN_TOKEN -c wrangler.mcp.toml
   ```

3. Redeploy. `/health` should show `targets.control_plane: true`.

Self-host / local-only operators **omit** both bindings. Studio tools keep working; `cp_*` tools
fail closed with a clear configuration error.

**Owner provision** (`POST /api/tenant/provision`) still requires a human (or session-capable
client) on the front door: magic link / OAuth, AUP acceptance, and RunPod key custody. Admin MCP
tools operate **after** a tenant row exists. See [PARITY.md](PARITY.md).

## Check that it works

Two checks, no MCP client needed. First the open health route:

```sh
curl -s https://studio-mcp.example.com/health
# {"ok":true,"service":"vivijure-studio-mcp"}
```

Then an authenticated `tools/list` (this proves the gate and the JSON-RPC transport):

```sh
curl -s https://studio-mcp.example.com/mcp \
  -H "Authorization: Bearer $(cat mcp-token.txt)" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should get a JSON-RPC result listing all 109 tools. The same request **without** the header must
return `401` -- if it does not, stop and check your `MCP_TOKEN` seeding before wiring any client.

Note the split: a missing or wrong `MCP_TOKEN` fails at the door (`401`), but a missing or wrong
`STUDIO_API_TOKEN` only shows up when a tool actually calls the studio (an `isError` tool result).
The `tools/list` check above therefore does NOT prove the studio leg; the first real tool call does.
`studio_modules` is a good, free, read-only choice for that.

## Connect your agent

Both examples present the same `MCP_TOKEN` as a bearer against `https://<MCP_HOST>/mcp`.

Claude Code (native HTTP transport, user scope):

```sh
claude mcp add-json vivijure-studio \
  '{"type":"http","url":"https://studio-mcp.example.com/mcp","headers":{"Authorization":"Bearer <MCP_TOKEN>"}}' \
  -s user
```

Cursor (`~/.cursor/mcp.json`), via the `mcp-remote` bridge:

```json
"vivijure-studio": {
  "command": "npx",
  "args": ["-y", "mcp-remote@latest", "https://studio-mcp.example.com/mcp",
           "--header", "Authorization:${AUTH_HEADER}"],
  "env": { "AUTH_HEADER": "Bearer <MCP_TOKEN>" }
}
```

Any other MCP client works the same way: streamable-HTTP transport, one endpoint (`POST /mcp`),
`Authorization: Bearer <MCP_TOKEN>` on every request. The Worker speaks JSON-RPC 2.0
(`initialize`, `ping`, `tools/list`, `tools/call`); notifications (requests with no `id`) are
accepted with `202` and no body.

## How tool calls behave

Rules that hold for every tool, so the reference below does not repeat them:

- **One tool call = one studio HTTP request.** Each curated tool maps to exactly one route in
  [CONTRACT.md](CONTRACT.md); that document is the authority on full request and response shapes.
  This page tells you which route each tool hits so you always know where to look deeper.
- **Errors are data, not crashes.** A bad argument, a studio-side `4xx/5xx`, or an unset
  `STUDIO_API_TOKEN` all come back as an MCP tool result with `isError: true` and a readable
  message, so the agent can correct itself. Only a bad `MCP_TOKEN` is a transport-level `401`.
- **Every result is prefixed with the wire line** (`GET /api/modules -> 200`) followed by the
  pretty-printed JSON reply, so you can always see what was actually called and what came back.
- **Forward-compatible bodies.** POST/PATCH tools forward their WHOLE argument object as the request
  body (minus path parameters like `id`). If the studio contract grows a new optional field, the
  agent can pass it through the existing tool immediately; the fields listed below are the
  documented ones, not a hard allowlist.
- **Images come back as images; everything else binary is summarized.** `view_artifact` returns an
  image (keyframe, portrait, character ref, a still from `chat`) as an MCP image block, so an agent
  can actually LOOK at what it made rather than read a byte count. Video, audio, and tar have no MCP
  content block that can carry them, so they are summarized with content type and size and you fetch
  them through `artifact_url`. The inlining is opt-in per tool: `studio_request` still summarizes
  everything binary, deliberately, so a stray call cannot push megabytes through the transport.
  Non-JSON text is capped at 4000 characters.
- **Bytes go IN through two named tools, and nowhere else.** `upload_image` and `upload_audio`
  take a base64 payload plus its media type and send it to the studio as a raw body. Every other
  tool, `studio_request` included, sends `application/json` -- which is why the escape hatch could
  never reach an upload route, however correct the path looked. Uploading is deliberately narrow:
  two tools, one transport ceiling, no smuggling through the generic hatch.

## Tool reference

**109** tools in **13** groups. Arguments marked **(required)** must be present; everything else is
optional. Response shapes below show the fields you will steer by; [CONTRACT.md](CONTRACT.md) has
the full schemas.

### Registry and reads (free, safe to call any time)

**`studio_modules`** -- `GET /api/modules`. No arguments. The registry projection the whole studio
renders from: installed modules and their `config_schema`, which module serves each hook
(pre-sorted), the hook catalog, and `render.quality_tiers` + `default_tier`. **Read this first**: it
is where you discover valid `motion.backend` names, quality tiers, and what your studio can do.

**`voices`** -- `GET /api/voices`. No arguments. The 12 valid Aura-1 speaker ids with labels. These
are the only legal `voice_id` values for `update_cast` and for `submit_film`
`dialogue_lines[].voice_id` (the voice-only film path; no LoRA required, mcp#29).

**`storyboard_models`** -- `GET /api/storyboard/models`. No arguments. The planning model catalog:
the model ids accepted by `plan_storyboard`, `refine_storyboard`, and `chat`.

**`list_models`** -- `GET /api/models`. Sibling planning/chat model catalog to `storyboard_models`.

**`whoami`** -- `GET /api/whoami`. Studio identity (token mode returns a fixed operator identity; no
email leak).

**`get_prefs`** -- `GET /api/prefs`. Operator prefs the panel stores (planner defaults, UI knobs).

**`storage_usage`** -- `GET /api/storage/usage`. Ledger: `used_bytes`, `objects`, `quota_bytes`, `over`.

**`list_installed_modules`** -- `GET /api/modules/installed`. Dynamic module install registry rows.

**`get_module_config`** -- `GET /api/modules/:name/config`. Install-scope config with defaults filled.
- `name` (required).

**`list_cast`** -- `GET /api/cast`. No arguments. Every cast member: id, name, bible, portrait,
LoRA status, voice.

**`get_cast`** -- `GET /api/cast/:id`. One cast member.
- `id` (required): the cast member's public id.

**`list_projects`** -- `GET /api/storyboard/projects`. No arguments. Every storyboard project.

**`get_project`** -- `GET /api/storyboard/projects/:id`. One project, including its last saved
storyboard.
- `id` (required): the project's public id.

**`list_renders`** -- `GET /api/storyboard/renders`. The render library (history rows).
- `project_id`: filter to one project's renders.
- `limit`: max rows (default 50).

**`render_tags`** -- `GET /api/storyboard/renders/tags`. No arguments. Every tag already in use
across the library. Read this before setting tags with `update_render`, so an agent reuses the
vocabulary a human established instead of starting a parallel one.

### Cast

**`create_cast`** -- `POST /api/cast`. Create a cast member.
- `name` (required): display name.
- `bible`: the character description / bible.

**`update_cast`** -- `PATCH /api/cast/:id`. Update a cast member; send only what you are changing.
- `id` (required): the cast member's public id.
- `name`: new display name.
- `bible`: new character bible.
- `voice_id`: one of the 12 ids from `voices`, or empty string / null to clear the voice.

**`set_cast_portrait`** -- `POST /api/cast/:id/portrait`. Set a cast member's portrait (the identity
seed the render pipeline keys on) by copying an image that `chat` already produced.
- `id` (required): the cast member's public id.
- `from_chat_artifact` (required): the `output_artifact.key` returned by a `chat` image call.

Two ways to get a key here. Generate the image with `chat` and pass its `output_artifact.key`, or
bring your own with `upload_image` and pass the key that returns: **`from_chat_artifact` copies from
any studio artifact key, not only a `chat` one.** The name predates the upload path.

The sibling `key` + `mime` form documented in CONTRACT.md is narrower than it looks -- the studio
requires a key already staged under `cast/<internal id>/`, which is not what `POST /api/upload`
returns -- so `from_chat_artifact` is the form these tools use.

**`delete_cast`** -- `DELETE /api/cast/:id`. Delete a member and reclaim its R2 artifacts. Irreversible.
- `id` (required): the cast member's public id.

**`clear_cast_portrait`** -- `DELETE /api/cast/:id/portrait`. Clear the portrait and delete the R2
object (best-effort, so a missing object never blocks the clear).
- `id` (required): the cast member's public id.

**`add_cast_ref`** -- `POST /api/cast/:id/ref`. Add a **LoRA training reference** image, the set
`train_cast_lora` learns the face from.
- `id` (required): the cast member's public id.
- `from_chat_artifact` (required): any existing studio artifact key.

**`remove_cast_ref`** -- `DELETE /api/cast/:id/refs/<refKey>`. Remove one reference and its R2 object.
- `id` (required): the cast member's public id.
- `ref_key` (required): the full key as `get_cast` reports it.

**`add_cast_source`** -- `POST /api/cast/:id/source`. Add a **source photo** (extra conditioning,
distinct from the training set). Source keys are what `generate_cast_refs` takes as `source_keys`.
- `id` (required), `from_chat_artifact` (required): as above.

**`remove_cast_source`** -- `DELETE /api/cast/:id/source/<sourceKey>`.
- `id` (required), `source_key` (required): the full key as `get_cast` reports it.

> The keys above go in the **path**, not a body. They span slashes, and a `DELETE` from this MCP
> never carries a body -- so the studio's alternative `{ key }`-in-body form is unreachable from
> here. That is why these two path-shaped routes matter.

**`generate_cast_refs`** -- `POST /api/cast/:id/generate-refs`. **Spends** (image inference). Asks the
installed `cast.image` module to synthesize a training reference set from the member's portrait.
- `id` (required): the cast member's public id.
- `config`, `art_style`, `source_keys`, `choice`: optional.

Returns `201` with a job summary. The set cannot finish in one request: poll `poll_cast_refs`. **Set
the portrait first** -- it is the identity the set is generated from.

**`poll_cast_refs`** -- `GET /api/cast/:id/refs-job/:jobId`. Advance and poll one tick.
- `id` (required), `job_id` (required): from `generate_cast_refs`.

Returns `{ job_id, cast_id, phase, module?, registered, images, error? }`. Poll until `phase` is
`done` or `failed`. The keys in `images` can be looked at with `view_artifact`.

**`train_cast_lora`** -- `POST /api/cast/:id/train-lora`. **Spends GPU time** (tens of minutes).
Trains the character's identity LoRA and banks the adapter back onto the member, so a character is
trained **once** and reused across every project.
- `id` (required): the cast member's public id.
- `renderOverrides`: optional training overrides.

**`train_cast_wan_lora`** -- `POST /api/cast/:id/train-wan-lora`. **Spends GPU** (Wan cast LoRA).
Needs `RUNPOD_WAN_TRAIN_ENDPOINT_ID` on the host. Sibling of `train_cast_lora` (SDXL).
- `id` (required); optional `renderOverrides`.

**`export_cast`** -- `GET /api/cast/export/:id`. `.vvcast` tar export (binary summarized in MCP).
- `id` (required).

**`import_cast`** -- `POST /api/cast/import`. Import `.vvcast` tar bytes.
- `data_base64`, `mime` (e.g. `application/x-tar`) required.

**`cast_lora_status`** -- `GET /api/cast/:id/lora-status`. Poll after training.
- `id` (required): the cast member's public id.

`lora_status` is `idle` | `training` | `ready` | `failed`. **Only a `ready` member contributes a real
identity LoRA to a render**; binding an untrained one is how a film ships generic-looking characters.

### Projects and the render library (write)

**`create_project`** -- `POST /api/storyboard/projects`. Create a project.
- `name` (required): the project's display name.
- `prefs`: optional per-project preferences object.

Returns `201 { project }`. Its `id` is the public id every other project tool takes.

**`save_storyboard`** -- `POST /api/storyboard/projects/:id/storyboard`. Persist a storyboard as the
project's **last saved storyboard**, which is what `get_project` returns.
- `id` (required): the project's public id.
- `storyboard` (required): the storyboard object.

The storyboard is stored opaquely; it is validated at `preflight` / render time, not here.

**`update_project`** -- `PATCH /api/storyboard/projects/:id`. Update project metadata.
- `id` (required): the project's public id.
- `name`, `prefs`, `storyboard`: send only what you are changing.

> **The studio applies EITHER `storyboard` OR `name`/`prefs`, never both in one call.** If
> `storyboard` is present the other two are ignored, silently. Send them as two calls, or use
> `save_storyboard`, which only ever does the one thing.

**`delete_project`** -- `DELETE /api/storyboard/projects/:id`. Irreversible. `200 { ok, deleted }`.
- `id` (required): the project's public id.

**`update_render`** -- `PATCH /api/storyboard/renders/:id`. Organize a library row.
- `id` (required): the render row's public id (from `list_renders`).
- `label`, `lockedShots`, `folderPath`, `tags`: only the fields you send are applied.

Unlike most studio replies this one is the `RenderRow` **itself**, not wrapped in a resource key.

**`delete_render`** -- `DELETE /api/storyboard/renders/:id`. Irreversible. `200 { ok: true }`.
- `id` (required): the render row's public id.

### Finishing a completed render

Two synchronous routes that operate on a render that is already `COMPLETED`. They do not start a job
and there is nothing to poll.

**`add_render_audio`** -- `POST /api/storyboard/renders/:id/add-audio`. Mux a staged bed onto a
finished render, entirely off the GPU.
- `id` (required): the render row's public id.
- `audioKey` (required): a staged audio key.

`200 { ok: true, output_key }`, or `422` with the reason if the mux fails.

**`add_render_narration`** -- `POST /api/storyboard/renders/:id/add-narration`. **Spends** (TTS
inference, not GPU render time). Generates a narration track from text, then muxes it.
- `id` (required): the render row's public id.
- `text` (required): the narration script.
- `module`, `config`: optional specific narration module and its config.

The studio generates AND muxes inside the one request, so this call can take tens of seconds.
`200 { ok: true, output_key, module, label }`, `422` on failure, or `504` if generation does not
finish inside the studio's bounded wait -- **a `504` here means try again, not that the render is
broken.**

> **The other finishing routes have no curated tool on purpose.** `finalize`, `animate-cloud`,
> `animate-hybrid`, `regen-shot`, `scatter` and `render-from-keyframes` each START a new render job,
> and the only route that polls one is `GET /api/storyboard/render/:jobId`. That poll is part of the
> render-door reconciliation in vivijure-cf#334, so a curated submit tool would ship half a
> capability and freeze a door that is being changed. Use `studio_request` for them meanwhile.

### Planning (LLM calls; costs inference, not GPU render time)

**`plan_storyboard`** -- `POST /api/storyboard/plan`. Plan a storyboard from a brief with an LLM.
- `brief` (required): the film brief / prompt to plan from.
- `model` (required): a planning model id from `storyboard_models`.
- `characters`: optional character definitions to plan around.
- `beatBlock`: optional beat-structure block.

Returns a validated storyboard on `200`; a plan the validator rejects comes back as `422` with the
errors (which the agent sees as an `isError` result it can retry from).

**`refine_storyboard`** -- `POST /api/storyboard/refine`. Refine an existing storyboard with an
instruction.
- `storyboard` (required): the storyboard object to refine.
- `message` (required): the refinement instruction ("make shot 3 a night scene").
- `model` (required): a planning model id from `storyboard_models`.

Same return contract as `plan_storyboard`: `200` with the new storyboard, or `422` with errors.

**`preflight`** -- `POST /api/storyboard/preflight`. Pre-render validation. Always returns `200`
with `{ ok, counts, issues }`: **problems are data, not an HTTP error.** Run this before
`submit_film` and do not submit until `ok` is `true` (or you have read every issue and decided it
is acceptable).
- `storyboard` (required): the storyboard to validate.
- `castBindings`: `{ [slot]: cast_id }` bindings, if the storyboard uses cast slots.
- `motionBackend`: a `motion.backend` module name. When that module declares a `duration_grid`,
  preflight warns/errors on shots that exceed it (#707/#751). Pass this so the grid clamp is not
  skipped from MCP (mcp#26).
- `quality`: `draft` | `standard` | `final` for the duration-grid clamp when `motionBackend` is set.

**Not validated here (mcp#26):** `bundleKey` and `audioKey` are **not** read by the studio route.
They were previously advertised on this tool and manufactured false confidence; they are removed
from the schema. Validate a bed via the render path, not preflight.

**`chat`** -- `POST /api/chat`. The planner assistant and image generator, one tool.
- `model` (required): a model id (text or image; see `storyboard_models` and the module registry).
- `user_input` (required): the prompt.

A text model returns `{ output }`. An image model returns `{ output_artifact: { key, mime } }`;
feed that `key` to `set_cast_portrait`.

Additional planning / media helpers (inference or free CPU unless noted):

**`enhance_storyboard`** -- `POST /api/storyboard/enhance`. LLM enhance pass on a storyboard.
- `storyboard` (required).

**`storyboard_yaml`** -- `POST /api/storyboard/yaml`. Convert or validate YAML forms.
- `yaml` and/or `storyboard` per contract.

**`storyboard_markers`** -- `POST /api/storyboard/markers`. Derive markers from storyboard / analysis.

**`audio_analyze`** -- `POST /api/audio/analyze`. Analyze a staged audio key (from `upload_audio`).
- `key` (required).

**`render_plan`** -- `POST /api/storyboard/render-plan`. Build a plan without starting a spend render.
- `storyboard` (required).

**`score_bed`** -- `POST /api/storyboard/score-bed`. Start music/score generation; poll with
**`poll_job`**.
- Optional `storyboard`, `prompt`.

**`poll_job`** -- `GET /api/job/:id`. Generic job poll (score-bed, enhance, …).
- `id` (required).

### Render (SPENDS MONEY)

**`bundle_storyboard`** -- `POST /api/storyboard/bundle`. Assemble a render bundle (storyboard +
cast references) into R2 and return its `bundleKey`, the required input to `submit_film`. This step
itself does not spend GPU time.
- `storyboard` (required): the storyboard to bundle.
- `characterRefs` (required): `{ [slot]: ref }` cast references (see
  [CAST-BUNDLE.md](CAST-BUNDLE.md) for the ref shape; the Slate client is the reference consumer).

**`submit_film`** -- `POST /api/render/film`. **STARTS A FILM RENDER. This spends real money** (GPU
seconds on the render backend, or cloud i2v per-clip billing, depending on the motion backend).
There is no undo; treat every call like clicking a "charge my account" button.
- `bundle_key` (required): the `bundleKey` from `bundle_storyboard`.
- `scenes` (required): non-empty array of `{ shot_id, prompt, seconds }`.
- `project`: project namespace (derived from `bundle_key` when omitted).
- `motion_backend` (required in practice): a `motion.backend` module name from `studio_modules`.
  A film is a full render, and a full render REQUIRES an explicit backend: an omitted or
  non-serving value is rejected at submit with a `400` listing the installed backend names
  (#500/#504) -- the studio never silently picks one for you.
- `keyframe_backend`: a keyframe module name from `studio_modules` `hooks['keyframe']`. Unlike
  `motion_backend`, the studio does NOT reject an omitted value at submit (#380) -- selection
  falls through to the first serving keyframe module, which can be a non-operational door (e.g.
  an unseeded local-GPU door). Pass it explicitly.
- `keyframe_config`: keyframe module config, e.g. `{ "quality_tier": "..." }` (tiers come from
  `studio_modules`).
- `motion_config`: motion module config (knobs per that module's `config_schema`).
- `finish_config`: `{ [moduleName]: config }` for the per-shot `finish` chain (upscale, lipsync, audio).
  Upscale model guidance (#585): the default is `realesr-animevideov3`. `RealESRGAN_x4plus`
  gives a truer photoreal texture but is currently an explicit opt-in that CUDA-OOMs on
  long/high-fps clips until the upscale handler gains tiled inference; leave the default unless
  you know your clips are short.
- `speech_config`: `{ [moduleName]: config }` for the `speech` chain (per-shot dialogue-audio
  cleanup / enhancement, post-dialogue and pre-finish).
- `film_finish_config`: `{ [moduleName]: config }` for the `film.finish` chain on the assembled,
  muxed film. **This is where subtitle mode lives** (`burn` / `sidecar` / `both`) and the
  film-titles knobs. Putting subtitle config under `finish_config` instead validates against the
  per-shot finish chain, silently no-ops, and the subtitle module falls back to `burn` (no
  sidecar, no error) -- so subtitle mode is reachable ONLY through `film_finish_config`.
- `master_config`: `{ [moduleName]: config }` for the `master` chain (assembled film's audio bed
  -> mastered audio: music upscale + loudness, pre-mux).
- `audio_key`: a staged audio bed to mux in after assemble.
- `film_titles`: `{ title?: { text, subtitle? }, credits?: { lines } }` title cards.
- `dialogue_lines`: `[{ shot_id, text, voice_id? }]` spoken lines for TTS + captions. A line's
  `voice_id` (a name from the `voices` tool) is the **voice-only** path: no trained LoRA required
  (mcp#29). It always wins over any cast voice. Use this when a cast member should speak but has
  no identity adapter yet. Do not also pass that member in `cast_loras` -- the studio 400s the
  untrained binding even if every line has a `voice_id`.
- `cast_loras`: `{ [slot]: castId }` -- bind storyboard character slots (`A`, `B`, ...) to cast ids
  from `list_cast`. **Requires a trained identity LoRA** on each bound member (the studio hard-400s
  otherwise). Drives keyframe identity AND, for voiceless dialogue lines, that member's voice.
  Not a voice-only path -- for voice without LoRA, use `dialogue_lines[].voice_id` (mcp#29).
  Omit untrained members entirely.
- `qualityTier`: `draft` | `standard` | `final` (also listed in `studio_modules`
  `render.quality_tiers`). Labels the render-history row with the tier you requested; if omitted,
  the row records `"final"` regardless of what actually ran (#382). Does not change the actual
  render, which is still driven by `keyframe_config` / `motion_config` -- this only makes the
  history label honest.
- `shard_count`: parallel shard count (alias `shardCount`). Omitted, the studio uses
  `min(shots, 20)` so a 20-worker pool is used. `1` is a serial film (one job). `N` is clamped
  to the shot count. Do not send null; omit the field to let the studio pick.

**Voices, two paths (mcp#29):** (1) `dialogue_lines[].voice_id` for voice alone -- works with no
LoRA; this is the default path for speech. (2) `cast_loras` for identity LoRA **and** voice
together -- only works when the cast member is trained; an untrained member 400s, even if you also
set `voice_id`. Priority: explicit `dialogue_lines` win over bundle-derived dialogue; a line's own
`voice_id` wins over the cast voice; a voiceless line uses the cast voice of its shot's speaking
slot (via `cast_loras`); only when nothing maps does it fall to the studio default voice. If a
cast member "has a voice in the UI" but was never trained, do **not** pass them in `cast_loras` --
set `voice_id` on the line instead.

Returns `{ film_id, phase }`. Nothing renders any further unless you poll.

**`submit_clips`** -- `POST /api/render/clips`. Clips-only spend path (prefer `submit_film` for full
films).
- `bundle_key`, `scenes` (required).

**`poll_clips`** -- `GET /api/render/clips/:id`. Poll clips job.
- `id` (required).

**`render_frames`** -- `POST /api/render/frames`. Extract stills from a video artifact.
- `key` (required); optional `times`.

**`poll_film`** -- `GET /api/render/film/:id`. Advance and poll a film job **one tick**. The
pipeline moves when you poll, so poll steadily (every 10 to 30 seconds is plenty) until it settles.
- `id` (required): the `film-<...>` or `scatter-<...>` job id from `submit_film`. Same poll path
  for both; a scatter job also returns `film_id`.

Returns `{ phase, clips?, finish?, film_key?, download_url? }`. Serial phases, in order:
`keyframe`, `clips`, `dialogue`, `speech`, `finish`, `assemble`, `master`, `mux`, then terminally
`done` or `failed`. A scattered film can report `shards`, `gather`, `mux`, `finishing`, then
`done` or `failed`. On `done`, `download_url` is a presigned link to the finished film with a
**6 hour TTL** (`FILM_DOWNLOAD_TTL_SECONDS`); download it before it expires (a later `poll_film` re-issues a fresh one). On
`failed`, the payload carries the real per-shot error: the studio never silently ships an
unfinished film.

### Bytes in (bring your own image or audio)

The studio's upload routes read a **raw** request body and dispatch on the content-type header, so
they are the one class `studio_request` cannot serve: it sends JSON, and JSON is refused there. These
two tools are how an agent brings in material it did not generate.

**`upload_image`** -- `POST /api/upload`. Store an image and get a key back.
- `data_base64` (required): the image bytes, base64-encoded, with **no** `data:` URL prefix.
- `mime` (required): the media type, e.g. `image/png`.

Returns `{ key, mime, size }`. Feed that `key` to `set_cast_portrait`, `add_cast_ref` or
`add_cast_source` as `from_chat_artifact`, or into a bundle's `characterRefs`. The studio accepts
png/jpeg/webp/gif here; **cast media is narrower and refuses gif**, so use png/jpeg/webp for anything
going onto a cast member.

**`upload_audio`** -- `POST /api/storyboard/audio-upload`. Store an audio track and get a key back.
- `data_base64` (required): the audio bytes, base64-encoded, no `data:` prefix.
- `mime` (required): the media type, e.g. `audio/mpeg`.

Returns `{ key, mime, size }`. That key is `submit_film`'s `audio_key` and `add_render_audio`'s
`audioKey`.

> **A `data:` URL prefix is refused, not stripped.** The payload's declared type and the `mime`
> argument could disagree, and the studio persists the content-type we send onto the object, so
> quietly preferring one would write a wrong type that looks right. Pass the payload alone.

Both refuse a decoded body over **32 MB**, which is this MCP's transport ceiling and not the
studio's rule: each route enforces its own cap and answers `400` with its real number.

### Artifacts (see what you made)

**`view_artifact`** -- `GET /api/artifact/<key>`. Look at an artifact. An **image** is returned
inline as an MCP image block. Video and audio cannot be inlined by the protocol; for those use
`artifact_url`.
- `key` (required): the R2 artifact key, e.g. `renders/film-<id>/film.mp4` or `cast/portrait.png`.

Keys come from `list_renders` (`output_key`, `keyframes[].key`), `get_cast` (`portrait_key`, refs),
or a `chat` image reply (`output_artifact.key`). An image over 4 MB is refused with its size rather
than truncated. A key shaped like a traversal or an absolute path is rejected as a bad argument
before any request leaves the Worker.

**`artifact_url`** -- `GET /api/artifact-url/<key>`. Turn a key into a **short-lived presigned
download URL** plus the object's real content type and byte size. This is how a finished film gets
watched: the link opens directly in a browser with no studio credential.
- `key` (required): the R2 artifact key.
- `expires_in`: seconds, clamped by the studio to `[60, 3600]`, default `300`.

> **The URL is a capability credential.** It authenticates on its own and may end up in a log or a
> transcript, so it is scoped to that one object and short-lived by design; R2 revocation propagates
> too slowly for revoke-after-use to be a control. Ask for a fresh link instead of storing one.

Requires studio-side support for `/api/artifact-url` (vivijure-cf, cf#317). Against an older studio
this tool returns a `404` as data, which is the honest answer rather than a broken link.

### Studio settings and modules (write)

**`set_prefs`** -- `PATCH /api/prefs`. Merge operator prefs the panel would store.
- Body: either a `prefs` object argument or top-level fields forwarded as JSON.

**`storage_reconcile`** -- `POST /api/storage/reconcile`. Rebuild the storage ledger from object
store inventory (operator maintenance; may take a while on large buckets).

**`install_module`** -- `POST /api/modules/install`.
- `script_name` (required): Worker script name in the modules dispatch namespace.
- Needs `MODULE_DISPATCH` on the host; otherwise the studio answers 400/503.

**`uninstall_module`** -- `DELETE /api/modules/install/:name`.
- `name` (required): module name.

**`set_module_enabled`** -- `PATCH /api/modules/install/:name`.
- `name` (required), `enabled` (required boolean).

**`patch_module_config`** -- `PATCH /api/modules/:name/config`.
- `name` (required), `config` (required object of install-scope fields).
- Render-scope keys are dropped by the studio (install subschema only).

Pair with reads: `list_installed_modules`, `get_module_config`, `storage_usage`.

### Demo mode

Only when the host enables the curated demo path (no open GPU spend).

**`demo_menu`** -- `GET /api/demo/menu`. Recipe list.

**`demo_chat`** -- `POST /api/demo/chat`.
- `user_input` (required), `model` optional.

**`demo_render`** -- `POST /api/demo/render`.
- `id` (required): recipe id from the menu.

**`poll_demo_render`** -- `GET /api/demo/render/:id`.
- `id` (required): job id from `demo_render`.

### Control plane (platform)

Requires `CONTROL_PLANE_URL` + `CONTROL_PLANE_ADMIN_TOKEN`. See [PARITY.md](PARITY.md) for bootstrap
vs owner provision. Call **`cp_whoami`** first to see scopes.

**`cp_whoami`** -- `GET /api/admin/whoami`. Operator identity + granted scopes.

**`cp_platform_config`** -- `GET /api/platform/config`. Public front-door projection (auth methods).

**`cp_platform_version`** -- `GET /api/platform/version`. Plane version + pinned studio release.

**`cp_get_settings`** -- `GET /api/admin/settings`. Platform switches (e.g. signups gate).

**`cp_set_settings`** -- `POST /api/admin/settings` (`platform:settings`).
- e.g. `signups_enabled` boolean. Closing signups does not strand mid-onboarding accounts.

**`cp_list_audit`** -- `GET /api/admin/audit` (`tenants:read`).
- Optional `limit`, `cursor`.

**`cp_hosted_storage_usage`** -- `GET /api/admin/r2-usage`. Aggregate hosted R2 (not per-tenant content).

**`cp_reconcile_runpod`** -- `POST /api/admin/reconcile/runpod`. Operator-supplied RunPod snapshot.

**`cp_llm_meter_run`** -- `POST /api/admin/llm-meter/run` (`meter:operate`). Force ingest tick.

**`cp_meter_settle`** -- `POST /api/admin/meter-settle` (`meter:operate`). Settle measured overage
(not `credits:write` mint-from-nothing).

**`cp_llm_spend`** -- `GET /api/admin/llm-spend`. Optional `tenant_id` filter.

**`cp_kek_status`** / **`cp_kek_reencrypt`** -- KEK status and re-encrypt sweep (`keys:rotate`).

**`cp_list_operators`** -- `GET /api/admin/operators` (**root**).

**`cp_create_operator`** -- `POST /api/admin/operators` (**root**).
- `name`, `scopes` (required); `expires_at` optional. Plaintext token returned **once**.

**`cp_revoke_operator`** -- `POST /api/admin/operators/:id/revoke` (**root**).
- `id` (required): `opc_…`.

### Control plane (tenants)

All take `id` = `ten_…` unless noted. Scope names in parentheses.

**`cp_list_tenants`** -- `GET /api/admin/tenants` (`tenants:read`). Census (slug, status, suspended).

**`cp_tenant_credits`** -- `GET …/credits` (`tenants:read`).

**`cp_tenant_credits_manual`** -- `POST …/credits/manual` (`credits:write`).
- `reason` required; amount fields per plane body schema. Mints or debits money.

**`cp_tenant_module_readiness`** -- `GET …/module-readiness` (`tenants:read`). After upgrade/bootstrap.

**`cp_tenant_suspend`** / **`cp_tenant_resume`** -- kill switch (`tenants:write`).
- `reason` required (audit).

**`cp_tenant_teardown`** -- irreversible destroy (`tenants:destroy`). Refused under preservation hold.

**`cp_tenant_upgrade_studio`** -- push pinned published studio release (`studio:operate`).
- Optional `to_release`.

**`cp_tenant_upgrade_modules`** -- upgrade module workers (`studio:operate`).
- Optional `from_release`, `to_release`.

**`cp_tenant_refresh_bindings`** -- re-apply studio bindings/secrets (`studio:operate`).

**`cp_tenant_invoke_key_handoff`** -- mint owner RunPod invoke-key handoff (`studio:operate`).

**`cp_tenant_reprovision_runpod`** -- rebuild endpoints (`studio:operate`).
- Transient `runpod_api_key` (Key A; plane never stores it).

**`cp_tenant_smoke_render`** -- start smoke film (**spends GPU**, `studio:operate`).

**`cp_poll_smoke_render`** -- poll `smk_…` job (`tenants:read`).
- `id`, `smoke_id` required.

**`cp_tenant_abuse_report_url`** -- converge `host.abuse_report_url` on the tenant studio.

**`cp_tenant_storage_quota`** -- set quota (`tenants:write`).

**`cp_tenant_video_finish_binding`** / **`cp_tenant_video_finish_tier_state`** -- finish tier ops.

**`cp_list_preservation_holds`** -- list holds (`tenants:read`).

**`cp_open_preservation_hold`** -- open statutory hold (`tenants:write`); blocks teardown.

**`cp_release_preservation_hold`** -- human release only (`tenants:write`).
- `hold_id`, `reason` required. Clocks never auto-release.

### Escape hatch

**`studio_request`** -- studio CONTRACT path under `/api/` (JSON body only; binary summarized).
- `method` (required), `path` (required, must start with `/api/`), optional `query`, `body`.
- Refused: `//`, `.` / `..` segments, encoded dots, `http:` / `https:`, over-length paths,
  and control-plane `/api/admin` or `/api/platform` (use `control_plane_request`).
- Fetch uses `redirect: "manual"` so `Authorization` cannot hop.
- Use for uncurated doors (e.g. `/api/storyboard/render` until cf#334). Prefer curated tools.

**`control_plane_request`** -- any control-plane path with the admin bearer.
- Same args as `studio_request`. Prefer curated `cp_*` tools.
- Owner provision remains session-based; admin bearer will not satisfy it.

## A render, end to end

The full happy path. Steps 1 through 4 are free or inference-only; step 5 spends GPU.

1. **`studio_modules`** -- note a name under `hooks["motion.backend"]` and the
   `render.quality_tiers`.
2. **`plan_storyboard`** with `{ brief, model }` (model from `storyboard_models`); optionally
   iterate with **`refine_storyboard`** until the storyboard reads right.
3. **`preflight`** with `{ storyboard }` (plus `castBindings` if you cast it, and `motionBackend` /
   `quality` when you know the door so the duration-grid clamp can fire) -- keep fixing and
   re-running until `ok: true`.
4. **`bundle_storyboard`** with `{ storyboard, characterRefs }` -- keep the returned `bundleKey`.
5. **`submit_film`** with
   `{ bundle_key, scenes, motion_backend, keyframe_config: { quality_tier } }` -- keep `film_id`.
   **This is the spend line.** For speech, add `dialogue_lines: [{ shot_id, text, voice_id }]`
   with `voice_id` from `voices`. Do not pass `cast_loras` unless every bound member has a
   trained identity LoRA (untrained = hard 400, mcp#29).
6. **`poll_film`** with `{ id: film_id }` every 10 to 30 seconds. Watch `phase`; stop on `done`
   (grab `download_url`, valid 6h) or `failed` (fix, resubmit).

Related (not substitutes for the film path):

- **`submit_clips`** / **`poll_clips`** -- clips-only spend pipeline.
- **`render_frames`** -- extract stills from a finished video artifact.
- Alternate panel doors (`/api/storyboard/render`, scatter, animate, finalize, regen-shot) stay
  **uncurated** until sound reconciliation (cf#334); use `studio_request` if you must.

## Hosted tenant ops, end to end

After a human has provisioned (front door + AUP + keys):

1. **`cp_whoami`** -- confirm scopes (`studio:operate`, `tenants:read`, …).
2. **`cp_list_tenants`** -- resolve `ten_…` for the slug.
3. **`cp_tenant_upgrade_studio`** (and **`cp_tenant_upgrade_modules`** if modules lag).
4. **`cp_tenant_refresh_bindings`** if bindings drifted.
5. **`cp_tenant_module_readiness`** -- doors green.
6. **`cp_tenant_smoke_render`** then **`cp_poll_smoke_render`** until done (**spends GPU**).
7. Optional: **`cp_tenant_abuse_report_url`**, credits, storage quota.

Point a studio-configured MCP at `https://<slug>.studio.vivijure.com` with a **tenant** API token
for creative tools (separate from the admin bearer).

## Security boundary

- The MCP is machine-to-machine only, gated by `MCP_TOKEN` and any token in `MCP_TOKEN_EXTRA`
  (fail closed: a wrong token is a `401`, and a Worker with NO gate token at all refuses everything
  rather than opening up). It is a full write path to the studio, **including spend routes**
  (`submit_film`) and, via `studio_request`, delete routes. Treat EVERY gate token with exactly the
  care you give the studio bearer itself: `MCP_TOKEN_EXTRA` is a convenience for issuing and
  revoking credentials independently, **not** a lower tier of access. There is no per-token scoping
  and the Worker never records which token was used, so an extra token is a full-privilege
  credential.
- Give the MCP its own named consumer token (see [Before you start](#before-you-start)) so a leak
  burns one credential, rotation touches one consumer, and MCP traffic is attributable in the
  observability stream.
- Keep it on a custom domain (`workers.dev` stays disabled in the example config) so the bearer gate
  is not the only thing between the public internet and your studio credential.
- `studio_request` is bounded in FORMAT (JSON in/out, binary summarized) and in REACH (`/api/` on
  the configured studio origin; no redirects; no control-plane routes). The gate is still the
  primary control: anyone holding `MCP_TOKEN` holds the studio write path.
- When control plane is armed, `MCP_TOKEN` also reaches **every admin capability** of the seeded
  operator token (upgrade, suspend, teardown, credits if scoped). Prefer scoped `opc_…`
  credentials; never put root admin in a shared agent profile.

## Troubleshooting

| Symptom | Meaning | Fix |
|---------|---------|-----|
| `401 {"error":"unauthorized"}` on `/mcp` | The bearer matches neither `MCP_TOKEN` nor any entry in `MCP_TOKEN_EXTRA`, or the Worker holds no gate token at all (it fails closed). | Re-check the client's `Authorization: Bearer` value; re-seed with `wrangler secret put MCP_TOKEN -c wrangler.mcp.toml`, or `MCP_TOKEN_EXTRA` if the client holds an extra token. A client added to `MCP_TOKEN_EXTRA` only takes effect once the Worker is redeployed or the secret is put on the live Worker. |
| Tool result: `MCP is not configured: STUDIO_API_TOKEN is unset.` | The gate passed but the Worker has no studio bearer to forward with. | Seed `STUDIO_API_TOKEN` (step 3 of [Deploy](#deploy-the-mcp-worker)). |
| Tool result: `MCP control plane is not configured: CONTROL_PLANE_ADMIN_TOKEN is unset.` | `cp_*` tool without plane secret. | Seed admin/operator token or omit control-plane tools. |
| Tool result: `STUDIO_URL` / `CONTROL_PLANE_URL` is not configured | Var missing from rendered wrangler. | Fix `[vars]` and redeploy. |
| Tool result line ends `-> 401` or `-> 403` | Upstream rejected the forwarded bearer (wrong scope, revoked token, or studio not in token mode). | Mint/re-seed studio consumer token; for plane, check `cp_whoami` scopes. |
| Tool result line ends `-> 422` | The studio validated your body and rejected it (planner output, bad storyboard). | The errors are in the reply body; fix and retry. It is data, not an outage. |
| `Studio request failed (transport): ...` | The Worker could not reach `STUDIO_URL` at all (DNS, TLS, studio down). | Check the studio's own health, then the `STUDIO_URL` value. |
| `Control plane request failed (transport): ...` | Same for the plane host. | Check `CONTROL_PLANE_URL` and plane health. |
| `poll_film` never advances | The pipeline only moves when polled. | Keep polling on a steady cadence; a phase can legitimately take minutes of wall clock (GPU cold starts). |
| `download_url` gives an error after a while | The presigned link has a 6h TTL. | Call `poll_film` again on the same `film_id`; a `done` film re-issues a fresh URL. |
| Owner provision fails with admin token | Expected: provision is session + AUP, not admin. | Use the front door; then admin MCP for lifecycle. |

## Parity

Honest matrix of panel / console vs tools: **[PARITY.md](PARITY.md)**.

## Files

Package paths (import as `@skyphusion-labs/vivijure-mcp`, etc.):

- `src/mcp.ts` -- transport, bearer gate, JSON-RPC dispatch (default export for Worker `main`).
- `src/mcp-tools.ts` -- tool catalog + dual-target dispatch + escape hatches.
- `src/mcp-env.ts` -- `McpEnv` binding surface (`STUDIO_*`, `CONTROL_PLANE_*`, `MCP_TOKEN`).

Host deploy wiring: `vivijure-cf/wrangler.mcp.toml.example` (or `vivijure-local` equivalent).
Real `wrangler.mcp.toml` is gitignored.

Tests: `tests/mcp.test.ts`, `tests/control-plane-130.test.ts`, docs catalog/placement guards.
