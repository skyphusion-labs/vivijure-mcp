# Vivijure MCP parity matrix (1.3)

Honest map of what a human can do in **vivijure-cf** / **vivijure-local** panels and on the
**vivijure-control-plane** operator surface, versus curated MCP tools. Escape hatches
(`studio_request`, `control_plane_request`) cover remainder that is JSON-shaped.

**Version:** package `1.4.0` -- re-count tools from `src/mcp-tools.ts` (`TOOLS.length`).

## Verdict

| Surface | Parity |
|---------|--------|
| Studio creative path (cast, plan, bundle, **film** render, library, uploads, artifacts) | **Curated** -- full human film loop |
| Studio panel extras (prefs, modules install/config, storage, score-bed, clips, demo) | **Curated in 1.3** |
| Alternate storyboard render doors (`/api/storyboard/render*`, finalize, animate-*, scatter, regen-shot) | **Deliberately uncurated** (cf#334 sound-door divergence). Reachable via `studio_request` only |
| Host secret store UI (`/api/settings/secrets` if present) | Escape hatch / host-specific; not every host exposes it |
| Control plane **admin** lifecycle (list tenants, upgrade, smoke, suspend, credits, holds, operators) | **Curated in 1.3** (`cp_*`) when `CONTROL_PLANE_*` configured |
| Control plane **tenant self-serve provision** (`POST /api/tenant/provision`) | **Not admin-bearer**. Needs owner session (magic link / OAuth) + AUP + RunPod key paste. MCP documents this; agents do not fake browser SSO |

## Studio: human panel -> tools

| Human action | Route(s) | MCP |
|--------------|----------|-----|
| Open modules registry | `GET /api/modules` | `studio_modules` |
| Voices / plan models | `/api/voices`, `/api/storyboard/models`, `/api/models` | `voices`, `storyboard_models`, `list_models` |
| Who am I | `GET /api/whoami` | `whoami` |
| Prefs | `GET/PATCH /api/prefs` | `get_prefs`, `set_prefs` |
| Projects CRUD + save board | `/api/storyboard/projects*` | `list/get/create/update/delete_project`, `save_storyboard` |
| Cast identity + LoRA | `/api/cast*` | full cast suite + `train_cast_lora` + `train_cast_wan_lora` + import/export |
| Plan / refine / chat / preflight | plan, refine, chat, preflight | same-named tools |
| Bundle + film | bundle + `/api/render/film` | `bundle_storyboard`, `submit_film`, `poll_film` |
| Clips-only | `/api/render/clips` | `submit_clips`, `poll_clips` |
| Render library | `/api/storyboard/renders*` | list/update/delete/tags + add-audio/narration |
| Uploads | `/api/upload`, audio-upload | `upload_image`, `upload_audio` |
| View / download artifacts | artifact, artifact-url | `view_artifact`, `artifact_url` |
| Score bed / jobs | score-bed, `/api/job/:id` | `score_bed`, `poll_job` |
| Enhance / yaml / markers / analyze | corresponding POSTs | curated tools |
| Module install/config | `/api/modules/install*`, config | curated tools |
| Storage ledger | usage + reconcile | `storage_usage`, `storage_reconcile` |
| Demo mode | `/api/demo/*` | `demo_*` |
| Storyboard render / scatter / animate / finalize / regen | blocked doors | **`studio_request` only** (cf#334) |
| Frames extract | `POST /api/render/frames` | `render_frames` |

## Control plane: operator manual work -> tools

Configured when both `CONTROL_PLANE_URL` and `CONTROL_PLANE_ADMIN_TOKEN` are set (scoped `opc_` preferred over root admin token; see control-plane `docs/operator-access.md`).

| Manual / console work | Route | MCP |
|----------------------|-------|-----|
| See my scopes | `GET /api/admin/whoami` | `cp_whoami` |
| Platform version / config | `/api/platform/*` | `cp_platform_version`, `cp_platform_config` |
| List hosted studios | `GET /api/admin/tenants` | `cp_list_tenants` |
| Signups gate | settings GET/POST | `cp_get_settings`, `cp_set_settings` |
| Audit trail | `/api/admin/audit` | `cp_list_audit` |
| R2 aggregate usage | `/api/admin/r2-usage` | `cp_hosted_storage_usage` |
| RunPod reconcile | reconcile POST | `cp_reconcile_runpod` |
| LLM meter + settle | llm-meter, meter-settle | `cp_llm_meter_run`, `cp_meter_settle`, `cp_llm_spend` |
| KEK | kek status/reencrypt | `cp_kek_*` |
| Mint/revoke operators | `/api/admin/operators*` | `cp_list/create/revoke_operator` |
| Credits read/manual | tenants/:id/credits* | `cp_tenant_credits*` |
| Module readiness after bootstrap | module-readiness | `cp_tenant_module_readiness` |
| Suspend / resume | suspend, resume | `cp_tenant_suspend`, `cp_tenant_resume` |
| Teardown | teardown | `cp_tenant_teardown` |
| **Upgrade studio / modules** (bootstrap repair) | upgrade-studio, upgrade-modules | `cp_tenant_upgrade_studio`, `cp_tenant_upgrade_modules` |
| Refresh bindings | refresh-studio-bindings | `cp_tenant_refresh_bindings` |
| Invoke-key handoff | invoke-key-handoff | `cp_tenant_invoke_key_handoff` |
| Reprovision RunPod | reprovision-runpod | `cp_tenant_reprovision_runpod` |
| Smoke render | smoke-render + poll | `cp_tenant_smoke_render`, `cp_poll_smoke_render` |
| Abuse URL converge | abuse-report-url | `cp_tenant_abuse_report_url` |
| Storage quota / finish tier | storage-quota, video-finish-* | curated `cp_tenant_*` |
| Preservation holds | preservation-holds* | list/open/release tools |
| Anything else admin | any path | `control_plane_request` |

### Bootstrap sequence (hosted) -- agent + human

1. **Human (or future session-capable client):** front door signup, AUP accept, `POST /api/tenant/provision` with slug + RunPod key A (or shared pool when offered).
2. **Owner:** mint invoke key B, complete handoff (`/api/handoff/invoke-key` or admin-minted handoff).
3. **Agent (admin):** `cp_list_tenants` -> `cp_tenant_upgrade_studio` / `cp_tenant_upgrade_modules` / `cp_tenant_refresh_bindings` -> `cp_tenant_module_readiness` -> `cp_tenant_smoke_render` + poll -> optional `cp_tenant_abuse_report_url`.
4. **Agent (studio):** point a separate MCP deploy (or second target) `STUDIO_URL` at `https://<slug>.studio.vivijure.com` with a tenant API token and run the creative tools.

There is **no** admin route that silently provisions a studio without the owner identity and key-custody split. That is intentional (custody + AUP).

## Local vs CF

`vivijure-local` shares the same CONTRACT as cf for the studio API. MCP tools are host-agnostic: set `STUDIO_URL` to the local door. Control-plane tools only apply to a deployed control plane (not required for self-host/local).

## Wiring

| Secret / var | Purpose |
|--------------|---------|
| `MCP_TOKEN` | Agent gate (required) |
| `STUDIO_URL` + `STUDIO_API_TOKEN` | Studio tools |
| `CONTROL_PLANE_URL` + `CONTROL_PLANE_ADMIN_TOKEN` | `cp_*` + `control_plane_request` |

Either target may be omitted; tools for the missing target fail closed with a clear error. `/health` reports which targets are armed.
