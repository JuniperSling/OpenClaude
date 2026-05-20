# OpenClaude

OpenClaude is a self-hosted, Claude-like agent workspace built on top of the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk). It pairs a Next.js chat UI with a Node.js API and WebSocket runtime so a small group of trusted users can drive long, multi-turn agent sessions that stream text, run tools, edit files, and consume images — all routed through OpenRouter so multiple models can share one entry point.

## Highlights

- **Real Claude Agent runtime** — wraps `@anthropic-ai/claude-agent-sdk`'s `query()` with `includePartialMessages`, persistent SDK session storage, and `resume`-based multi-turn context.
- **OpenRouter routing** — Claude Sonnet / Opus and DeepSeek V4 (Flash / Pro) are exposed through the same SDK, with per-model effort (Low / Medium / High) for the Claude family.
- **Streaming UI** — WebSocket envelopes power live text deltas, tool-use cards (with arguments and results), `view`/`raw` toggle on assistant turns, per-turn token / cost metadata, and a composer that collapses into a "back to bottom" pill while you scroll up to read history.
- **Multimodal input** — drag-and-drop, paste, or file-pick images directly in the composer. The browser uploads them as multipart/form-data (so iOS Safari can transparently transcode HEIC to JPEG before upload), the API stages them under the user's directory, and they are moved into the workspace on run start and forwarded as Claude `image` content blocks.
- **AskUserQuestion bridge** — when the agent calls the SDK's `AskUserQuestion` tool, the run pauses and the composer turns into a multiple-choice / free-form panel; the answer is fed back as the next user message.
- **Workspace-scoped state** — every session has a persistent workspace, shared user `HOME`, and dedicated SDK session storage so dependency caches survive across runs.
- **SQLite-backed history** — sessions, runs, raw event archive, and lightweight `messages` summaries live in a single SQLite database. The browser caches loaded conversations in `sessionStorage` to keep switching instant.
- **Admin controls** — single-admin login with rate-limited login attempts, run stop button, hover-only delete (red trash icon), and per-session AI-generated titles via Haiku.

## Quick start (local)

```bash
cp .env.example .env
npm install
npm run dev
```

Then open `http://localhost:3000`.

The default development runtime is `mock` unless `OPENROUTER_API_KEY` is set. To use Claude Agent SDK through OpenRouter:

```bash
AGENT_RUNTIME_MODE=claude
OPENROUTER_API_KEY=sk-or-...
```

> Never commit real keys. Rotate any credential that was pasted into chat, docs, or logs.

## Project layout

```text
apps/
  api/                  # Express API, WebSocket gateway, run registry, SQLite store
  web/                  # Next.js frontend (Claude-like chat UI)
packages/
  shared/               # Shared types, Zod schemas, SDK→UI hint helpers
  agent-runtime/        # Claude Agent SDK wrapper + mock runtime
  sandbox/              # Workspace layout, path guard, skill projection
  model-registry/       # Model catalogue (Claude / DeepSeek), OpenRouter env mapping
infra/
  compose.yaml          # Single-machine Docker skeleton (early draft, not used in prod)
docs/
  architecture-plan.md            # Original architecture and SDK probing notes
  current-service-overview.md     # Living overview of the deployed service
```

## Operations

The project ships as a TypeScript monorepo with `npm` workspaces.

- `npm run dev` — runs `apps/api` and `apps/web` in parallel.
- `npm run typecheck` — builds all internal packages and runs `tsc --noEmit` everywhere.
- `npm run build` — builds every workspace and produces a deployable `dist`/`.next`.
- `npm start` is run per service (`npm --workspace @openclaude/api run start`, `npm --workspace @openclaude/web run start`).

Production deployments use `systemd` to manage the API and Web Node processes and an Nginx reverse proxy in front. See [`docs/current-service-overview.md`](docs/current-service-overview.md) for the full operational guide.

## Important caveats

- The local sandbox is a workspace **organisation boundary**, not a security boundary. Bash and file tools rely on the SDK permission mode plus an application-level deny list. For untrusted users you should add OS-level isolation (per-user UNIX uid or per-user containers) before exposing the agent.
- The frontend intentionally receives the raw SDK event under `sdkEvent`; only minimal `uiHints` are stabilised for rendering. New SDK event shapes can be rendered without a backend change.
- Authentication is currently a single admin password with login rate limiting. Multi-user support is data-model-ready but not surfaced.
