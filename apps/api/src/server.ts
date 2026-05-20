import http from "node:http";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import express from "express";
import multer from "multer";
import sharp from "sharp";
import { v4 as uuid } from "uuid";
import { ClaudeAgentRuntime, MockAgentRuntime } from "@openclaude/agent-runtime";
import { DEFAULT_MODEL_ID, EFFORT_LEVELS, models } from "@openclaude/model-registry";
import {
  createWorkspaceFolderRequestSchema,
  createRunRequestSchema,
  createSessionRequestSchema,
  loginRequestSchema,
  moveWorkspacePathRequestSchema,
  workspacePathSchema,
  type Run,
  type Session,
  type Workspace,
  type WorkspaceFileNode,
  type WorkspaceFilePreviewType
} from "@openclaude/shared";
import { LocalWorkspaceManager, WorkspacePathGuard } from "@openclaude/sandbox";
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
        maxTurns: config.agentMaxTurns,
        systemPromptAppend: config.agentSystemPromptAppend,
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
const MAX_WORKSPACE_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_WORKSPACE_PREVIEW_BYTES = 1024 * 1024;
const MAX_WORKSPACE_UPLOAD_FILES = 50;
const MAX_WORKSPACE_TREE_NODES = 1000;

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

const workspaceUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_WORKSPACE_UPLOAD_BYTES, files: MAX_WORKSPACE_UPLOAD_FILES }
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

