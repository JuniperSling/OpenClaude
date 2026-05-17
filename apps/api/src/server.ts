import http from "node:http";
import { mkdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express from "express";
import multer from "multer";
import { v4 as uuid } from "uuid";
import { ClaudeAgentRuntime, MockAgentRuntime } from "@openclaude/agent-runtime";
import { DEFAULT_MODEL_ID, EFFORT_LEVELS, models } from "@openclaude/model-registry";
import {
  createRunRequestSchema,
  createSessionRequestSchema,
  loginRequestSchema,
  type Run,
  type Session,
  type Workspace
} from "@openclaude/shared";
import { LocalWorkspaceManager } from "@openclaude/sandbox";
import { authenticate, signToken } from "./auth.js";
import { config } from "./config.js";
import { RunRegistry } from "./run-registry.js";
import { createTimestamped, FileStore } from "./store.js";

const app = express();
const server = http.createServer(app);
const store = new FileStore(config.dataDir, config.adminUsername);
const workspaceManager = new LocalWorkspaceManager(config.dataDir);
const loginAttempts = new Map<string, { failures: number; lockedUntil?: number }>();

const runtime =
  config.runtimeMode === "claude"
    ? new ClaudeAgentRuntime({
        openRouterApiKey: config.openRouterApiKey,
        baseUrl: config.anthropicBaseUrl,
        wallClockTimeoutMs: config.wallClockTimeoutMs,
        provider: "openrouter"
      })
    : new MockAgentRuntime();

const runs = new RunRegistry(store, runtime);

app.set("trust proxy", 1);
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_request, response) => {
  response.json({ ok: true, runtimeMode: config.runtimeMode });
});

app.post("/api/auth/login", (request, response) => {
  const parsed = loginRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const attemptKey = loginAttemptKey(request, parsed.data.username);
  const attempt = loginAttempts.get(attemptKey);
  const now = Date.now();
  if (attempt?.lockedUntil && attempt.lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((attempt.lockedUntil - now) / 1000);
    response.setHeader("Retry-After", String(retryAfterSeconds));
    response.status(429).json({
      error: `Too many failed login attempts. Try again in ${retryAfterSeconds} seconds.`
    });
    return;
  }

  const user = store.getUserByUsername(parsed.data.username);
  if (!user || parsed.data.password !== config.adminPassword) {
    registerFailedLogin(attemptKey);
    response.status(401).json({ error: "Invalid username or password" });
    return;
  }

  loginAttempts.delete(attemptKey);
  response.json({ token: signToken(user), user });
});

app.get("/api/models", (_request, response) => {
  response.json({
    models: models.map((model) => ({
      id: model.id,
      label: model.label,
      group: model.group,
      supportsMultimodal: model.supportsMultimodal,
      supportsTools: model.supportsTools,
      supportsEffort: model.supportsEffort
    })),
    effortLevels: EFFORT_LEVELS,
    defaultModelId: DEFAULT_MODEL_ID
  });
});

app.use("/api", authenticate(store));

const STAGING_DIR_NAME = "staging";
const SUPPORTED_UPLOAD_PREFIX = "image/";

