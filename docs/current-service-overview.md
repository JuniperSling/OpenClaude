# OpenClaude Service Overview

This document is for engineers (and agents) picking up the project. It explains what OpenClaude is, how the code is wired today, what is already on disk, how it gets deployed, and which directions are still open.

Pair this document with the original [architecture plan](./architecture-plan.md). The plan captures the early design decisions; this overview captures the **current state** of the implementation.

## 1. Background and goals

OpenClaude is a self-hosted, Claude-like agent workspace for a small group of trusted users. It is **not** a generic chatbot:

- Each conversation has its own persistent **Workspace** with a working directory, shared user `HOME`, and Claude Agent SDK session storage.
- The agent can stream text, call SDK tools, run Bash, read/write files, and accept multimodal user input.
- Multi-turn context is recovered through the SDK's `resume` API rather than by re-stitching message history at the application layer.

The product targets a personal / small-team deployment on a single VM. It is intentionally simple to operate, but the data shapes are designed so that multi-user support, per-user isolation, MCP, and Skills can be layered in without a rewrite.

## 2. Tech stack at a glance

OpenClaude is a TypeScript monorepo using `npm` workspaces.

```text
apps/
  api/                  # Express API, WebSocket /ws, RunRegistry, SQLite store
  web/                  # Next.js 16 frontend, App Router, ReactMarkdown
packages/
  shared/               # Cross-cutting types + Zod request schemas + SDK→UI hint helpers
  agent-runtime/        # Claude Agent SDK wrapper + mock runtime + multimodal prompt builder
  sandbox/              # Local workspace layout, path guard, Bash deny list, skill projection
  model-registry/       # Catalogue of Claude / DeepSeek models + OpenRouter env mapping
infra/
  compose.yaml          # Early Docker Compose skeleton (not used in production today)
docs/
  architecture-plan.md
  current-service-overview.md
```

Key runtime dependencies: `@anthropic-ai/claude-agent-sdk`, `next`, `express`, `ws`, `zod`, `node:sqlite` (built-in), `react-markdown`, `remark-gfm`.

Common scripts:

```bash
npm install
npm run dev          # api + web in parallel
npm run typecheck    # all workspaces
npm run build        # all workspaces (api compiles to dist/, web to .next/)
```

If `OPENROUTER_API_KEY` is unset and `AGENT_RUNTIME_MODE` is not `claude`, the API uses a mock runtime that emits a deterministic stream — useful for offline UI work.

## 3. High-level architecture

Request path:

```text
Browser
  → Next.js Web (Markdown + WebSocket subscriber)
  → Express API
  → RunRegistry (per-process map of active runs)
  → ClaudeAgentRuntime (thin wrapper over Claude Agent SDK)
  → @anthropic-ai/claude-agent-sdk · query()
  → OpenRouter
  → Claude / DeepSeek model
```

Persistence path:

```text
Express API
  → SQLite (.openclaude/openclaude.sqlite): users, workspaces, sessions, runs, events, messages
  → JSONL archive (.openclaude/run-events/{runId}.jsonl): raw SDK envelopes for debugging
  → Workspace volume (.openclaude/users/{userId}/...): home, claude (SDK config), workspaces/{id}/{uploads,files,.claude/skills}
```

Streaming path:

```text
POST /api/runs
  → store.createRun (status=queued)
  → respond 202 with run id
  → background: ClaudeAgentRuntime.start(...)
  → for each SDK message:
      → wrap into AgentStreamEnvelope { runId, sequence, sdkEvent, uiHints }
      → broadcast via WebSocket /ws to subscribers immediately
      → enqueue persistence to SQLite events + JSONL archive (non-blocking)
      → derive lightweight `messages` rows for assistant text and tool use/result
```

Multi-turn context: the first SDK `system init` event yields a `session_id` which we store on `sessions.sdk_session_id`. Subsequent `POST /api/runs` calls pass that as `options.resume`, so the SDK reloads its own transcript instead of relying on application-side message stitching.

## 4. API service

Entry: `apps/api/src/server.ts`. Responsibilities:

- Boots Express + HTTP server, instantiates the SQLite-backed `FileStore` and `RunRegistry`, and chooses between `ClaudeAgentRuntime` and `MockAgentRuntime` based on env.
- Configures CORS, a small JSON body limit (1MB — large blobs are uploaded via multipart, not inline base64), and `trust proxy` for correct IPs behind Nginx.
- Login endpoint with per-(IP, username) failure tracking and progressive lockout windows (1m → 5m → 15m).
- Generates session titles asynchronously after the first user prompt by calling OpenRouter's chat completions with `anthropic/claude-haiku-4.5`.

HTTP endpoints currently served:

- `GET /health`
- `POST /api/auth/login`
- `GET /api/models` — catalogue + effort levels + default model
- `GET /api/me`
- `GET /api/sessions`
- `POST /api/sessions`
- `DELETE /api/sessions/:sessionId` (rejects if there is an active run)
- `GET /api/sessions/:sessionId/history` — returns `messages` summary + `runMeta` (token/cost/raw text per run)
- `GET /api/runs/:runId`
- `POST /api/uploads` — multipart/form-data (`files` field, up to 8 images, ≤25MB each, MIME must start with `image/`). Saved to `users/{userId}/staging/{uuid}{ext}` via multer disk storage; returns `{ uploads: [{ id, mimeType, name, sizeBytes }] }`. The `id` is opaque and only valid for the same user.
- `POST /api/runs` — accepts `attachmentIds: string[]`. The server validates each id has no path separators, then `rename()`s the staged file into `workspaces/{id}/uploads/` and records it on `RunInput.attachments`. Inline base64 has been removed.
- `GET /api/sessions/:sessionId/attachments/:filename` — streams an image saved under `workspaces/{id}/uploads/`. Authentication accepts either an `Authorization: Bearer` header or a `?token=` query param so that `<img>` tags can load attachments without bespoke fetch wiring. The server validates the session ownership and rejects path-traversal filenames.
- `DELETE /api/runs/:runId`

WebSocket `/ws` (in `RunRegistry.attach`):

- `?token=JWT` query param for auth.
- Client → `{ type: "subscribe_run", runId, afterSequence? }` — server replays missed events from SQLite.
- Client → `{ type: "stop_run", runId }` — server calls `query.close()` and broadcasts a synthetic `result {subtype:"stopped"}` event.
- Server → `AgentStreamEnvelope` payloads pushed before persistence (so streaming feels live).

## 5. Agent runtime

Entry: `packages/agent-runtime/src/index.ts`.

`ClaudeAgentRuntime.start()` calls the SDK's `query({ prompt, options })`:

- `cwd` = workspace root
- `HOME` = user shared home (so dependency caches persist across runs)
- `CLAUDE_CONFIG_DIR` = per-user SDK session storage (so `resume` keeps working after redeploys)
- `ANTHROPIC_BASE_URL` = `https://openrouter.ai/api`
- `ANTHROPIC_AUTH_TOKEN` = `OPENROUTER_API_KEY`
- `model` = SDK alias (`sonnet`, `opus`, ...) — the actual upstream model is selected via `ANTHROPIC_DEFAULT_*_MODEL` env vars derived from the model registry
- `tools = { type: "preset", preset: "claude_code" }`
- `permissionMode = "acceptEdits"`, `maxTurns = 20`, `includePartialMessages: true`
- `canUseTool` denies risky Bash patterns and pauses runs when the agent calls `AskUserQuestion`, returning `{ behavior: "deny", interrupt: true }` so the front-end can collect a real answer and re-run.

When the run has `image` attachments, the runtime builds an `AsyncIterable<SDKUserMessage>` instead of a plain string prompt. The user message contains `text` + `image` content blocks where the image source is `{ type: "base64", media_type, data }`, matching the Anthropic SDK's `Base64ImageSource` shape.

When `resumeSessionId` is set the runtime first runs `sanitizeTranscriptForCrossModelResume()` against the SDK transcript file (`{sdkSessionStoragePath}/projects/<encoded cwd>/<sessionId>.jsonl`). It compares each assistant message's `model` provider (the part before `/` in the OpenRouter model id) with the target run's provider, and strips `thinking` / `redacted_thinking` / `reasoning` blocks from messages whose provider does not match. This lets users hop between Claude and DeepSeek (or any future provider) without the upstream API rejecting the foreign reasoning signature with HTTP 400; same-provider runs keep their thinking blocks intact for caching and continuity.

`MockAgentRuntime` exists for local development without keys; do not use it in production.

## 6. Models and effort

`packages/model-registry/src/index.ts` declares the model catalogue:

| ID | Provider | OpenRouter model | Multimodal | Effort | Notes |
| --- | --- | --- | --- | --- | --- |
| `claude-sonnet-4.6` | OpenRouter | `anthropic/claude-sonnet-4.6` | yes | yes | default |
| `claude-opus-4.7` | OpenRouter | `anthropic/claude-opus-4.7` | yes | yes | |
| `deepseek-v4-flash` | OpenRouter | `deepseek/deepseek-v4-flash` | no | no | text-only |
| `deepseek-v4-pro` | OpenRouter | `deepseek/deepseek-v4-pro` | no | no | text-only |
| `anthropic/claude-haiku-4.5` | OpenRouter | (used internally for title generation only) | — | — | not user-selectable |

`getOpenRouterDefaults(modelId)` builds the env vars handed to the SDK:

- For Claude-native models, it sets `ANTHROPIC_DEFAULT_SONNET_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` so the SDK aliases route correctly.
- For DeepSeek (or any non-Claude entry), it forces `ANTHROPIC_DEFAULT_SONNET_MODEL` to the chosen OpenRouter model so the SDK alias falls through to it.

Effort is an opt-in per-model UI state held in the browser (`effortByModel`); it defaults to `medium` and is currently informational on the request side. Wiring it into provider-specific knobs is a follow-up.

## 7. Frontend

Entry: `apps/web/app/ui/chat-shell.tsx` (single-component chat UI), styles in `apps/web/app/globals.css`.

Features as of today:

- Boot screen prevents login flicker; token kept in `localStorage`, fully cleared on logout.
- Sidebar with session list, hover-only red trash icon (no confirm dialog), bottom-left logout, and admin avatar.
- Per-session conversation cache in memory + `sessionStorage` so re-opening a session is instant.
- Composer:
  - Drag-and-drop, paste, and `+` button accept up to 8 images via the native file picker (`accept="image/*"`). On iOS Safari this lets the OS auto-convert HEIC/HEIF to JPEG before the file leaves the device.
  - Selected images upload immediately via `POST /api/uploads` (multipart/form-data, no base64). Thumbnails use `URL.createObjectURL`; per-thumbnail spinner / error indicator reflects the upload state. The send button is enabled only when every pending image is `ready`.
  - When the user scrolls up to read history, the composer collapses into a small "回到底部" pill at the bottom; tapping it (or scrolling back to the bottom) restores the full composer.
  - When a run is active, the send button becomes a red stop button; clicking it closes the WebSocket message and surfaces a `Stopped by user` state on any in-flight tool cards.
  - Custom model picker popover with grouped models, an inline `Vision` pill for multimodal models, and an inline `[L|M|H]` segmented control for per-model effort.
- Streaming output:
  - Frontend buffers SDK text deltas and emits a small typewriter pacing so the rendering feels smoother.
  - Auto-scroll only sticks if the user is within ~80px of the bottom; scrolling up to read history is not interrupted.
- Assistant turns:
  - Markdown rendering via `react-markdown` + `remark-gfm`.
  - On hover, the meta line shows token totals, USD cost, and a `view` / `raw` toggle that swaps the same content area between rendered Markdown and a copyable raw card.
- AskUserQuestion: when the SDK calls the tool, the composer is replaced with a structured panel — header / question / options (single or multi select) plus a free-form custom answer. Submitting sends the user's choice as the next prompt and the SDK resumes naturally.

## 8. Storage layer

Class lives in `apps/api/src/store.ts`. The class name is still `FileStore` for historic reasons, but the implementation now uses Node's built-in `node:sqlite` (`DatabaseSync`).

- `PRAGMA journal_mode = WAL`
- `PRAGMA foreign_keys = ON`

Tables:

- `meta` — migration markers
- `users`
- `workspaces`
- `sessions` — `sdk_session_id`, `sdk_session_storage_path`, `current_model`, `title`
- `runs` — status, model, input JSON, started/finished, cost, num_turns, stop_reason
- `events` — `(run_id, sequence)` PK, raw SDK envelope JSON
- `messages` — UI-friendly summary (user prompt, assistant streamed text, tool_use + tool_result pairs). The `attachments_json` column stores image attachments as `[{ filename, mimeType, sizeBytes }]` so that history reloads can re-render them via `GET /api/sessions/:id/attachments/:filename`. A startup migration (`runColumnMigrations`) adds this column to existing DBs.

History UI is built from `messages` only; raw events are kept around for debugging and the `view` / `raw` toggle.

Legacy migration: on startup, if a pre-existing `store.json` is found and the migration marker is missing, the rows are loaded into SQLite in a transaction and the legacy file is renamed to `store.json.migrated-<timestamp>`.

Raw events are also appended to JSONL files at `.openclaude/run-events/{runId}.jsonl` for archival / debugging.

## 9. Workspace layout

Defined in `packages/sandbox/src/index.ts`. For each `(userId, workspaceId)`:

```text
{OPENCLAUDE_DATA_DIR}/users/{userId}/
  home/                          # Agent HOME (persistent caches, tool installs)
  claude/                        # CLAUDE_CONFIG_DIR (SDK session/config storage)
  staging/                       # Multipart uploads (pre-run); files renamed into a workspace upon POST /api/runs
  workspaces/{workspaceId}/
    uploads/                     # User-uploaded images attached to a run
    files/                       # General workspace files
    .claude/skills/              # Skill projections (future)
```

Path guards (`WorkspacePathGuard`) reject anything escaping the workspace root. The Bash deny list blocks `rm -rf`, `sudo`, `curl`, `wget`, `ssh`, `scp`, `dd`, `mkfs`, `chmod 777`, and any command containing `..`.

This is an **organisation** boundary, not a security one. Treat the workspace as trusted user space; for untrusted multi-tenant operation, layer on per-user UNIX uid or per-user containers.

