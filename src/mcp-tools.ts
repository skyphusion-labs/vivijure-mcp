// Vivijure Studio MCP -- tool catalog + dispatch.
//
// Each curated tool maps to exactly ONE route in docs/CONTRACT.md; `studio_request` is a generic
// escape hatch covering every other route. A tool call is translated to one studio HTTP request
// (method + path + optional query + optional JSON body), sent with the operator's studio bearer, and
// the JSON reply is returned to the agent as MCP text content. Nothing here holds studio state: the
// MCP is stateless, and long-running renders are driven by the agent polling `poll_film`.
//
// Forward-compatibility: the POST/PATCH tools forward their whole argument object as the request body
// (minus any path parameter), so a new optional field in the contract is usable through the existing
// tool without a code change here. The documented fields are listed in each inputSchema as hints.
//
// Bytes IN (cf#317): the studio's upload routes take a RAW body, not JSON, so a tool aiming at one
// sets `rawBody` instead of `body`. The two are mutually exclusive BY TYPE rather than by a runtime
// check, so a call carrying both cannot be constructed. This reverses the "no binary uploads" line
// this file used to hold: it was true of the protocol for responses and never true of requests, and
// an agent that could not bring in an image or an audio bed could not do what a human can.

import type { McpEnv } from "./mcp-env.js";

/** A raw (non-JSON) request body: the bytes and the content-type header that describes them. */
export interface StudioRawBody {
  bytes: Uint8Array;
  contentType: string;
}

/** HTTP target: studio CONTRACT by default, or the hosted control plane admin API. */
export type CallTarget = "studio" | "control_plane";

/** One translated HTTP call (studio or control plane).
 *
 *  `body` (JSON) and `rawBody` (bytes) are exclusive by CONSTRUCTION, not by a runtime guard: a
 *  build() that set both would not compile, so "which body wins" is not a question runTool has to
 *  answer and not a rule a future tool can forget. */
export type StudioCall = {
  method: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  /** Default `studio`. Control-plane tools set `control_plane`. */
  target?: CallTarget;
} & (
  | { body?: unknown; rawBody?: never }
  | { rawBody: StudioRawBody; body?: never }
);

// MCP content blocks a tool result may carry. Text is the default for every JSON reply; `image` is
// what lets an agent actually SEE a rendered still instead of being told how many bytes it was
// (cf#317). MCP has no video block, so a film is delivered as a presigned URL, never inlined.
export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // cf#317: opt this tool into returning image bytes as an MCP image block. Off by default, because
  // the generic escape hatch must keep summarizing binary rather than dumping megabytes into a
  // transcript; a tool whose PURPOSE is looking at a picture opts in explicitly.
  inlineImages?: boolean;
  // Translate validated arguments into one studio HTTP call. Throws a plain Error on a bad argument;
  // the caller turns that into an MCP error result (isError: true), never a thrown request.
  build(args: Record<string, unknown>): StudioCall;
}

const OBJ = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({ type: "object", properties, required });

const STR = (description: string) => ({ type: "string", description });
const NUM = (description: string) => ({ type: "number", description });
const ARR = (description: string) => ({ type: "array", description });

// Pull a required, non-empty string argument (used for path ids). Throws on absence.
function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`missing required argument '${key}'`);
  }
  return v.trim();
}

// An R2 artifact key is a multi-segment path ("renders/film-x/film.mp4"). Percent-encode each SEGMENT
// so a key containing a space or "#" survives the URL, while the slashes that make it a path do not
// get encoded away. A key shaped like a traversal or an absolute path is refused here rather than
// forwarded; the studio refuses it too, but a bad argument should read as a bad argument.
function keyPath(raw: string): string {
  if (raw.startsWith("/") || raw.includes("://") || raw.split("/").includes("..")) {
    throw new Error(`invalid artifact key '${raw}'`);
  }
  return raw.split("/").map(encodeURIComponent).join("/");
}

// cf#317: the MCP transport ceiling on an upload, applied to the DECODED length. This is OUR limit,
// not the studio's: each upload route enforces its own byte cap and is the authority on it (the
// studio answers 400 with its real number). Duplicating the studio's per-route caps here would be a
// hand-maintained copy of a server-side rule, which is the class of thing that drifts silently, so
// there is one honestly-labelled number instead.
const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

// Decode a base64 argument to bytes. `atob` is the Workers-runtime decoder; it throws on invalid
// input, which is turned into a readable bad-argument error rather than a transport failure.
function fromBase64(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64.replace(/\s+/g, ""));
  } catch {
    throw new Error("data_base64 is not valid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Read the (data_base64, mime) pair every bytes-in tool takes, and refuse the shapes that would
// otherwise reach the studio as a confidently wrong request.
//
// A `data:` URL prefix is REFUSED rather than stripped. Stripping it means the payload declares one
// mime and the `mime` argument declares another, and silently preferring either is a wrong answer
// that looks like an answer; the studio stores the content-type we send, so a mismatch would be
// persisted onto the object.
function rawBytesArg(args: Record<string, unknown>): StudioRawBody {
  const raw = args.data_base64;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("missing required argument 'data_base64' (the file bytes, base64-encoded)");
  }
  if (/^data:/i.test(raw.trim())) {
    throw new Error(
      "data_base64 must be the base64 payload ALONE, with no 'data:<mime>;base64,' prefix -- " +
        "pass the media type in the 'mime' argument instead",
    );
  }
  const mime = reqStr(args, "mime");
  // Shape only. WHICH types are allowed is the studio's rule, per route, and is not copied here.
  if (!/^[a-z]+\/[a-z0-9.+-]+$/i.test(mime)) {
    throw new Error(`'mime' must be a media type like 'image/png', got '${mime}'`);
  }
  const bytes = fromBase64(raw);
  if (bytes.byteLength === 0) throw new Error("data_base64 decoded to zero bytes");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `decoded body is ${bytes.byteLength} bytes, over this MCP's ${MAX_UPLOAD_BYTES}-byte transport ceiling`,
    );
  }
  return { bytes, contentType: mime };
}

// The body for a POST/PATCH tool: the whole args object minus the named path params, so any extra
// contract field the agent supplies is forwarded verbatim (forward-compatible with the contract).
function bodyWithout(args: Record<string, unknown>, ...omit: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!omit.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}