const uploadStorage = multer.diskStorage({
  destination: async (request, _file, cb) => {
    try {
      const dir = path.join(config.dataDir, "users", request.user!.id, STAGING_DIR_NAME);
      await mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err as Error, "");
    }
  },
  filename: (_request, file, cb) => {
    const ext = guessImageExt(file.mimetype, file.originalname);
    cb(null, `${uuid()}${ext}`);
  }
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: { fileSize: 25 * 1024 * 1024, files: 8 },
  fileFilter: (_request, file, cb) => {
    if (file.mimetype.startsWith(SUPPORTED_UPLOAD_PREFIX)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported upload type: ${file.mimetype}`));
    }
  }
});

app.post(
  "/api/uploads",
  (request, response, next) => {
    uploadMiddleware.array("files", 8)(request, response, (err) => {
      if (err) {
        response.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      next();
    });
  },
  (request, response) => {
    const files = (request.files as Express.Multer.File[] | undefined) ?? [];
    response.json({
      uploads: files.map((file) => ({
        id: file.filename,
        mimeType: file.mimetype,
        name: file.originalname,
        sizeBytes: file.size
      }))
    });
  }
);

app.get("/api/me", (request, response) => {
  response.json({ user: request.user });
});

app.get("/api/sessions", (request, response) => {
  response.json({ sessions: store.listSessions(request.user!.id) });
});

app.post("/api/sessions", async (request, response, next) => {
  try {
    const parsed = createSessionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const workspaceId = uuid();
    const layout = workspaceManager.layout(request.user!.id, workspaceId);
    const workspace: Workspace = createTimestamped({
      id: workspaceId,
      userId: request.user!.id,
      name: parsed.data.workspaceName ?? parsed.data.title ?? "Default workspace",
      rootPath: layout.workspaceRoot,
      sharedHomePath: layout.sharedHomePath,
      sdkSessionStoragePath: layout.sdkSessionStoragePath
    });
    await workspaceManager.ensureWorkspace(workspace);
    await store.createWorkspace(workspace);

    const session: Session = createTimestamped({
      id: uuid(),
      userId: request.user!.id,
      workspaceId: workspace.id,
      title: parsed.data.title ?? "New chat",
      sdkSessionStoragePath: layout.sdkSessionStoragePath,
      currentModel: parsed.data.model ?? DEFAULT_MODEL_ID
    });
    await store.createSession(session);
    response.status(201).json({ session: { ...session, workspace } });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sessions/:sessionId", async (request, response, next) => {
  try {
    if (store.hasActiveRunsForSession(request.params.sessionId)) {
      response.status(409).json({ error: "Cannot delete a session while a run is active" });
      return;
    }
    const deleted = await store.deleteSession(request.params.sessionId, request.user!.id);
    if (!deleted) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:sessionId/history", (request, response, next) => {
  try {
    const session = store.getSessionWithWorkspace(request.params.sessionId, request.user!.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    response.json({
      session,
      messages: store.listMessagesForSession(session.id, request.user!.id),
      runMeta: store.listRunMetasForSession(session.id, request.user!.id)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:sessionId/attachments/:filename", (request, response, next) => {
  try {
    const filename = request.params.filename;
    if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      response.status(400).json({ error: "Invalid filename" });
      return;
    }
    const session = store.getSessionWithWorkspace(request.params.sessionId, request.user!.id);
    if (!session) {
      response.status(404).json({ error: "Session not found" });
      return;
    }
    const fullPath = path.join(session.workspace.rootPath, "uploads", filename);
    response.sendFile(fullPath, {
      headers: {
        "Cache-Control": "private, max-age=86400"
      }
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/runs/:runId", (request, response) => {
  const snapshot = store.getRunSnapshot(request.params.runId);
  if (!snapshot || snapshot.userId !== request.user!.id) {
    response.status(404).json({ error: "Run not found" });
    return;
  }
  response.json({ run: snapshot });
});

app.post("/api/runs", async (request, response, next) => {
  try {
    const parsed = createRunRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const session = store.getSession(parsed.data.sessionId);
    if (!session || session.userId !== request.user!.id) {
      response.status(404).json({ error: "Session not found" });
      return;
    }

    const workspace = store.getWorkspace(session.workspaceId);
    if (!workspace) {
      response.status(404).json({ error: "Workspace not found" });
      return;
    }

    const attachments: Array<{
      workspaceFilePath: string;
      mimeType?: string;
      sizeBytes?: number;
      kind?: "image" | "file";
    }> = [];
    if (parsed.data.attachmentIds?.length) {
      const uploadsDir = path.join(workspace.rootPath, "uploads");
      await mkdir(uploadsDir, { recursive: true });
      const stagingDir = path.join(config.dataDir, "users", request.user!.id, STAGING_DIR_NAME);
      for (const id of parsed.data.attachmentIds) {
        if (id.includes("/") || id.includes("\\") || id.includes("..")) {
          response.status(400).json({ error: `Invalid attachment id: ${id}` });
          return;
        }
        const stagedPath = path.join(stagingDir, id);
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          info = await stat(stagedPath);
        } catch {
          response.status(404).json({ error: `Attachment not found: ${id}` });
          return;
        }
        const targetPath = path.join(uploadsDir, id);
        await rename(stagedPath, targetPath);
        attachments.push({
          workspaceFilePath: targetPath,
          mimeType: mimeFromExt(path.extname(id).toLowerCase()),
          sizeBytes: info.size,
          kind: "image"
        });
      }
    }

    const isFirstRunInSession = store.countRunsForSession(session.id) === 0;
    const run: Run = createTimestamped({
      id: uuid(),
      sessionId: session.id,
      userId: request.user!.id,
      workspaceId: session.workspaceId,
      status: "queued",
      model: parsed.data.model ?? session.currentModel,
      input: {
        prompt: parsed.data.prompt,
        attachments: attachments.length > 0 ? attachments : undefined
      }
    });

    await store.createRun(run);
    response.status(202).json({ run });

    if (isFirstRunInSession && shouldGenerateTitle(session.title)) {
      void generateSessionTitle(parsed.data.prompt, attachments)
        .then(async (title) => {
          if (!title) return;
          const latest = store.getSession(session.id);
          if (latest && latest.userId === request.user!.id && shouldGenerateTitle(latest.title)) {
            await store.updateSession(session.id, { title });
          }
        })
        .catch((error) => {
          console.warn("Failed to generate session title", error);
        });
    }

    void runs.startRun(session, run, run.input);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/runs/:runId", async (request, response, next) => {
  try {
    await runs.stopRun(request.params.runId, request.user!.id);
    response.status(202).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});

await store.load();
runs.attach(server);

server.listen(config.port, config.host, () => {
  console.log(`OpenClaude API listening on http://${config.host}:${config.port}`);
});

function loginAttemptKey(request: express.Request, username: string) {
  return `${request.ip}:${username.trim().toLowerCase()}`;
}

function registerFailedLogin(key: string) {
  const current = loginAttempts.get(key);
  const failures = (current?.failures ?? 0) + 1;
  const lockLevels = [
    { threshold: 5, ms: 60_000 },
    { threshold: 8, ms: 5 * 60_000 },
    { threshold: 11, ms: 15 * 60_000 }
  ];
  const level = [...lockLevels].reverse().find((candidate) => failures >= candidate.threshold);
  loginAttempts.set(key, {
    failures,
    lockedUntil: level ? Date.now() + level.ms : undefined
  });
}

function shouldGenerateTitle(title: string) {
  return title.trim().length === 0 || title.trim().toLowerCase() === "new chat";
}

type TitleAttachment = {
  workspaceFilePath: string;
  mimeType?: string;
  kind?: "image" | "file";
};

const TITLE_VISION_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const TITLE_MAX_IMAGES = 3;
const TITLE_MAX_IMAGE_BYTES = 2 * 1024 * 1024;

async function generateSessionTitle(
  prompt: string,
  attachments: TitleAttachment[] = []
): Promise<string | undefined> {
  if (!config.openRouterApiKey) return undefined;

  const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
  for (const attachment of attachments) {
    if (imageBlocks.length >= TITLE_MAX_IMAGES) break;
    if (attachment.kind !== "image") continue;
    if (!attachment.mimeType || !TITLE_VISION_MIME_TYPES.has(attachment.mimeType)) continue;
    try {
      const info = await stat(attachment.workspaceFilePath);
      if (info.size > TITLE_MAX_IMAGE_BYTES) continue;
      const buffer = await readFile(attachment.workspaceFilePath);
      imageBlocks.push({
        type: "image_url",
        image_url: { url: `data:${attachment.mimeType};base64,${buffer.toString("base64")}` }
      });
    } catch (error) {
      console.warn("Failed to read image for title generation", attachment.workspaceFilePath, error);
    }
  }

  const trimmedPrompt = prompt.trim();
  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  if (trimmedPrompt && trimmedPrompt !== "(image input)") {
    userContent.push({ type: "text", text: trimmedPrompt.slice(0, 2000) });
  } else if (imageBlocks.length === 0) {
    userContent.push({ type: "text", text: trimmedPrompt.slice(0, 2000) });
  }
  for (const block of imageBlocks) userContent.push(block);
  if (userContent.length === 0) return undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openRouterApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4.5",
        messages: [
          {
            role: "system",
            content:
              "You write concise titles for chat conversations. Read the user's first message — including any attached images — and return ONLY the title text, with no quotes and no trailing punctuation. Match the user's language. Limit: 8 Chinese characters or 5 English words. If the message is mostly an image, summarise the image content."
          },
          { role: "user", content: userContent }
        ],
        temperature: 0.2,
        max_tokens: 32
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      console.warn("Title generation failed", response.status, await response.text());
      return undefined;
    }
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    const raw = payload.choices?.[0]?.message?.content;
    const text =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw
              .filter((block) => block.type === "text" && typeof block.text === "string")
              .map((block) => block.text!)
              .join("")
          : undefined;
    return sanitizeTitle(text);
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeTitle(raw: string | undefined) {
  if (!raw) return undefined;
  const title = raw
    .replace(/^["'“”‘’]+|["'“”‘’。.!！?？:：]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return undefined;
  return title.slice(0, 40);
}

function guessImageExt(mimeType: string, name?: string) {
  const fromName = name ? path.extname(name).toLowerCase() : "";
  if (fromName) return fromName;
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/heic":
      return ".heic";
    case "image/heif":
      return ".heif";
    default:
      return ".bin";
  }
}

function mimeFromExt(ext: string): string | undefined {
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".heic":
      return "image/heic";
    case ".heif":
      return "image/heif";
    default:
      return undefined;
  }
}