app.get("/api/workspace/files", async (request, response, next) => {
  try {
    const parsed = workspacePathSchema.safeParse(typeof request.query.path === "string" ? request.query.path : "");
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const workspace = await getOrCreateGlobalWorkspace(request.user!.id);
    const target = resolveWorkspacePath(workspace.rootPath, parsed.data ?? "");
    const root = await buildWorkspaceNode(workspace.rootPath, target.absolutePath, target.relativePath, { count: 0 });
    response.json({ root, rootPath: workspace.rootPath });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspace/files/content", async (request, response, next) => {
  try {
    const parsed = workspacePathSchema.safeParse(typeof request.query.path === "string" ? request.query.path : "");
    if (!parsed.success || !parsed.data) {
      response.status(400).json({ error: parsed.success ? "Missing path" : parsed.error.flatten() });
      return;
    }
    const workspace = await getOrCreateGlobalWorkspace(request.user!.id);
    const target = resolveWorkspacePath(workspace.rootPath, parsed.data);
    const info = await lstat(target.absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      response.status(400).json({ error: "Path is not a file" });
      return;
    }
    if (info.size > MAX_WORKSPACE_PREVIEW_BYTES) {
      response.status(413).json({ error: "File is too large to preview" });
      return;
    }
    const previewType = previewTypeForPath(target.absolutePath);
    if (!["text", "markdown", "code"].includes(previewType)) {
      response.status(400).json({ error: "File type is not text-previewable" });
      return;
    }
    response.json({
      path: target.relativePath,
      name: path.basename(target.absolutePath),
      mimeType: mimeFromExt(path.extname(target.absolutePath).toLowerCase()),
      previewType,
      content: await readFile(target.absolutePath, "utf8"),
      sizeBytes: info.size,
      updatedAt: info.mtime.toISOString()
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspace/files/raw", async (request, response, next) => {
  try {
    const parsed = workspacePathSchema.safeParse(typeof request.query.path === "string" ? request.query.path : "");
    if (!parsed.success || !parsed.data) {
      response.status(400).json({ error: parsed.success ? "Missing path" : parsed.error.flatten() });
      return;
    }
    const workspace = await getOrCreateGlobalWorkspace(request.user!.id);
    const target = resolveWorkspacePath(workspace.rootPath, parsed.data);
    const info = await lstat(target.absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      response.status(400).json({ error: "Path is not a file" });
      return;
    }
    response.sendFile(target.absolutePath, {
      headers: {
        "Cache-Control": "private, max-age=300"
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/workspace/files/upload",
  (request, response, next) => {
    workspaceUploadMiddleware.array("files", MAX_WORKSPACE_UPLOAD_FILES)(request, response, (err) => {
      if (err) {
        response.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      next();
    });
  },
  async (request, response, next) => {
    try {
      const workspace = await getOrCreateGlobalWorkspace(request.user!.id);
      const files = (request.files as Express.Multer.File[] | undefined) ?? [];
      const targetPath = typeof request.body.targetPath === "string" ? request.body.targetPath : "";
      const uploadedPaths = parseUploadPaths(request.body.paths);
      const targetDir = normalizeWorkspaceRelativePath(targetPath);
      const uploaded: Array<{ name: string; path: string; mimeType?: string; sizeBytes: number }> = [];
      for (const [index, file] of files.entries()) {
        const relativeUploadPath = normalizeWorkspaceRelativePath(uploadedPaths[index] || file.originalname);
        if (!relativeUploadPath) continue;
        const destinationRelativePath = normalizeWorkspaceRelativePath(path.posix.join(targetDir, relativeUploadPath));
        const destination = resolveWorkspacePath(workspace.rootPath, destinationRelativePath);
        await mkdir(path.dirname(destination.absolutePath), { recursive: true });
        await writeFile(destination.absolutePath, file.buffer);
        uploaded.push({
          name: path.basename(destination.absolutePath),
          path: destination.relativePath,
          mimeType: file.mimetype || mimeFromExt(path.extname(destination.absolutePath).toLowerCase()),
          sizeBytes: file.size
        });
      }
      response.status(201).json({ files: uploaded });
    } catch (error) {
      next(error);
    }
  }
);

app.post("/api/workspace/folders", async (request, response, next) => {
  try {
    const parsed = createWorkspaceFolderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const workspace = await getOrCreateGlobalWorkspace(request.user!.id);
    const target = resolveWorkspacePath(workspace.rootPath, parsed.data.path);
    if (!target.relativePath) {
      response.status(400).json({ error: "Cannot create the workspace root" });
      return;
    }
    await mkdir(target.absolutePath, { recursive: true });
    response.status(201).json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/workspace/files", async (request, response, next) => {
  try {
    const parsed = workspacePathSchema.safeParse(typeof request.query.path === "string" ? request.query.path : "");
    if (!parsed.success || !parsed.data) {
      response.status(400).json({ error: parsed.success ? "Missing path" : parsed.error.flatten() });
      return;
    }
    const workspace = await getOrCreateGlobalWorkspace(request.user!.id);
    const target = resolveWorkspacePath(workspace.rootPath, parsed.data);
    if (!target.relativePath) {
      response.status(400).json({ error: "Cannot delete the workspace root" });
      return;
    }
    await rm(target.absolutePath, { recursive: true, force: true });
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/workspace/files", async (request, response, next) => {
  try {
    const parsed = moveWorkspacePathRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.flatten() });
      return;
    }
    const workspace = await getOrCreateGlobalWorkspace(request.user!.id);
    const source = resolveWorkspacePath(workspace.rootPath, parsed.data.fromPath);
    const destination = resolveWorkspacePath(workspace.rootPath, parsed.data.toPath);
    if (!source.relativePath || !destination.relativePath) {
      response.status(400).json({ error: "Cannot move the workspace root" });
      return;
    }
    if (
      destination.relativePath === source.relativePath ||
      destination.relativePath.startsWith(`${source.relativePath}/`)
    ) {
      response.status(400).json({ error: "Cannot move a path into itself" });
      return;
    }
    await lstat(source.absolutePath);
    if (await pathExists(destination.absolutePath)) {
      response.status(409).json({ error: "Destination already exists" });
      return;
    }
    await mkdir(path.dirname(destination.absolutePath), { recursive: true });
    await rename(source.absolutePath, destination.absolutePath);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

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

    const workspace = await getOrCreateGlobalWorkspace(request.user!.id);

    const session: Session = createTimestamped({
      id: uuid(),
      userId: request.user!.id,
      workspaceId: workspace.id,
      title: parsed.data.title ?? "New chat",
      sdkSessionStoragePath: workspace.sdkSessionStoragePath,
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
    const activeRun = store.getActiveRunForSession(session.id, request.user!.id);
    response.json({
      session,
      messages: store.listMessagesForSession(session.id, request.user!.id),
      runMeta: store.listRunMetasForSession(session.id, request.user!.id),
      activeRun: activeRun
        ? { runId: activeRun.id, latestSequence: store.getLatestEventSequence(activeRun.id) }
        : undefined
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:sessionId/attachments/:filename", async (request, response, next) => {
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
    const uploadsDir = path.join(workspaceManager.globalLayout(request.user!.id).attachmentsPath, session.id);
    const thumbsDir = path.join(uploadsDir, "thumbs");
    const fullPath = path.join(uploadsDir, filename);
    const wantsFull = request.query.full === "1" || request.query.full === "true";

    let target = fullPath;
    if (!wantsFull) {
      const thumb = await ensureThumbnail(fullPath, thumbsDir, filename);
      if (thumb) target = thumb;
    }
    response.sendFile(target, {
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
      const uploadsDir = path.join(workspaceManager.globalLayout(request.user!.id).attachmentsPath, session.id);
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

    const referencedFilePaths = await resolveWorkspaceFileRefs(workspace.rootPath, parsed.data.fileRefs ?? []);
    const promptForRun = appendWorkspaceFileRefs(parsed.data.prompt, referencedFilePaths);
    const isFirstRunInSession = store.countRunsForSession(session.id) === 0;
    const run: Run = createTimestamped({
      id: uuid(),
      sessionId: session.id,
      userId: request.user!.id,
      workspaceId: session.workspaceId,
      status: "queued",
      model: parsed.data.model ?? session.currentModel,
      input: {
        prompt: promptForRun,
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

async function getOrCreateGlobalWorkspace(userId: string): Promise<Workspace> {
  const layout = await workspaceManager.ensureGlobalWorkspace(userId);
  const workspaceId = workspaceManager.globalWorkspaceId(userId);
  const existing = store.getWorkspace(workspaceId);
  const workspace: Workspace = existing
    ? {
        ...existing,
        name: "Workspace",
        rootPath: layout.workspaceRoot,
        sharedHomePath: layout.sharedHomePath,
        sdkSessionStoragePath: layout.sdkSessionStoragePath,
        updatedAt: new Date().toISOString()
      }
    : createTimestamped({
        id: workspaceId,
        userId,
        name: "Workspace",
        rootPath: layout.workspaceRoot,
        sharedHomePath: layout.sharedHomePath,
        sdkSessionStoragePath: layout.sdkSessionStoragePath
      });
  await store.upsertWorkspace(workspace);
  return workspace;
}

function normalizeWorkspaceRelativePath(input: string | undefined): string {
  const raw = (input ?? "").replace(/\\/g, "/").trim();
  if (!raw || raw === ".") return "";
  if (raw.includes("\0") || raw.startsWith("/") || path.isAbsolute(raw)) {
    throw new Error("Invalid workspace path");
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Invalid workspace path");
  }
  return normalized;
}

function resolveWorkspacePath(rootPath: string, relativePath: string) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const guard = new WorkspacePathGuard(rootPath);
  return {
    relativePath: normalized,
    absolutePath: guard.resolveInside(normalized)
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function buildWorkspaceNode(
  workspaceRoot: string,
  absolutePath: string,
  relativePath: string,
  counter: { count: number }
): Promise<WorkspaceFileNode> {
  const info = await lstat(absolutePath);
  const name = relativePath ? path.basename(relativePath) : "workspace";
  counter.count += 1;
  if (!info.isDirectory()) {
    return {
      name,
      path: relativePath,
      type: "file",
      sizeBytes: info.size,
      updatedAt: info.mtime.toISOString(),
      mimeType: mimeFromExt(path.extname(absolutePath).toLowerCase()),
      previewType: previewTypeForPath(absolutePath)
    };
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  const children: WorkspaceFileNode[] = [];
  for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (counter.count >= MAX_WORKSPACE_TREE_NODES) break;
    if (entry.name === ".DS_Store" || entry.name === ".claude") continue;
    const childAbsolutePath = path.join(absolutePath, entry.name);
    const childRelativePath = normalizeWorkspaceRelativePath(path.relative(workspaceRoot, childAbsolutePath));
    children.push(await buildWorkspaceNode(workspaceRoot, childAbsolutePath, childRelativePath, counter));
  }
  return {
    name,
    path: relativePath,
    type: "directory",
    updatedAt: info.mtime.toISOString(),
    children
  };
}

function parseUploadPaths(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed) ? parsed.map((value) => (typeof value === "string" ? value : "")) : [];
}

async function resolveWorkspaceFileRefs(workspaceRoot: string, fileRefs: string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const ref of [...new Set(fileRefs)]) {
    const target = resolveWorkspacePath(workspaceRoot, ref);
    const info = await stat(target.absolutePath);
    if (!info.isFile()) throw new Error(`Referenced workspace path is not a file: ${ref}`);
    resolved.push(target.absolutePath);
  }
  return resolved;
}

function appendWorkspaceFileRefs(prompt: string, absolutePaths: string[]): string {
  if (absolutePaths.length === 0) return prompt;
  return `${prompt.trimEnd()}\n\nReferenced workspace files:\n${absolutePaths.map((filePath) => `- ${filePath}`).join("\n")}`;
}

function previewTypeForPath(filePath: string): WorkspaceFilePreviewType {
  const ext = path.extname(filePath).toLowerCase();
  if ([".md", ".markdown", ".mdx"].includes(ext)) return "markdown";
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif"].includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (
    [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".json",
      ".css",
      ".html",
      ".py",
      ".go",
      ".rs",
      ".java",
      ".cpp",
      ".c",
      ".h",
      ".hpp",
      ".sh",
      ".yml",
      ".yaml",
      ".toml",
      ".xml",
      ".sql"
    ].includes(ext)
  ) {
    return "code";
  }
  if ([".txt", ".log", ".csv"].includes(ext)) return "text";
  return "unsupported";
}

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

const TITLE_MAX_IMAGES = 3;
const VISION_THUMBNAIL_MAX_DIMENSION = 1024;
const ATTACHMENT_THUMBNAIL_MAX_DIMENSION = 1024;
const VISION_JPEG_QUALITY = 80;

async function ensureThumbnail(filePath: string, thumbDir: string, filename: string): Promise<string | undefined> {
  const thumbPath = path.join(thumbDir, `${filename}.jpg`);
  let originalStat: Awaited<ReturnType<typeof stat>>;
  try {
    originalStat = await stat(filePath);
  } catch {
    return undefined;
  }
  try {
    const thumbStat = await stat(thumbPath);
    if (thumbStat.mtimeMs >= originalStat.mtimeMs) return thumbPath;
  } catch {
    // thumbnail missing — fall through to (re)generate
  }
  try {
    await mkdir(thumbDir, { recursive: true });
    await sharp(filePath)
      .rotate()
      .resize({
        width: ATTACHMENT_THUMBNAIL_MAX_DIMENSION,
        height: ATTACHMENT_THUMBNAIL_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: VISION_JPEG_QUALITY, mozjpeg: true })
      .toFile(thumbPath);
    return thumbPath;
  } catch (error) {
    console.warn("Failed to generate thumbnail", filePath, error);
    return undefined;
  }
}

async function loadVisionThumbnail(
  filePath: string
): Promise<{ data: string; mediaType: "image/jpeg" } | undefined> {
  try {
    const buffer = await sharp(filePath)
      .rotate()
      .resize({
        width: VISION_THUMBNAIL_MAX_DIMENSION,
        height: VISION_THUMBNAIL_MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true
      })
      .jpeg({ quality: VISION_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return { data: buffer.toString("base64"), mediaType: "image/jpeg" };
  } catch (error) {
    console.warn("Failed to prepare vision thumbnail", filePath, error);
    return undefined;
  }
}

async function generateSessionTitle(
  prompt: string,
  attachments: TitleAttachment[] = []
): Promise<string | undefined> {
  if (!config.openRouterApiKey) return undefined;

  const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
  for (const attachment of attachments) {
    if (imageBlocks.length >= TITLE_MAX_IMAGES) break;
    if (attachment.kind !== "image") continue;
    const thumbnail = await loadVisionThumbnail(attachment.workspaceFilePath);
    if (!thumbnail) continue;
    imageBlocks.push({
      type: "image_url",
      image_url: { url: `data:${thumbnail.mediaType};base64,${thumbnail.data}` }
    });
  }

  const trimmedPrompt = prompt.trim();
  const hasUserText = Boolean(trimmedPrompt) && trimmedPrompt !== "(image input)";
  const introText = hasUserText
    ? `Title this conversation. The user just sent the following message${imageBlocks.length > 0 ? " (with image attachments shown below)" : ""}:\n\n${trimmedPrompt.slice(0, 2000)}`
    : "Title this conversation. The user sent only image attachments — base the title on what the images show.";
  const userContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [{ type: "text", text: introText }, ...imageBlocks];
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
              "You generate conversation titles. ALWAYS reply with the title text only — no quotes, no trailing punctuation, no explanations, never ask the user for more information. Match the user's language. Maximum 8 Chinese characters or 5 English words. If the user message is short or only contains images, infer the topic from whatever you can see."
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
    case ".pdf":
      return "application/pdf";
    case ".md":
    case ".markdown":
      return "text/markdown; charset=utf-8";
    case ".txt":
    case ".log":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".js":
    case ".jsx":
    case ".ts":
    case ".tsx":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".csv":
      return "text/csv; charset=utf-8";
    default:
      return undefined;
  }
}