export const TOOLS: McpTool[] = [
  // --- registry / reads -------------------------------------------------------
  {
    name: "studio_modules",
    description:
      "GET /api/modules. The studio projection the whole pipeline renders from: installed modules " +
      "and their config_schema, which module names serve each hook (pre-sorted), the hook catalog, " +
      "and render.quality_tiers + default_tier. Read this first to discover motion.backend names, " +
      "quality tiers, and available capabilities before planning or rendering.",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/modules" }),
  },
  {
    name: "voices",
    description:
      "GET /api/voices. The 12 valid Aura-1 speaker ids + labels; the only valid voice_id values for " +
      "a cast member (see update_cast).",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/voices" }),
  },
  {
    name: "storyboard_models",
    description:
      "GET /api/storyboard/models. The planning model catalog (the model ids accepted by " +
      "plan_storyboard / refine_storyboard / chat).",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/storyboard/models" }),
  },
  {
    name: "list_cast",
    description: "GET /api/cast. Every cast member (id, name, bible, portrait, LoRA status, voice).",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/cast" }),
  },
  {
    name: "get_cast",
    description: "GET /api/cast/:id. One cast member by its public id.",
    inputSchema: OBJ({ id: STR("Cast member public id.") }, ["id"]),
    build: (a) => ({ method: "GET", path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}` }),
  },
  {
    name: "list_projects",
    description: "GET /api/storyboard/projects. Every storyboard project.",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/storyboard/projects" }),
  },
  {
    name: "get_project",
    description: "GET /api/storyboard/projects/:id. One project (incl. its last saved storyboard).",
    inputSchema: OBJ({ id: STR("Project public id.") }, ["id"]),
    build: (a) => ({
      method: "GET",
      path: `/api/storyboard/projects/${encodeURIComponent(reqStr(a, "id"))}`,
    }),
  },
  {
    name: "list_renders",
    description:
      "GET /api/storyboard/renders. The render library (history rows). Optional project_id filter " +
      "and limit (default 50).",
    inputSchema: OBJ({
      project_id: NUM("Filter to one project's renders."),
      limit: NUM("Max rows (default 50)."),
    }),
    build: (a) => ({
      method: "GET",
      path: "/api/storyboard/renders",
      query: {
        project_id: a.project_id as number | undefined,
        limit: a.limit as number | undefined,
      },
    }),
  },

  // --- project + library WRITE (cf#317) ---------------------------------------
  {
    name: "create_project",
    description:
      "POST /api/storyboard/projects. CREATE a storyboard project. Body: { name (req), prefs? }. " +
      "Returns 201 { project } whose `id` is the public id every other project tool takes. Until " +
      "this existed an agent could list and read projects and could not make one, so a film had to " +
      "start from a project a human had already created.",
    inputSchema: OBJ(
      {
        name: STR("Project display name."),
        prefs: { type: "object", description: "Optional per-project preferences object." },
      },
      ["name"],
    ),
    build: (a) => {
      reqStr(a, "name");
      return { method: "POST", path: "/api/storyboard/projects", body: bodyWithout(a) };
    },
  },
  {
    name: "save_storyboard",
    description:
      "POST /api/storyboard/projects/:id/storyboard. SAVE a storyboard as the project's last saved " +
      "storyboard -- the one `get_project` returns. Body: { storyboard (req) }. This is the write " +
      "side of the promise get_project's own description makes; without it an agent could plan and " +
      "refine a storyboard and never persist it, so the next call read whatever a human last saved. " +
      "The storyboard is stored opaquely here and is validated at `preflight` / render time, not now.",
    inputSchema: OBJ(
      {
        id: STR("Project public id."),
        storyboard: { type: "object", description: "The storyboard object to persist." },
      },
      ["id", "storyboard"],
    ),
    build: (a) => {
      if (typeof a.storyboard !== "object" || a.storyboard === null) {
        throw new Error("missing required argument 'storyboard'");
      }
      return {
        method: "POST",
        path: `/api/storyboard/projects/${encodeURIComponent(reqStr(a, "id"))}/storyboard`,
        body: bodyWithout(a, "id"),
      };
    },
  },
  {
    name: "update_project",
    description:
      "PATCH /api/storyboard/projects/:id. Update a project's metadata. Body: { name?, prefs?, " +
      "storyboard? }. NOTE THE STUDIO'S EITHER/OR: if `storyboard` is present the route saves the " +
      "storyboard and does NOT apply `name` or `prefs` in the same call. Send metadata and a " +
      "storyboard as two calls, or use `save_storyboard` for the storyboard, which is the route " +
      "that only ever does one thing.",
    inputSchema: OBJ(
      {
        id: STR("Project public id."),
        name: STR("New display name."),
        prefs: { type: "object", description: "Replacement preferences object." },
        storyboard: {
          type: "object",
          description: "If present, this is saved and name/prefs are ignored for this call.",
        },
      },
      ["id"],
    ),
    build: (a) => ({
      method: "PATCH",
      path: `/api/storyboard/projects/${encodeURIComponent(reqStr(a, "id"))}`,
      body: bodyWithout(a, "id"),
    }),
  },
  {
    name: "delete_project",
    description:
      "DELETE /api/storyboard/projects/:id. Delete a project. Returns { ok: true, deleted: <id> }, " +
      "or 404 if the id is unknown. IRREVERSIBLE.",
    inputSchema: OBJ({ id: STR("Project public id.") }, ["id"]),
    build: (a) => ({
      method: "DELETE",
      path: `/api/storyboard/projects/${encodeURIComponent(reqStr(a, "id"))}`,
    }),
  },
  {
    name: "render_tags",
    description:
      "GET /api/storyboard/renders/tags. Every tag in use across the render library, as " +
      "{ tags: string[] }. Read this before setting tags with `update_render` so an agent reuses " +
      "the vocabulary a human already established instead of inventing a parallel one.",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/storyboard/renders/tags" }),
  },
  {
    name: "update_render",
    description:
      "PATCH /api/storyboard/renders/:id. Organize a render-library row: { label?, lockedShots?, " +
      "folderPath?, tags? }. Only the fields you send are applied, each normalized by the studio. " +
      "Unlike most studio replies this one is the RenderRow ITSELF, not wrapped in a resource key. " +
      "404 if the id is unknown.",
    inputSchema: OBJ(
      {
        id: STR("Render row public id (from list_renders)."),
        label: STR("Human label for the row; null or empty clears it."),
        lockedShots: ARR("Shot ids to keep pinned across re-renders."),
        folderPath: STR("Library folder path for the row."),
        tags: ARR("Tags for the row (see render_tags for the vocabulary in use)."),
      },
      ["id"],
    ),
    build: (a) => ({
      method: "PATCH",
      path: `/api/storyboard/renders/${encodeURIComponent(reqStr(a, "id"))}`,
      body: bodyWithout(a, "id"),
    }),
  },
  {
    name: "delete_render",
    description:
      "DELETE /api/storyboard/renders/:id. Remove a render-library row. Returns { ok: true }, or " +
      "404 if the id is unknown. IRREVERSIBLE.",
    inputSchema: OBJ({ id: STR("Render row public id (from list_renders).") }, ["id"]),
    build: (a) => ({
      method: "DELETE",
      path: `/api/storyboard/renders/${encodeURIComponent(reqStr(a, "id"))}`,
    }),
  },

  // --- finishing a COMPLETED render (cf#317) -----------------------------------
  // Only the two synchronous, door-independent finishing routes are curated here. finalize /
  // animate-cloud / animate-hybrid / regen-shot each START a new render job whose only poll route is
  // GET /api/storyboard/render/:jobId, which cf#334 is reconciling; a submit tool with no poll tool
  // is half a capability, so those stay on studio_request until that lands.
  {
    name: "add_render_audio",
    description:
      "POST /api/storyboard/renders/:id/add-audio. Mux a staged audio bed onto a FINISHED render, " +
      "off the GPU. Body: { audioKey (req) } -- the key from `upload_audio` or a generated bed. " +
      "Returns { ok: true, output_key }; a mux failure is a 422 with the reason. Synchronous: no " +
      "job to poll.",
    inputSchema: OBJ(
      {
        id: STR("Render row public id (from list_renders)."),
        audioKey: STR("Staged audio key to mux onto the film."),
      },
      ["id", "audioKey"],
    ),
    build: (a) => {
      reqStr(a, "audioKey");
      return {
        method: "POST",
        path: `/api/storyboard/renders/${encodeURIComponent(reqStr(a, "id"))}/add-audio`,
        body: bodyWithout(a, "id"),
      };
    },
  },
  {
    name: "add_render_narration",
    description:
      "POST /api/storyboard/renders/:id/add-narration. Generate a narration track from text and mux " +
      "it onto a FINISHED render. THIS SPENDS (TTS inference, not GPU render). Body: { text (req), " +
      "module?, config? }. The studio generates and muxes inside the one request, so this call can " +
      "take tens of seconds; it answers { ok: true, output_key, module, label }, 422 if generation " +
      "or mux fails, or 504 if generation does not finish inside the studio's bounded wait. A 504 " +
      "means TRY AGAIN, not that the render is broken.",
    inputSchema: OBJ(
      {
        id: STR("Render row public id (from list_renders)."),
        text: STR("The narration script to speak."),
        module: STR("Optional specific narration module name (see studio_modules)."),
        config: { type: "object", description: "Optional module config for the narration run." },
      },
      ["id", "text"],
    ),
    build: (a) => {
      reqStr(a, "text");
      return {
        method: "POST",
        path: `/api/storyboard/renders/${encodeURIComponent(reqStr(a, "id"))}/add-narration`,
        body: bodyWithout(a, "id"),
      };
    },
  },

  // --- cast -------------------------------------------------------------------
  {
    name: "create_cast",
    description: "POST /api/cast. Create a cast member. Body: { name (req), bible? }.",
    inputSchema: OBJ(
      { name: STR("Display name."), bible: STR("Character description / bible.") },
      ["name"],
    ),
    build: (a) => {
      reqStr(a, "name");
      return { method: "POST", path: "/api/cast", body: bodyWithout(a) };
    },
  },
  {
    name: "update_cast",
    description:
      "PATCH /api/cast/:id. Update a cast member. Body: { name?, bible?, voice_id? }. voice_id must " +
      "be one of the 12 ids from `voices` (or null/\"\" to clear).",
    inputSchema: OBJ(
      {
        id: STR("Cast member public id."),
        name: STR("New display name."),
        bible: STR("New character bible."),
        voice_id: STR("Aura-1 voice id (see `voices`), or empty to clear."),
      },
      ["id"],
    ),
    build: (a) => ({
      method: "PATCH",
      path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}`,
      body: bodyWithout(a, "id"),
    }),
  },
  {
    name: "set_cast_portrait",
    description:
      "POST /api/cast/:id/portrait. Set a cast member's portrait (the identity seed). Body: " +
      "{ from_chat_artifact (req) } -- despite the name this copies from ANY studio artifact key, " +
      "not only a `chat` one, so it takes a key from `chat` (output_artifact.key) or from a keyframe " +
      "or ref you already have. The studio's sibling { key, mime } form is NARROWER than CONTRACT.md " +
      "implies: it requires a key already staged under cast/<internal id>/, so a general staged key " +
      "is refused there. Use this form.",
    inputSchema: OBJ(
      {
        id: STR("Cast member public id."),
        from_chat_artifact: STR("The output_artifact.key returned by a `chat` image call."),
      },
      ["id", "from_chat_artifact"],
    ),
    build: (a) => {
      reqStr(a, "from_chat_artifact");
      return {
        method: "POST",
        path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}/portrait`,
        body: bodyWithout(a, "id"),
      };
    },
  },

  {
    name: "delete_cast",
    description:
      "DELETE /api/cast/:id. Delete a cast member and reclaim its R2 artifacts (portrait, refs, " +
      "sources). Returns { ok: true, deleted: <id> }, or 404 if the id is unknown. IRREVERSIBLE, " +
      "and it takes the trained LoRA's binding with it.",
    inputSchema: OBJ({ id: STR("Cast member public id.") }, ["id"]),
    build: (a) => ({ method: "DELETE", path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}` }),
  },
  {
    name: "clear_cast_portrait",
    description:
      "DELETE /api/cast/:id/portrait. Clear a cast member's portrait and delete the R2 object " +
      "(best-effort, so a missing object never blocks the clear). Returns { cast }.",
    inputSchema: OBJ({ id: STR("Cast member public id.") }, ["id"]),
    build: (a) => ({
      method: "DELETE",
      path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}/portrait`,
    }),
  },
  {
    name: "add_cast_ref",
    description:
      "POST /api/cast/:id/ref. Add a LoRA TRAINING REFERENCE image to a cast member -- the set " +
      "`train_cast_lora` learns the character's face from. Body: { from_chat_artifact (req) }, an " +
      "existing studio artifact key (from `chat`, from `upload_image`, or any artifact you can " +
      "name); the studio copies it under cast/<id>/refs/. Returns { cast }. Use " +
      "`generate_cast_refs` instead when you want the studio to SYNTHESIZE a set from the portrait.",
    inputSchema: OBJ(
      {
        id: STR("Cast member public id."),
        from_chat_artifact: STR("An existing studio artifact key to copy in as a reference."),
      },
      ["id", "from_chat_artifact"],
    ),
    build: (a) => {
      reqStr(a, "from_chat_artifact");
      return {
        method: "POST",
        path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}/ref`,
        body: bodyWithout(a, "id"),
      };
    },
  },
  {
    name: "remove_cast_ref",
    description:
      "DELETE /api/cast/:id/refs/<refKey>. Remove one training reference from a cast member and " +
      "delete its R2 object. `ref_key` is the full key as `get_cast` reports it (e.g. " +
      "'cast/7/refs/<uuid>.png'); it spans slashes, so it goes in the PATH. The studio also accepts " +
      "the key in a JSON body on /ref, but no MCP tool can use that: a DELETE never carries a body " +
      "here. 404 if the key is not in this member's set.",
    inputSchema: OBJ(
      {
        id: STR("Cast member public id."),
        ref_key: STR("The reference key to remove, as reported by get_cast."),
      },
      ["id", "ref_key"],
    ),
    build: (a) => ({
      method: "DELETE",
      path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}/refs/${keyPath(reqStr(a, "ref_key"))}`,
    }),
  },
  {
    name: "add_cast_source",
    description:
      "POST /api/cast/:id/source. Add a SOURCE photo to a cast member: extra conditioning material, " +
      "distinct from the training reference set. Body: { from_chat_artifact (req) }, an existing " +
      "studio artifact key (see `upload_image` to bring your own bytes in). Source keys are what " +
      "`generate_cast_refs` takes as `source_keys`. Returns { cast }.",
    inputSchema: OBJ(
      {
        id: STR("Cast member public id."),
        from_chat_artifact: STR("An existing studio artifact key to copy in as a source photo."),
      },
      ["id", "from_chat_artifact"],
    ),
    build: (a) => {
      reqStr(a, "from_chat_artifact");
      return {
        method: "POST",
        path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}/source`,
        body: bodyWithout(a, "id"),
      };
    },
  },
  {
    name: "remove_cast_source",
    description:
      "DELETE /api/cast/:id/source/<sourceKey>. Remove one source photo and delete its R2 object. " +
      "`source_key` is the full key as `get_cast` reports it; it spans slashes, so it goes in the " +
      "PATH (a DELETE carries no body here). 404 if the key is not in this member's set.",
    inputSchema: OBJ(
      {
        id: STR("Cast member public id."),
        source_key: STR("The source key to remove, as reported by get_cast."),
      },
      ["id", "source_key"],
    ),
    build: (a) => ({
      method: "DELETE",
      path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}/source/${keyPath(reqStr(a, "source_key"))}`,
    }),
  },
  {
    name: "generate_cast_refs",
    description:
      "POST /api/cast/:id/generate-refs. THIS SPENDS (image inference). Ask the installed cast.image " +
      "module to SYNTHESIZE a LoRA training reference set for this cast member from its portrait. " +
      "Body: { config?, art_style?, source_keys?, choice? }. Returns 201 with a job summary carrying " +
      "`job_id` and `phase`; the set cannot finish in one request, so POLL `poll_cast_refs` with that " +
      "job_id until phase is 'done' or 'failed'. Set the portrait FIRST (set_cast_portrait): the " +
      "portrait is the identity the set is generated from.",
    inputSchema: OBJ(
      {
        id: STR("Cast member public id."),
        config: { type: "object", description: "cast.image module config overrides." },
        art_style: STR("Art-style lead, e.g. 'anime'; blank keeps the photographic templates."),
        source_keys: ARR("R2 keys of source photos to condition on (see add_cast_source)."),
        choice: STR("Which cast.image module to use, when several are installed."),
      },
      ["id"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}/generate-refs`,
      body: bodyWithout(a, "id"),
    }),
  },
  {
    name: "poll_cast_refs",
    description:
      "GET /api/cast/:id/refs-job/:jobId. Advance + poll a ref-generation job one tick. Returns " +
      "{ job_id, cast_id, phase, module?, registered, images, error? }. Call repeatedly until phase " +
      "is 'done' or 'failed'. `registered` is how many generated images are already on the member, " +
      "so it moves while the job runs; `images` carries the keys, which `view_artifact` can show you.",
    inputSchema: OBJ(
      {
        id: STR("Cast member public id."),
        job_id: STR("The job_id returned by generate_cast_refs."),
      },
      ["id", "job_id"],
    ),
    build: (a) => ({
      method: "GET",
      path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}/refs-job/${encodeURIComponent(reqStr(a, "job_id"))}`,
    }),
  },
  {
    name: "train_cast_lora",
    description:
      "POST /api/cast/:id/train-lora. THIS SPENDS GPU TIME (a training run, on the order of tens of " +
      "minutes). Trains the character's identity LoRA from the member's reference set and banks the " +
      "adapter back onto the member, so a character is trained ONCE and reused across every project. " +
      "Body: { renderOverrides? }. Returns { ok, jobId, status, bundleKey, loraDestKey, cast }; then " +
      "poll `cast_lora_status`. Add references first (add_cast_ref / generate_cast_refs) -- training " +
      "an empty set is the expensive way to learn nothing.",
    inputSchema: OBJ(
      {
        id: STR("Cast member public id."),
        renderOverrides: { type: "object", description: "Optional training overrides bag." },
      },
      ["id"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}/train-lora`,
      body: bodyWithout(a, "id"),
    }),
  },
  {
    name: "cast_lora_status",
    description:
      "GET /api/cast/:id/lora-status. The cast member's LoRA training state: lora_status is one of " +
      "'idle' | 'training' | 'ready' | 'failed', plus lora_job_id and lora_error. Poll this after " +
      "train_cast_lora. Only a 'ready' member contributes a real identity LoRA to a render; binding " +
      "an untrained one is how a film ships generic-looking characters.",
    inputSchema: OBJ({ id: STR("Cast member public id.") }, ["id"]),
    build: (a) => ({
      method: "GET",
      path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}/lora-status`,
    }),
  },

  // --- planning ---------------------------------------------------------------
  {
    name: "plan_storyboard",
    description:
      "POST /api/storyboard/plan. Plan a storyboard from a brief with an LLM. Body: { brief (req), " +
      "model (req), characters?, beatBlock? }. Returns a validated storyboard (200) or the model " +
      "errors (422). Use `storyboard_models` for valid model ids.",
    inputSchema: OBJ(
      {
        brief: STR("The film brief / prompt to plan from."),
        model: STR("Planning model id (see storyboard_models)."),
        characters: ARR("Optional character definitions."),
        beatBlock: STR("Optional beat structure block."),
      },
      ["brief", "model"],
    ),
    build: (a) => {
      reqStr(a, "brief");
      reqStr(a, "model");
      return { method: "POST", path: "/api/storyboard/plan", body: bodyWithout(a) };
    },
  },
  {
    name: "refine_storyboard",
    description:
      "POST /api/storyboard/refine. Refine an existing storyboard with an instruction. Body: " +
      "{ storyboard (req), message (req), model (req) }. Returns a validated storyboard (200) or " +
      "errors (422).",
    inputSchema: OBJ(
      {
        storyboard: { type: "object", description: "The storyboard to refine." },
        message: STR("The refinement instruction."),
        model: STR("Planning model id (see storyboard_models)."),
      },
      ["storyboard", "message", "model"],
    ),
    build: (a) => {
      reqStr(a, "message");
      reqStr(a, "model");
      if (typeof a.storyboard !== "object" || a.storyboard === null) {
        throw new Error("missing required argument 'storyboard'");
      }
      return { method: "POST", path: "/api/storyboard/refine", body: bodyWithout(a) };
    },
  },
  {
    name: "preflight",
    description:
      "POST /api/storyboard/preflight. Pre-render validation. Returns 200 with { ok, counts, issues }: " +
      "problems are DATA, not an HTTP error. Run before submit_film to catch blockers. Body: " +
      "{ storyboard (req), castBindings?, motionBackend?, quality? }. " +
      "Pass motionBackend (+ optional quality) so duration-grid clamp warnings/errors fire (#707/#751). " +
      "Does NOT validate bundleKey or audioKey -- those fields are not read by the route (mcp#26); " +
      "do not pass them expecting a check.",
    inputSchema: OBJ(
      {
        storyboard: { type: "object", description: "The storyboard to validate." },
        castBindings: {
          type: "object",
          description:
            "{ [slot]: cast_id } bindings. cast_id is the cast member's public id (the `id` " +
            "returned by list_cast / get_cast); the internal numeric row id also works.",
        },
        motionBackend: STR(
          "A motion.backend module name (from studio_modules). When the module declares a " +
          "duration_grid, preflight warns/errors on shots that exceed it (#707/#751).",
        ),
        quality: STR(
          "draft | standard | final -- quality tier for the duration-grid clamp when motionBackend " +
          "is set. Omitted, the module's default tier is used for the grid lookup.",
        ),
      },
      ["storyboard"],
    ),
    build: (a) => {
      if (typeof a.storyboard !== "object" || a.storyboard === null) {
        throw new Error("missing required argument 'storyboard'");
      }
      // Forward only fields the studio route reads (mcp#26). bodyWithout would still pass a
      // stale bundleKey/audioKey from a client, but the schema no longer advertises them.
      const body: Record<string, unknown> = { storyboard: a.storyboard };
      if (a.castBindings !== undefined) body.castBindings = a.castBindings;
      if (a.motionBackend !== undefined) body.motionBackend = a.motionBackend;
      if (a.quality !== undefined) body.quality = a.quality;
      return { method: "POST", path: "/api/storyboard/preflight", body };
    },
  },
  {
    name: "chat",
    description:
      "POST /api/chat. Planner assistant / image generation. Body: { model (req), user_input (req), " +
      "... }. An image model returns { output_artifact: { key, mime } } (feed key to set_cast_portrait); " +
      "a text model returns { output }. Use `storyboard_models` / the module registry for model ids.",
    inputSchema: OBJ(
      {
        model: STR("Model id (text or image)."),
        user_input: STR("The prompt."),
      },
      ["model", "user_input"],
    ),
    build: (a) => {
      reqStr(a, "model");
      reqStr(a, "user_input");
      return { method: "POST", path: "/api/chat", body: bodyWithout(a) };
    },
  },

  // --- render (spend) ---------------------------------------------------------
  {
    name: "bundle_storyboard",
    description:
      "POST /api/storyboard/bundle. Assemble a render bundle (storyboard + cast refs) and return its " +
      "R2 bundleKey, the input to submit_film. Body: { storyboard (req), characterRefs (req), ... }. " +
      "characterRefs is { [slot]: { ... } } (see docs/CAST-BUNDLE.md / the Slate client).",
    inputSchema: OBJ(
      {
        storyboard: { type: "object", description: "The storyboard to bundle." },
        characterRefs: { type: "object", description: "{ [slot]: ref } cast references." },
      },
      ["storyboard", "characterRefs"],
    ),
    build: (a) => {
      if (typeof a.storyboard !== "object" || a.storyboard === null) {
        throw new Error("missing required argument 'storyboard'");
      }
      if (typeof a.characterRefs !== "object" || a.characterRefs === null) {
        throw new Error("missing required argument 'characterRefs'");
      }
      return { method: "POST", path: "/api/storyboard/bundle", body: bodyWithout(a) };
    },
  },
  {
    name: "submit_film",
    description:
      "POST /api/render/film. START A FILM RENDER (this SPENDS: GPU / cloud i2v). Body: { bundle_key " +
      "(req, from bundle_storyboard), scenes (req: [{ shot_id, prompt, seconds }]), project?, " +
      "motion_backend?, keyframe_backend?, keyframe_config?, motion_config?, finish_config?, speech_config?, " +
      "film_finish_config?, master_config?, audio_key?, film_titles?, dialogue_lines?, cast_loras?, " +
      "qualityTier? }. " +
      "Each *_config is { [moduleName]: config }, feeding one hook stage: finish_config -> the per-shot " +
      "finish chain, speech_config -> the speech (dialogue-audio) chain, film_finish_config -> the " +
      "film.finish chain on the assembled film (this is where SUBTITLE mode burn/sidecar/both and the " +
      "film-titles knobs live; putting subtitle config in finish_config silently no-ops to burn), " +
      "master_config -> the master (audio bed) chain. Returns { film_id, phase }. Then POLL poll_film until phase is " +
      "done/failed. Set motion_backend and keyframe_backend explicitly (names from studio_modules " +
      "hooks['motion.backend'] / hooks['keyframe']); an omitted backend can pick a non-operational " +
      "door (#380). qualityTier (draft/standard/final, also in studio_modules render.quality_tiers) " +
      "labels the render-history row with what was requested; omitted, the row records \"final\" " +
      "regardless of what actually ran (#382) -- it does not change what renders. VOICES: pass " +
      "cast_loras so dialogue speaks with each cast member's voice; explicit dialogue_lines win over " +
      "bundle-derived ones, and a line's own voice_id wins over the cast voice. Without cast_loras or " +
      "voice_id, dialogue falls to the studio default voice.",
    inputSchema: OBJ(
      {
        bundle_key: STR("The bundleKey from bundle_storyboard."),
        scenes: ARR("[{ shot_id, prompt, seconds }] -- non-empty."),
        project: STR("Project namespace (derived from bundle_key if omitted)."),
        motion_backend: STR("A motion.backend module name (from studio_modules)."),
        keyframe_backend: STR(
          "A keyframe module name (from studio_modules hooks['keyframe']). Omitted, selection " +
          "falls to the first serving module for that hook, which can be a non-operational door " +
          "(#380).",
        ),
        keyframe_config: { type: "object", description: "Keyframe module config (e.g. { quality_tier })." },
        motion_config: { type: "object", description: "Motion module config." },
        finish_config: { type: "object", description: "{ [moduleName]: config } for the per-shot finish chain." },
        speech_config: { type: "object", description: "{ [moduleName]: config } for the speech (dialogue-audio) chain." },
        film_finish_config: { type: "object", description: "{ [moduleName]: config } for the film.finish chain on the assembled film; where subtitle mode (burn/sidecar/both) and the film-titles knobs live." },
        master_config: { type: "object", description: "{ [moduleName]: config } for the master (audio bed) chain." },
        audio_key: STR("Staged audio bed to mux after assemble."),
        film_titles: { type: "object", description: "{ title?: { text, subtitle? }, credits?: { lines } }." },
        dialogue_lines: ARR(
          "[{ shot_id, text, voice_id? }] spoken lines for TTS + captions. voice_id (a name from the " +
          "voices tool) overrides the speaker's cast voice; omit it and pass cast_loras to use the " +
          "cast member's own voice.",
        ),
        cast_loras: {
          type: "object",
          description:
            "{ [slot]: castId } -- bind storyboard character slots (A, B, ...) to cast ids (from " +
            "list_cast). Drives the keyframe LoRAs AND each speaking slot's voice; without it, " +
            "dialogue voices fall to the default.",
        },
        qualityTier: STR(
          "draft | standard | final (also listed in studio_modules render.quality_tiers). Labels " +
          "the render-history row with the tier requested; omitted, the row records \"final\" " +
          "regardless of what actually ran (#382). Does not change the actual render tier, which " +
          "is driven by keyframe_config / motion_config.",
        ),
      },
      ["bundle_key", "scenes"],
    ),
    build: (a) => {
      reqStr(a, "bundle_key");
      if (!Array.isArray(a.scenes) || a.scenes.length === 0) {
        throw new Error("missing required argument 'scenes' (non-empty array)");
      }
      return { method: "POST", path: "/api/render/film", body: bodyWithout(a) };
    },
  },
  {
    name: "poll_film",
    description:
      "GET /api/render/film/:id. Advance + poll a film job one tick. Returns { phase, clips?, finish?, " +
      "film_key?, download_url? }. Call repeatedly until phase is 'done' (a presigned download_url is " +
      "then present, 6h TTL) or 'failed'. Phases: keyframe, clips, dialogue, speech, finish, assemble, " +
      "master, mux, done, failed.",
    inputSchema: OBJ({ id: STR("The film-<...> job id from submit_film.") }, ["id"]),
    build: (a) => ({
      method: "GET",
      path: `/api/render/film/${encodeURIComponent(reqStr(a, "id"))}`,
    }),
  },

  // --- bytes IN (cf#317: bring your own image or audio) ------------------------
  // These two are the ONLY way an agent gets its own bytes into the studio. `studio_request` cannot
  // stand in for them: it sends application/json, and all three of the studio's upload routes read a
  // raw body and reject a JSON content-type, so those routes were not reachable by any MCP means.
  {
    name: "upload_image",
    description:
      "POST /api/upload. BRING AN IMAGE INTO THE STUDIO (the bytes-in door for pictures). Pass the " +
      "image as base64 in `data_base64` plus its `mime`; returns { key, mime, size }. Use the " +
      "returned key as `from_chat_artifact` on set_cast_portrait / add_cast_ref / add_cast_source -- " +
      "that argument copies from ANY studio artifact key, not only a `chat` one, and it is the path " +
      "that works (the `key` + `mime` form of those tools only accepts a key already staged under " +
      "cast/<internal id>/). The studio takes png/jpeg/webp/gif here and is the authority on that; " +
      "note CAST media is narrower and refuses gif, so upload png/jpeg/webp for anything going onto " +
      "a cast member. Pass the base64 payload ALONE, with no 'data:...;base64,' prefix.",
    inputSchema: OBJ(
      {
        data_base64: STR("The image bytes, base64-encoded, with no data: URL prefix."),
        mime: STR("The image media type, e.g. 'image/png' | 'image/jpeg' | 'image/webp'."),
      },
      ["data_base64", "mime"],
    ),
    build: (a) => ({ method: "POST", path: "/api/upload", rawBody: rawBytesArg(a) }),
  },
  {
    name: "upload_audio",
    description:
      "POST /api/storyboard/audio-upload. BRING AUDIO INTO THE STUDIO (the bytes-in door for sound): " +
      "a music bed, a pre-recorded narration, any track you want muxed onto a film. Pass the audio " +
      "as base64 in `data_base64` plus its `mime`; returns { key, mime, size }. That key is " +
      "submit_film's `audio_key` and add_render_audio's `audioKey`. The studio takes " +
      "mp3/wav/aac/m4a/ogg/webm here and is the authority on that. Pass the base64 payload ALONE, " +
      "with no 'data:...;base64,' prefix.",
    inputSchema: OBJ(
      {
        data_base64: STR("The audio bytes, base64-encoded, with no data: URL prefix."),
        mime: STR("The audio media type, e.g. 'audio/mpeg' | 'audio/wav' | 'audio/mp4'."),
      },
      ["data_base64", "mime"],
    ),
    build: (a) => ({
      method: "POST",
      path: "/api/storyboard/audio-upload",
      rawBody: rawBytesArg(a),
    }),
  },

  // --- artifacts (cf#317: see what you made) -----------------------------------
  {
    name: "view_artifact",
    description:
      "GET /api/artifact/<key>. LOOK AT an artifact. An IMAGE (keyframe, cast portrait, character " +
      "ref, a still from `chat`) is returned inline so you can actually see it. Video and audio " +
      "cannot be inlined by MCP: for those use `artifact_url` and open/fetch the presigned link. " +
      "Keys come from list_renders (output_key, keyframes[].key), get_cast (portrait_key, refs), " +
      "or a chat image reply (output_artifact.key).",
    inputSchema: OBJ(
      { key: STR("The R2 artifact key, e.g. 'renders/film-<id>/film.mp4' or 'cast/portrait.png'.") },
      ["key"],
    ),
    inlineImages: true,
    build: (a) => ({ method: "GET", path: `/api/artifact/${keyPath(reqStr(a, "key"))}` }),
  },
  {
    name: "artifact_url",
    description:
      "GET /api/artifact-url/<key>. Turn an artifact key into a SHORT-LIVED presigned download URL " +
      "plus its real content-type and byte size. This is how a finished film gets watched: the URL " +
      "opens directly in a browser with no studio credential. The link is a capability -- anyone " +
      "holding it can fetch that one object until it expires -- so it is scoped to the single key " +
      "and clamped to at most 1 hour (default 5 minutes). Ask for a fresh one rather than storing it.",
    inputSchema: OBJ(
      {
        key: STR("The R2 artifact key (see view_artifact)."),
        expires_in: NUM("Link lifetime in seconds. Clamped to [60, 3600]; default 300."),
      },
      ["key"],
    ),
    build: (a) => ({
      method: "GET",
      path: `/api/artifact-url/${keyPath(reqStr(a, "key"))}`,
      query: { expires_in: a.expires_in as number | undefined },
    }),
  },

  // --- studio identity / prefs / storage / modules (1.3 panel parity) -----------
  {
    name: "whoami",
    description:
      "GET /api/whoami. Studio identity (token mode returns a fixed operator identity; no email leak).",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/whoami" }),
  },
  {
    name: "get_prefs",
    description: "GET /api/prefs. Operator prefs (planner model defaults, UI knobs the panel stores).",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/prefs" }),
  },
  {
    name: "set_prefs",
    description:
      "PATCH /api/prefs. Merge operator prefs. Body is forwarded; unknown keys are the studio's rule.",
    inputSchema: OBJ(
      {
        prefs: {
          type: "object",
          description: "Prefs object to merge (or pass fields at the top level; both are accepted).",
        },
      },
    ),
    build: (a) => {
      const body =
        a.prefs && typeof a.prefs === "object"
          ? a.prefs
          : bodyWithout(a);
      return { method: "PATCH", path: "/api/prefs", body };
    },
  },
  {
    name: "storage_usage",
    description:
      "GET /api/storage/usage. Ledger usage: used_bytes, objects, quota_bytes, over.",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/storage/usage" }),
  },
  {
    name: "storage_reconcile",
    description:
      "POST /api/storage/reconcile. Rebuild the storage ledger from object store inventory (operator maintenance).",
    inputSchema: OBJ({}),
    build: () => ({ method: "POST", path: "/api/storage/reconcile", body: {} }),
  },
  {
    name: "list_models",
    description: "GET /api/models. Planning/chat model catalog (sibling of storyboard_models).",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/models" }),
  },
  {
    name: "list_installed_modules",
    description: "GET /api/modules/installed. Installed dynamic module rows.",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/modules/installed" }),
  },
  {
    name: "install_module",
    description:
      "POST /api/modules/install. Install a module script from the dispatch namespace. Body: " +
      "{ script_name (req) }. Needs MODULE_DISPATCH on the host.",
    inputSchema: OBJ({ script_name: STR("Worker script name in the modules dispatch namespace.") }, [
      "script_name",
    ]),
    build: (a) => ({
      method: "POST",
      path: "/api/modules/install",
      body: { script_name: reqStr(a, "script_name") },
    }),
  },
  {
    name: "uninstall_module",
    description: "DELETE /api/modules/install/:name. Remove an installed module.",
    inputSchema: OBJ({ name: STR("Module name.") }, ["name"]),
    build: (a) => ({
      method: "DELETE",
      path: `/api/modules/install/${encodeURIComponent(reqStr(a, "name"))}`,
    }),
  },
  {
    name: "set_module_enabled",
    description: "PATCH /api/modules/install/:name. Enable or disable an installed module.",
    inputSchema: OBJ(
      {
        name: STR("Module name."),
        enabled: { type: "boolean", description: "true = enabled, false = disabled." },
      },
      ["name", "enabled"],
    ),
    build: (a) => {
      if (typeof a.enabled !== "boolean") throw new Error("'enabled' must be a boolean");
      return {
        method: "PATCH",
        path: `/api/modules/install/${encodeURIComponent(reqStr(a, "name"))}`,
        body: { enabled: a.enabled },
      };
    },
  },
  {
    name: "get_module_config",
    description:
      "GET /api/modules/:name/config. Install-scope config for one module (defaults filled).",
    inputSchema: OBJ({ name: STR("Module name.") }, ["name"]),
    build: (a) => ({
      method: "GET",
      path: `/api/modules/${encodeURIComponent(reqStr(a, "name"))}/config`,
    }),
  },
  {
    name: "patch_module_config",
    description:
      "PATCH /api/modules/:name/config. Patch install-scope fields only (render-scope keys dropped).",
    inputSchema: OBJ(
      {
        name: STR("Module name."),
        config: { type: "object", description: "{ field: value } install-scope patch." },
      },
      ["name", "config"],
    ),
    build: (a) => {
      if (typeof a.config !== "object" || a.config === null) {
        throw new Error("missing required argument 'config'");
      }
      return {
        method: "PATCH",
        path: `/api/modules/${encodeURIComponent(reqStr(a, "name"))}/config`,
        body: a.config,
      };
    },
  },
  {
    name: "train_cast_wan_lora",
    description:
      "POST /api/cast/:id/train-wan-lora. THIS SPENDS GPU (Wan cast LoRA train). Needs " +
      "RUNPOD_WAN_TRAIN_ENDPOINT_ID on the host. Sibling of train_cast_lora (SDXL).",
    inputSchema: OBJ(
      {
        id: STR("Cast member id."),
        renderOverrides: { type: "object", description: "Optional train overrides." },
      },
      ["id"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/cast/${encodeURIComponent(reqStr(a, "id"))}/train-wan-lora`,
      body: bodyWithout(a, "id"),
    }),
  },
  {
    name: "export_cast",
    description:
      "GET /api/cast/export/:id. Export a .vvcast tar bundle. Binary is summarized (not dumped); " +
      "use studio_request + a client that can store bytes, or host-side export, for the file itself.",
    inputSchema: OBJ({ id: STR("Cast member id.") }, ["id"]),
    build: (a) => ({
      method: "GET",
      path: `/api/cast/export/${encodeURIComponent(reqStr(a, "id"))}`,
    }),
  },
  {
    name: "import_cast",
    description:
      "POST /api/cast/import. Import a .vvcast tar (raw body). Pass data_base64 of the tar bytes; " +
      "mime application/x-tar. Returns the imported cast member.",
    inputSchema: OBJ(
      {
        data_base64: STR("The .vvcast tar bytes, base64-encoded."),
        mime: STR("Usually application/x-tar."),
      },
      ["data_base64", "mime"],
    ),
    build: (a) => ({ method: "POST", path: "/api/cast/import", rawBody: rawBytesArg(a) }),
  },
  {
    name: "score_bed",
    description:
      "POST /api/storyboard/score-bed (music generate). Starts a score/music job. Poll with poll_job.",
    inputSchema: OBJ(
      {
        storyboard: { type: "object", description: "Storyboard context for the score." },
        prompt: STR("Optional music prompt override."),
      },
    ),
    build: (a) => ({
      method: "POST",
      path: "/api/storyboard/score-bed",
      body: bodyWithout(a),
    }),
  },
  {
    name: "poll_job",
    description:
      "GET /api/job/:id. Poll a generic studio job (score-bed, enhance, etc.) until done/failed.",
    inputSchema: OBJ({ id: STR("Job id from score_bed or similar.") }, ["id"]),
    build: (a) => ({
      method: "GET",
      path: `/api/job/${encodeURIComponent(reqStr(a, "id"))}`,
    }),
  },
  {
    name: "enhance_storyboard",
    description: "POST /api/storyboard/enhance. LLM enhance pass on a storyboard (inference spend).",
    inputSchema: OBJ(
      { storyboard: { type: "object", description: "Storyboard to enhance." } },
      ["storyboard"],
    ),
    build: (a) => {
      if (typeof a.storyboard !== "object" || a.storyboard === null) {
        throw new Error("missing required argument 'storyboard'");
      }
      return { method: "POST", path: "/api/storyboard/enhance", body: bodyWithout(a) };
    },
  },
  {
    name: "storyboard_yaml",
    description: "POST /api/storyboard/yaml. Convert / validate storyboard YAML forms.",
    inputSchema: OBJ(
      {
        yaml: STR("YAML text."),
        storyboard: { type: "object", description: "Or pass a storyboard object." },
      },
    ),
    build: (a) => ({ method: "POST", path: "/api/storyboard/yaml", body: bodyWithout(a) }),
  },
  {
    name: "storyboard_markers",
    description: "POST /api/storyboard/markers. Derive markers from a storyboard / audio analysis.",
    inputSchema: OBJ(
      { storyboard: { type: "object", description: "Storyboard context." } },
    ),
    build: (a) => ({ method: "POST", path: "/api/storyboard/markers", body: bodyWithout(a) }),
  },
  {
    name: "audio_analyze",
    description: "POST /api/audio/analyze. Analyze a staged audio key for beats/markers.",
    inputSchema: OBJ(
      { key: STR("Audio artifact key (from upload_audio).") },
      ["key"],
    ),
    build: (a) => ({
      method: "POST",
      path: "/api/audio/analyze",
      body: bodyWithout(a),
    }),
  },
  {
    name: "render_plan",
    description:
      "POST /api/storyboard/render-plan. Build a render plan without starting a spend render.",
    inputSchema: OBJ(
      { storyboard: { type: "object", description: "Storyboard to plan." } },
      ["storyboard"],
    ),
    build: (a) => {
      if (typeof a.storyboard !== "object" || a.storyboard === null) {
        throw new Error("missing required argument 'storyboard'");
      }
      return { method: "POST", path: "/api/storyboard/render-plan", body: bodyWithout(a) };
    },
  },
  {
    name: "submit_clips",
    description:
      "POST /api/render/clips. Start a clips-only render (SPENDS). Poll with poll_clips. " +
      "Prefer submit_film for full films; this is the clips sub-pipeline.",
    inputSchema: OBJ(
      {
        bundle_key: STR("Bundle key from bundle_storyboard."),
        scenes: ARR("[{ shot_id, prompt, seconds }]"),
      },
      ["bundle_key", "scenes"],
    ),
    build: (a) => {
      reqStr(a, "bundle_key");
      if (!Array.isArray(a.scenes) || a.scenes.length === 0) {
        throw new Error("missing required argument 'scenes' (non-empty array)");
      }
      return { method: "POST", path: "/api/render/clips", body: bodyWithout(a) };
    },
  },
  {
    name: "poll_clips",
    description: "GET /api/render/clips/:id. Poll a clips job from submit_clips.",
    inputSchema: OBJ({ id: STR("Clips job id.") }, ["id"]),
    build: (a) => ({
      method: "GET",
      path: `/api/render/clips/${encodeURIComponent(reqStr(a, "id"))}`,
    }),
  },
  {
    name: "render_frames",
    description:
      "POST /api/render/frames. Extract still frames from a render artifact (panel frame picker).",
    inputSchema: OBJ(
      {
        key: STR("Video artifact key."),
        times: ARR("Optional timestamps."),
      },
      ["key"],
    ),
    build: (a) => ({
      method: "POST",
      path: "/api/render/frames",
      body: bodyWithout(a),
    }),
  },
  {
    name: "demo_menu",
    description: "GET /api/demo/menu. Curated demo path menu (when the host enables demo mode).",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/demo/menu" }),
  },
  {
    name: "demo_chat",
    description: "POST /api/demo/chat. Demo-mode chat (curated, no open spend).",
    inputSchema: OBJ(
      { user_input: STR("Prompt."), model: STR("Optional model id.") },
      ["user_input"],
    ),
    build: (a) => ({
      method: "POST",
      path: "/api/demo/chat",
      body: bodyWithout(a),
    }),
  },
  {
    name: "demo_render",
    description: "POST /api/demo/render. Start a demo render. Poll with poll_demo_render.",
    inputSchema: OBJ(
      { id: STR("Demo recipe id from demo_menu.") },
      ["id"],
    ),
    build: (a) => ({
      method: "POST",
      path: "/api/demo/render",
      body: bodyWithout(a),
    }),
  },
  {
    name: "poll_demo_render",
    description: "GET /api/demo/render/:id. Poll a demo render job.",
    inputSchema: OBJ({ id: STR("Demo render job id.") }, ["id"]),
    build: (a) => ({
      method: "GET",
      path: `/api/demo/render/${encodeURIComponent(reqStr(a, "id"))}`,
    }),
  },

  // --- control plane (hosted platform admin; needs CONTROL_PLANE_* bindings) ---
  {
    name: "cp_whoami",
    description:
      "GET /api/admin/whoami. Operator identity + scopes for CONTROL_PLANE_ADMIN_TOKEN. " +
      "Call first when driving hosted ops.",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/admin/whoami", target: "control_plane" }),
  },
  {
    name: "cp_platform_config",
    description:
      "GET /api/platform/config. Public front-door projection (auth methods, signups flags). " +
      "No admin token required by the plane, but this Worker still sends the admin bearer if set.",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/platform/config", target: "control_plane" }),
  },
  {
    name: "cp_platform_version",
    description: "GET /api/platform/version. Control plane + pinned studio release on the wire.",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/platform/version", target: "control_plane" }),
  },
  {
    name: "cp_list_tenants",
    description:
      "GET /api/admin/tenants. Hosted tenant census (slug, status, suspended, account). " +
      "Requires tenants:read. This is how you find ten_ ids for bootstrap follow-ups.",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/admin/tenants", target: "control_plane" }),
  },
  {
    name: "cp_get_settings",
    description: "GET /api/admin/settings. Platform settings (e.g. signups_enabled).",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/admin/settings", target: "control_plane" }),
  },
  {
    name: "cp_set_settings",
    description:
      "POST /api/admin/settings. Flip platform settings (platform:settings). Body e.g. " +
      "{ signups_enabled: true|false }. Closing signups does not strand mid-onboarding accounts.",
    inputSchema: OBJ(
      {
        signups_enabled: {
          type: "boolean",
          description: "When set, updates the waitlist/signups gate.",
        },
      },
    ),
    build: (a) => ({
      method: "POST",
      path: "/api/admin/settings",
      body: bodyWithout(a),
      target: "control_plane",
    }),
  },
  {
    name: "cp_list_audit",
    description: "GET /api/admin/audit. Operator audit trail (tenants:read).",
    inputSchema: OBJ(
      {
        limit: NUM("Optional page size."),
        cursor: STR("Optional cursor."),
      },
    ),
    build: (a) => ({
      method: "GET",
      path: "/api/admin/audit",
      query: {
        limit: a.limit as number | undefined,
        cursor: a.cursor as string | undefined,
      },
      target: "control_plane",
    }),
  },
  {
    name: "cp_hosted_storage_usage",
    description: "GET /api/admin/r2-usage. Aggregate hosted R2 usage (not per-tenant content).",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/admin/r2-usage", target: "control_plane" }),
  },
  {
    name: "cp_reconcile_runpod",
    description:
      "POST /api/admin/reconcile/runpod. Operator brings a RunPod snapshot; plane reconciles " +
      "endpoint inventory (tenants:read).",
    inputSchema: OBJ(
      { body: { type: "object", description: "Reconciliation payload the plane expects." } },
    ),
    build: (a) => ({
      method: "POST",
      path: "/api/admin/reconcile/runpod",
      body: a.body && typeof a.body === "object" ? a.body : bodyWithout(a),
      target: "control_plane",
    }),
  },
  {
    name: "cp_llm_meter_run",
    description: "POST /api/admin/llm-meter/run. Force an LLM spend ingest tick (meter:operate).",
    inputSchema: OBJ({}),
    build: () => ({
      method: "POST",
      path: "/api/admin/llm-meter/run",
      body: {},
      target: "control_plane",
    }),
  },
  {
    name: "cp_meter_settle",
    description:
      "POST /api/admin/meter-settle. Force overage settlement from measured usage (meter:operate). " +
      "Not credits:write (does not mint money from nothing).",
    inputSchema: OBJ({}),
    build: () => ({
      method: "POST",
      path: "/api/admin/meter-settle",
      body: {},
      target: "control_plane",
    }),
  },
  {
    name: "cp_llm_spend",
    description: "GET /api/admin/llm-spend. LLM spend rollups (tenants:read).",
    inputSchema: OBJ(
      {
        tenant_id: STR("Optional ten_ filter."),
      },
    ),
    build: (a) => ({
      method: "GET",
      path: "/api/admin/llm-spend",
      query: { tenant_id: a.tenant_id as string | undefined },
      target: "control_plane",
    }),
  },
  {
    name: "cp_kek_status",
    description: "GET /api/admin/kek/status. KEK rotation status (keys:rotate).",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/admin/kek/status", target: "control_plane" }),
  },
  {
    name: "cp_kek_reencrypt",
    description: "POST /api/admin/kek/reencrypt. Start KEK re-encryption sweep (keys:rotate).",
    inputSchema: OBJ({}),
    build: () => ({
      method: "POST",
      path: "/api/admin/kek/reencrypt",
      body: {},
      target: "control_plane",
    }),
  },
  {
    name: "cp_list_operators",
    description: "GET /api/admin/operators. List operator credentials (root only).",
    inputSchema: OBJ({}),
    build: () => ({ method: "GET", path: "/api/admin/operators", target: "control_plane" }),
  },
  {
    name: "cp_create_operator",
    description:
      "POST /api/admin/operators. Mint a scoped operator credential (root only). Plaintext token " +
      "is returned ONCE -- store it; the plane keeps only a hash.",
    inputSchema: OBJ(
      {
        name: STR("Operator display name (unique among live credentials)."),
        scopes: ARR("Scope strings from the catalogue (tenants:read, studio:operate, ...)."),
        expires_at: STR("Optional ISO expiry."),
      },
      ["name", "scopes"],
    ),
    build: (a) => ({
      method: "POST",
      path: "/api/admin/operators",
      body: bodyWithout(a),
      target: "control_plane",
    }),
  },
  {
    name: "cp_revoke_operator",
    description: "POST /api/admin/operators/:id/revoke. Soft-revoke an opc_ credential (root only).",
    inputSchema: OBJ({ id: STR("opc_… credential id.") }, ["id"]),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/operators/${encodeURIComponent(reqStr(a, "id"))}/revoke`,
      body: {},
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_credits",
    description: "GET /api/admin/tenants/:id/credits. Prepaid credit balance (tenants:read).",
    inputSchema: OBJ({ id: STR("ten_… tenant id.") }, ["id"]),
    build: (a) => ({
      method: "GET",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/credits`,
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_credits_manual",
    description:
      "POST /api/admin/tenants/:id/credits/manual. Manual credit grant/debit (credits:write). " +
      "Mints or removes money; require a real reason in the body.",
    inputSchema: OBJ(
      {
        id: STR("ten_… tenant id."),
        amount_micro_usd: NUM("Signed integer micro-USD delta (plane unit)."),
        reason: STR("Audit reason (required by plane policy)."),
        operator_claimed: STR("Optional claimed operator name on legacy rails."),
      },
      ["id", "reason"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/credits/manual`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_module_readiness",
    description:
      "GET /api/admin/tenants/:id/module-readiness. What the tenant's module workers report " +
      "(tenants:read). Use after upgrade/bootstrap to verify doors.",
    inputSchema: OBJ({ id: STR("ten_… tenant id.") }, ["id"]),
    build: (a) => ({
      method: "GET",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/module-readiness`,
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_suspend",
    description:
      "POST /api/admin/tenants/:id/suspend. Pull routing immediately (tenants:write). reason required.",
    inputSchema: OBJ(
      { id: STR("ten_…"), reason: STR("Why (audit; refused if empty).") },
      ["id", "reason"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/suspend`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_resume",
    description: "POST /api/admin/tenants/:id/resume. Clear suspension (tenants:write).",
    inputSchema: OBJ(
      { id: STR("ten_…"), reason: STR("Why (audit).") },
      ["id", "reason"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/resume`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_teardown",
    description:
      "POST /api/admin/tenants/:id/teardown. IRREVERSIBLE destroy (tenants:destroy). Empties R2, " +
      "deletes Worker/D1 bindings per plane policy. Refused under a preservation hold.",
    inputSchema: OBJ(
      {
        id: STR("ten_…"),
        reason: STR("Why (audit)."),
        confirm: STR("Must be the tenant slug or id as the plane requires."),
      },
      ["id", "reason"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/teardown`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_upgrade_studio",
    description:
      "POST /api/admin/tenants/:id/upgrade-studio. Push the pinned published studio release to the " +
      "tenant Worker (studio:operate). Primary bootstrap/repair after provision.",
    inputSchema: OBJ(
      { id: STR("ten_…"), to_release: STR("Optional release pin override.") },
      ["id"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/upgrade-studio`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_upgrade_modules",
    description:
      "POST /api/admin/tenants/:id/upgrade-modules. Upgrade tenant module workers (studio:operate).",
    inputSchema: OBJ(
      { id: STR("ten_…"), from_release: STR("Optional from pin."), to_release: STR("Optional to pin.") },
      ["id"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/upgrade-modules`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_refresh_bindings",
    description:
      "POST /api/admin/tenants/:id/refresh-studio-bindings. Re-apply studio bindings/secrets " +
      "(studio:operate). Use after binding drift.",
    inputSchema: OBJ({ id: STR("ten_…") }, ["id"]),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/refresh-studio-bindings`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_invoke_key_handoff",
    description:
      "POST /api/admin/tenants/:id/invoke-key-handoff. Mint owner handoff for RunPod invoke key B " +
      "(studio:operate). Owner completes unauthenticated /api/handoff/invoke-key.",
    inputSchema: OBJ({ id: STR("ten_…") }, ["id"]),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/invoke-key-handoff`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_reprovision_runpod",
    description:
      "POST /api/admin/tenants/:id/reprovision-runpod. Rebuild RunPod endpoints for a live tenant " +
      "(studio:operate). Needs a transient provisioning key per plane custody rules.",
    inputSchema: OBJ(
      {
        id: STR("ten_…"),
        runpod_api_key: STR("Transient Key A (never stored by the plane)."),
      },
      ["id"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/reprovision-runpod`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_smoke_render",
    description:
      "POST /api/admin/tenants/:id/smoke-render. SPENDS GPU: fire a smoke film through the tenant " +
      "studio (studio:operate). Poll with cp_poll_smoke_render.",
    inputSchema: OBJ({ id: STR("ten_…") }, ["id"]),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/smoke-render`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_poll_smoke_render",
    description: "GET /api/admin/tenants/:id/smoke-render/:smk. Poll smoke render status (tenants:read).",
    inputSchema: OBJ(
      { id: STR("ten_…"), smoke_id: STR("smk_… job id.") },
      ["id", "smoke_id"],
    ),
    build: (a) => ({
      method: "GET",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/smoke-render/${encodeURIComponent(reqStr(a, "smoke_id"))}`,
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_abuse_report_url",
    description:
      "POST /api/admin/tenants/:id/abuse-report-url. Converge host.abuse_report_url onto the tenant " +
      "studio (tenants:write). Hosted-only by construction.",
    inputSchema: OBJ({ id: STR("ten_…") }, ["id"]),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/abuse-report-url`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_storage_quota",
    description: "POST /api/admin/tenants/:id/storage-quota. Set tenant storage quota (tenants:write).",
    inputSchema: OBJ(
      {
        id: STR("ten_…"),
        quota_bytes: NUM("Quota in bytes, or null to clear (plane rules apply)."),
      },
      ["id"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/storage-quota`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_video_finish_binding",
    description:
      "POST /api/admin/tenants/:id/video-finish-binding. Converge video-finish module binding " +
      "(tenants:write).",
    inputSchema: OBJ({ id: STR("ten_…") }, ["id"]),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/video-finish-binding`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_tenant_video_finish_tier_state",
    description:
      "POST /api/admin/tenants/:id/video-finish-tier-state. Mark finish tier reachable/unreachable " +
      "(tenants:write).",
    inputSchema: OBJ(
      {
        id: STR("ten_…"),
        unreachable: { type: "boolean", description: "true = mark unreachable." },
      },
      ["id"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/video-finish-tier-state`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_list_preservation_holds",
    description: "GET /api/admin/tenants/:id/preservation-holds. List holds (tenants:read).",
    inputSchema: OBJ({ id: STR("ten_…") }, ["id"]),
    build: (a) => ({
      method: "GET",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/preservation-holds`,
      target: "control_plane",
    }),
  },
  {
    name: "cp_open_preservation_hold",
    description:
      "POST /api/admin/tenants/:id/preservation-holds. Open a statutory hold (tenants:write). " +
      "Blocks teardown until human release.",
    inputSchema: OBJ(
      {
        id: STR("ten_…"),
        reason: STR("Why the hold exists."),
        kind: STR("Hold kind if the plane distinguishes clocks."),
      },
      ["id", "reason"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/preservation-holds`,
      body: bodyWithout(a, "id"),
      target: "control_plane",
    }),
  },
  {
    name: "cp_release_preservation_hold",
    description:
      "POST /api/admin/tenants/:id/preservation-holds/:hold_id/release. Human release only " +
      "(tenants:write). Clocks never auto-release.",
    inputSchema: OBJ(
      {
        id: STR("ten_…"),
        hold_id: STR("hold_…"),
        reason: STR("Why releasing."),
      },
      ["id", "hold_id", "reason"],
    ),
    build: (a) => ({
      method: "POST",
      path: `/api/admin/tenants/${encodeURIComponent(reqStr(a, "id"))}/preservation-holds/${encodeURIComponent(reqStr(a, "hold_id"))}/release`,
      body: bodyWithout(a, "id", "hold_id"),
      target: "control_plane",
    }),
  },

  // --- escape hatches -----------------------------------------------------------
  {
    name: "studio_request",
    description:
      "Generic escape hatch to ANY studio route in docs/CONTRACT.md not covered by a curated tool " +
      "(e.g. storyboard/render doors that remain uncurated until cf#334 sound reconciliation, " +
      "settings/secrets if present on the host). JSON only; binary summarized. path must start with '/'.",
    inputSchema: OBJ(
      {
        method: {
          type: "string",
          enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
          description: "HTTP method.",
        },
        path: STR("Studio path starting with '/', e.g. '/api/storyboard/renders/tags'."),
        query: { type: "object", description: "Optional query params (string/number values)." },
        body: {
          type: ["object", "string"],
          description: "Optional JSON request body (object, or a JSON-encoded string).",
        },
      },
      ["method", "path"],
    ),
    build: (a) => genericRequest(a, "studio"),
  },
  {
    name: "control_plane_request",
    description:
      "Escape hatch to ANY vivijure-control-plane path (admin or public). Uses " +
      "CONTROL_PLANE_ADMIN_TOKEN. Prefer curated cp_* tools. path must start with '/'. " +
      "Note: tenant self-serve provision (POST /api/tenant/provision) needs an account session " +
      "cookie, not the admin bearer -- owners provision via the front door; operators use admin " +
      "lifecycle tools after the tenant exists.",
    inputSchema: OBJ(
      {
        method: {
          type: "string",
          enum: ["GET", "POST", "PATCH", "PUT", "DELETE"],
          description: "HTTP method.",
        },
        path: STR("Control-plane path starting with '/', e.g. '/api/admin/tenants'."),
        query: { type: "object", description: "Optional query params." },
        body: {
          type: ["object", "string"],
          description: "Optional JSON body.",
        },
      },
      ["method", "path"],
    ),
    build: (a) => genericRequest(a, "control_plane"),
  },
];

function genericRequest(
  a: Record<string, unknown>,
  target: CallTarget,
): StudioCall {
  const method = String(a.method ?? "").toUpperCase();
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    throw new Error(`invalid method '${String(a.method)}'`);
  }
  const path = reqStr(a, "path");
  if (!path.startsWith("/")) throw new Error("path must start with '/'");
  const query =
    a.query && typeof a.query === "object"
      ? (a.query as Record<string, string | number | undefined>)
      : undefined;
  let body = a.body;
  if (typeof body === "string" && body.trim() !== "") {
    try {
      body = JSON.parse(body);
    } catch {
      throw new Error("body must be a JSON object (or a JSON-encoded string that parses to one)");
    }
  }
  return { method, path, query, body, target };
}

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// Build the absolute studio URL for a call, appending any defined query params. STUDIO_URL is
// normalized (trailing slash trimmed); a missing STUDIO_URL throws (fail closed at call time).

/** Strip trailing ASCII slashes without a regex (CodeQL js/polynomial-redos). */
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* / */) end--;
  return end === s.length ? s : s.slice(0, end);
}

export function studioUrl(env: McpEnv, call: StudioCall): string {
  const target: CallTarget = call.target ?? "studio";
  const baseRaw =
    target === "control_plane" ? env.CONTROL_PLANE_URL : env.STUDIO_URL;
  const base = trimTrailingSlashes(baseRaw ?? "");
  if (!base) {
    throw new Error(
      target === "control_plane"
        ? "CONTROL_PLANE_URL is not configured"
        : "STUDIO_URL is not configured",
    );
  }
  const url = new URL(base + call.path);
  if (call.query) {
    for (const [k, v] of Object.entries(call.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Execute a translated studio call and format the reply as MCP text content. JSON replies are
// pretty-printed; non-JSON (CSV markers) is returned bounded; binary (video/image/tar/octet-stream)
// is summarized with its size so we never dump bytes through the transcript. isError is true on any
// >= 400 status or a transport failure, so the agent sees the failure as data.
// cf#317: cap on an inlined image. A base64 block rides inside the JSON-RPC reply, so this bounds
// what one tool call can push through the transport; keyframes and portraits are ~1-3MB. Anything
// larger is refused honestly and pointed at artifact_url rather than silently truncated.
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

// A Uint8Array is not a BodyInit under @cloudflare/workers-types; an ArrayBuffer is. Return the
// view's own buffer when the view spans it exactly (what fromBase64 always produces) and copy only
// when it does not, so a caller passing a SUBARRAY cannot silently send the bytes around it.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

// Base64 without Buffer (Workers runtime). Chunked because String.fromCharCode.apply on a multi-MB
// array overflows the call stack.
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function runTool(
  env: McpEnv,
  call: StudioCall,
  opts: { inlineImages?: boolean } = {},
): Promise<{ content: McpContent[]; isError: boolean }> {
  const target: CallTarget = call.target ?? "studio";
  const bearer =
    target === "control_plane"
      ? env.CONTROL_PLANE_ADMIN_TOKEN
      : env.STUDIO_API_TOKEN;
  if (!bearer) {
    return {
      content: [
        {
          type: "text",
          text:
            target === "control_plane"
              ? "MCP control plane is not configured: CONTROL_PLANE_ADMIN_TOKEN is unset."
              : "MCP is not configured: STUDIO_API_TOKEN is unset.",
        },
      ],
      isError: true,
    };
  }

  let url: string;
  try {
    url = studioUrl(env, call);
  } catch (err) {
    return { content: [{ type: "text", text: String(err) }], isError: true };
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${bearer}` };
  const init: RequestInit = { method: call.method, headers };
  const sendsBody = call.method !== "GET" && call.method !== "DELETE";
  if (call.rawBody !== undefined && sendsBody) {
    // cf#317: a bytes-in route reads the RAW request body and dispatches on the content-type header,
    // so the bytes go on the wire as themselves. JSON-encoding them is what made these routes
    // unreachable through the escape hatch.
    headers["Content-Type"] = call.rawBody.contentType;
    init.body = toArrayBuffer(call.rawBody.bytes);
  } else if (call.body !== undefined && sendsBody) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(call.body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: `${target === "control_plane" ? "Control plane" : "Studio"} request failed (transport): ${String(err)}`,
        },
      ],
      isError: true,
    };
  }

  const ct = res.headers.get("content-type") ?? "";
  const status = res.status;
  const isError = status >= 400;
  const line = `${call.method} ${call.path} -> ${status}`;

  if (/application\/json/i.test(ct)) {
    let text: string;
    try {
      text = JSON.stringify(await res.json(), null, 2);
    } catch {
      text = "(unparseable JSON body)";
    }
    return { content: [{ type: "text", text: `${line}\n\n${text}` }], isError };
  }

  // Non-JSON. Summarize binary; return bounded text for anything textual (e.g. CSV markers).
  const isBinaryMedia =
    /^(?:video|image|audio)\//i.test(ct) ||
    /^application\/(?:octet-stream|x-tar|zip)/i.test(ct);
  if (isBinaryMedia) {
    const len = res.headers.get("content-length") ?? "unknown";
    // cf#317: an IMAGE, on a tool that asked to see one, comes back as an MCP image block. This is
    // the difference between an agent verifying its own output and an agent trusting a status field.
    // Everything else (video, audio, tar) still gets the summary: MCP has no block that can carry it,
    // and pretending otherwise would be worse than saying so.
    if (opts.inlineImages && /^image\//i.test(ct) && !isError) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `${line}\n\nImage is ${bytes.byteLength} bytes, over the ${MAX_INLINE_IMAGE_BYTES}-byte inline cap. Use artifact_url for a presigned link.`,
            },
          ],
          isError,
        };
      }
      const mimeType = ct.split(";")[0].trim();
      return {
        content: [
          { type: "text", text: `${line}\n\n${mimeType}, ${bytes.byteLength} bytes:` },
          { type: "image", data: toBase64(bytes), mimeType },
        ],
        isError,
      };
    }
    return {
      content: [
        {
          type: "text",
          text: `${line}\n\nBinary response (${ct}, ${len} bytes) not inlined. Use artifact_url for a short-lived presigned link to fetch or open it (an image can also be viewed inline with view_artifact); a finished film additionally carries poll_film's download_url.`,
        },
      ],
      isError,
    };
  }

  const maxRead = 65_536;
  const cl = parseInt(res.headers.get("content-length") ?? "0", 10) || 0;
  if (cl > maxRead) {
    return {
      content: [{ type: "text", text: `${line}\n\nResponse too large (${cl} bytes); not inlined.` }],
      isError,
    };
  }
  const reader = res.body?.getReader();
  if (!reader) {
    return { content: [{ type: "text", text: `${line}\n\n(empty body)` }], isError };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxRead) {
      await reader.cancel();
      return {
        content: [{ type: "text", text: `${line}\n\nResponse too large (>${maxRead} bytes); not inlined.` }],
        isError,
      };
    }
    chunks.push(value);
  }
  const raw = new TextDecoder().decode(
    chunks.reduce((acc, c) => {
      const merged = new Uint8Array(acc.length + c.length);
      merged.set(acc);
      merged.set(c, acc.length);
      return merged;
    }, new Uint8Array()),
  );
  const capped = raw.length > 4000 ? raw.slice(0, 4000) + "\n... (truncated)" : raw;
  return { content: [{ type: "text", text: `${line}\n\n${capped}` }], isError };
}