## 10. Deployment

Production today is intentionally boring: native Node + `systemd` + Nginx reverse proxy on a single VM.

Conventional layout (replace placeholders for your host):

- App directory: `/opt/openclaude`
- Data directory: `/srv/openclaude/data`
- Run user: `openclaude`
- API service: `openclaude-api.service` listens on `127.0.0.1:4000`
- Web service: `openclaude-web.service` listens on `127.0.0.1:3000`
- Nginx terminates HTTPS, proxies `/api/*` and `/ws` to the API and everything else to Next.js.

Sample systemd units:

```ini
# /etc/systemd/system/openclaude-api.service
[Unit]
Description=OpenClaude API
After=network.target

[Service]
Type=simple
User=openclaude
WorkingDirectory=/opt/openclaude
EnvironmentFile=/opt/openclaude/.env
ExecStart=/usr/local/bin/npm --workspace @openclaude/api run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/openclaude-web.service
[Unit]
Description=OpenClaude Web
After=network.target openclaude-api.service

[Service]
Type=simple
User=openclaude
WorkingDirectory=/opt/openclaude
EnvironmentFile=/opt/openclaude/.env
ExecStart=/usr/local/bin/npm --workspace @openclaude/web run start -- --hostname 127.0.0.1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Deployment cycle:

```bash
# locally
rm -rf apps/web/.next
npm run typecheck
npm run build

# upload (rsync / tar over ssh) into /opt/openclaude, excluding:
#   .env, node_modules, .openclaude, apps/web/.next

# on the server
cd /opt/openclaude
rm -rf apps/web/.next
sudo -u openclaude npm install --omit=optional
sudo -u openclaude npm run build
systemctl restart openclaude-api openclaude-web
systemctl status openclaude-api openclaude-web --no-pager
```

Notes:

- Do not check `.env`, `OPENROUTER_API_KEY`, or admin passwords into the repo.
- Do not let deploys overwrite `/srv/openclaude/data` — that is where the SQLite database, uploads, and SDK session storage live.
- The first run on a fresh VM will create the SQLite file and (if a `store.json` is present) migrate from the legacy JSON store automatically.

## 11. Environment variables

`.env.example` is the source of truth. The non-obvious ones:

```bash
OPENCLAUDE_DATA_DIR=.openclaude            # absolute path or relative to API cwd
API_HOST=0.0.0.0
API_PORT=4000
JWT_SECRET=...                             # required to invalidate tokens across deploys
ADMIN_USERNAME=Milagro
ADMIN_PASSWORD=...                         # change before deploy
AGENT_RUNTIME_MODE=mock                    # or "claude"
OPENROUTER_API_KEY=
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.7
ANTHROPIC_DEFAULT_HAIKU_MODEL=anthropic/claude-haiku-4.5
NEXT_PUBLIC_API_BASE_URL=                  # leave empty in production (relative path)
NEXT_PUBLIC_WS_BASE_URL=                   # leave empty in production (derived from window.location)
```

## 12. Known gaps and follow-ups

Authentication / multi-user:

- Single admin password with in-process rate limiting; not persisted across restarts.
- No password hashing, refresh tokens, registration, or roles wired to the UI.

Sandbox / security:

- `cwd` is not a security boundary. For untrusted users, swap the `LocalWorkspaceManager` for per-user containers or UNIX uid handoff.
- Bash deny list is intentionally short. Tighten it (or move to allowlist) before opening up.

Operational:

- Active runs live in the API process; restarting the API marks any running run as `interrupted_by_restart`. There is no queue / worker yet.
- No cost / usage budgets or alerting.
- Tests are not yet wired (no Jest/Vitest/Playwright config).

Product / UX:

- File browser, downloads, diff viewer, and full multimodal beyond images (PDFs, audio) are not yet built — the scaffolding (workspace `files/`, `attachments[]`) is in place.
- MCP and Skill management UIs are not yet implemented; the runtime forwards the lists, but there is no admin surface.
- DeepSeek effort and other provider-specific knobs are not yet routed; effort is currently informational.

## 13. Files worth opening first

1. `README.md`
2. `docs/current-service-overview.md` (this file)
3. `apps/api/src/server.ts`
4. `apps/api/src/run-registry.ts`
5. `apps/api/src/store.ts`
6. `packages/agent-runtime/src/index.ts`
7. `packages/shared/src/index.ts`
8. `packages/sandbox/src/index.ts`
9. `packages/model-registry/src/index.ts`
10. `apps/web/app/ui/chat-shell.tsx`
11. `apps/web/app/globals.css`
12. `docs/architecture-plan.md`

Before changing anything in production: run `npm run typecheck` and `npm run build` locally, deploy with the cycle above, and never put real keys into the repository, logs, or assistant transcripts.
