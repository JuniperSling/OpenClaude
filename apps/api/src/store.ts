import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentStreamEnvelope, Run, RunSnapshot, Session, SessionWithWorkspace, User, Workspace } from "@openclaude/shared";

type DatabaseShape = {
  users: User[];
  workspaces: Workspace[];
  sessions: Session[];
  runs: Run[];
  events: Record<string, AgentStreamEnvelope[]>;
};

export type StoredMessage = {
  id: string;
  sessionId: string;
  runId: string;
  role: "user" | "assistant" | "tool";
  content?: string;
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  toolStatus?: "running" | "done";
  attachments?: StoredMessageAttachment[];
  sequence: number;
  createdAt: string;
  updatedAt: string;
};

export type StoredMessageAttachment = {
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type StoredRunMeta = {
  runId: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  raw?: string;
};

type RunRow = {
  id: string;
  session_id: string;
  user_id: string;
  workspace_id: string;
  status: Run["status"];
  model: string;
  input_json: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  cost_usd: number | null;
  num_turns: number | null;
  stop_reason: string | null;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  title: string;
  sdk_session_id: string | null;
  sdk_session_storage_path: string;
  current_model: string;
  created_at: string;
  updated_at: string;
};

type WorkspaceRow = {
  id: string;
  user_id: string;
  name: string;
  root_path: string;
  shared_home_path: string;
  sdk_session_storage_path: string;
  created_at: string;
  updated_at: string;
};

const now = () => new Date().toISOString();

export class FileStore {
  private db?: DatabaseSync;
  private readonly dbPath: string;
  private readonly legacyPath: string;
  private readonly streamedRunIds = new Set<string>();

  constructor(
    private readonly dataDir: string,
    private readonly adminUsername: string
  ) {
    this.dbPath = path.join(dataDir, "openclaude.sqlite");
    this.legacyPath = path.join(dataDir, "store.json");
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.createSchema();
    this.runColumnMigrations();
    await this.migrateLegacyStoreIfNeeded();
    await this.ensureAdminUser();
    await this.discardLegacySessionWorkspaces();
    await this.discardVisibleWorkspaceInternals();
    await this.markRunningRunsInterrupted();
  }

  private runColumnMigrations() {
    const columns = this.database().prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    const hasAttachments = columns.some((col) => col.name === "attachments_json");
    if (!hasAttachments) {
      this.database().exec("ALTER TABLE messages ADD COLUMN attachments_json TEXT");
    }
  }

  getUserByUsername(username: string) {
    const row = this.database()
      .prepare("SELECT id, username, role, created_at, updated_at FROM users WHERE username = ?")
      .get(username) as Record<string, unknown> | undefined;
    return row ? mapUser(row) : undefined;
  }

  getUserById(id: string) {
    const row = this.database()
      .prepare("SELECT id, username, role, created_at, updated_at FROM users WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapUser(row) : undefined;
  }

  listSessions(userId: string): SessionWithWorkspace[] {
    const rows = this.database()
      .prepare(
        `SELECT
          s.id as session_id,
          s.user_id as session_user_id,
          s.workspace_id,
          s.title,
          s.sdk_session_id,
          s.sdk_session_storage_path as session_sdk_session_storage_path,
          s.current_model,
          s.created_at as session_created_at,
          s.updated_at as session_updated_at,
          w.id as workspace_row_id,
          w.user_id as workspace_user_id,
          w.name as workspace_name,
          w.root_path,
          w.shared_home_path,
          w.sdk_session_storage_path as workspace_sdk_session_storage_path,
          w.created_at as workspace_created_at,
          w.updated_at as workspace_updated_at
        FROM sessions s
        JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.user_id = ?
        ORDER BY s.updated_at DESC`
      )
      .all(userId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: String(row.session_id),
      userId: String(row.session_user_id),
      workspaceId: String(row.workspace_id),
      title: String(row.title),
      sdkSessionId: nullableString(row.sdk_session_id),
      sdkSessionStoragePath: String(row.session_sdk_session_storage_path),
      currentModel: String(row.current_model),
      createdAt: String(row.session_created_at),
      updatedAt: String(row.session_updated_at),
      workspace: {
        id: String(row.workspace_row_id),
        userId: String(row.workspace_user_id),
        name: String(row.workspace_name),
        rootPath: String(row.root_path),
        sharedHomePath: String(row.shared_home_path),
        sdkSessionStoragePath: String(row.workspace_sdk_session_storage_path),
        createdAt: String(row.workspace_created_at),
        updatedAt: String(row.workspace_updated_at)
      }
    }));
  }

  getSession(id: string) {
    const row = this.database().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  getSessionWithWorkspace(id: string, userId: string): SessionWithWorkspace | undefined {
    const session = this.getSession(id);
    if (!session || session.userId !== userId) return undefined;
    const workspace = this.getWorkspace(session.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${session.workspaceId}`);
    return { ...session, workspace };
  }

  countRunsForSession(sessionId: string) {
    const row = this.database().prepare("SELECT COUNT(*) as count FROM runs WHERE session_id = ?").get(sessionId) as {
      count: number;
    };
    return row.count;
  }

  hasActiveRunsForSession(sessionId: string) {
    const row = this.database()
      .prepare("SELECT COUNT(*) as count FROM runs WHERE session_id = ? AND status IN ('queued', 'running')")
      .get(sessionId) as { count: number };
    return row.count > 0;
  }

  getWorkspace(id: string) {
    const row = this.database().prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
    return row ? mapWorkspace(row) : undefined;
  }

  async createWorkspace(workspace: Workspace) {
    this.database()
      .prepare(
        `INSERT INTO workspaces (
          id, user_id, name, root_path, shared_home_path, sdk_session_storage_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        workspace.id,
        workspace.userId,
        workspace.name,
        workspace.rootPath,
        workspace.sharedHomePath,
        workspace.sdkSessionStoragePath,
        workspace.createdAt,
        workspace.updatedAt
      );
    return workspace;
  }

  async upsertWorkspace(workspace: Workspace) {
    this.insertWorkspace(workspace);
    return workspace;
  }

  async createSession(session: Session) {
    this.database()
      .prepare(
        `INSERT INTO sessions (
          id, user_id, workspace_id, title, sdk_session_id, sdk_session_storage_path, current_model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.userId,
        session.workspaceId,
        session.title,
        session.sdkSessionId ?? null,
        session.sdkSessionStoragePath,
        session.currentModel,
        session.createdAt,
        session.updatedAt
      );
    return session;
  }

  async updateSession(id: string, patch: Partial<Session>) {
    const session = this.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    const updated = { ...session, ...patch, updatedAt: now() };
    this.database()
      .prepare(
        `UPDATE sessions SET
          title = ?, sdk_session_id = ?, sdk_session_storage_path = ?, current_model = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(
        updated.title,
        updated.sdkSessionId ?? null,
        updated.sdkSessionStoragePath,
        updated.currentModel,
        updated.updatedAt,
        id
      );
    return updated;
  }

  async deleteSession(id: string, userId: string) {
    const session = this.getSession(id);
    if (!session || session.userId !== userId) return false;
    this.database().prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return true;
  }

  async createRun(run: Run) {
    this.database()
      .prepare(
        `INSERT INTO runs (
          id, session_id, user_id, workspace_id, status, model, input_json,
          started_at, finished_at, error, cost_usd, num_turns, stop_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.sessionId,
        run.userId,
        run.workspaceId,
        run.status,
        run.model,
        JSON.stringify(run.input),
        run.startedAt ?? null,
        run.finishedAt ?? null,
        run.error ?? null,
        run.costUsd ?? null,
        run.numTurns ?? null,
        run.stopReason ?? null,
        run.createdAt,
        run.updatedAt
      );
    this.insertUserMessage(run);
    this.touchSession(run.sessionId);
    return run;
  }

  getRun(id: string): Run | undefined {
    const row = this.database().prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  getRunSnapshot(id: string): RunSnapshot | undefined {
    const run = this.getRun(id);
    if (!run) return undefined;
    return { ...run, events: this.getEvents(id) };
  }

  listRunSnapshotsForSession(sessionId: string, userId: string): RunSnapshot[] {
    const rows = this.database()
      .prepare("SELECT * FROM runs WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC")
      .all(sessionId, userId) as RunRow[];
    return rows.map((row) => {
      const run = mapRun(row);
      return { ...run, events: this.getEvents(run.id) };
    });
  }

  listMessagesForSession(sessionId: string, userId: string): StoredMessage[] {
    const session = this.getSession(sessionId);
    if (!session || session.userId !== userId) return [];
    const rows = this.database()
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, sequence ASC")
      .all(sessionId) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }

  listRunMetasForSession(sessionId: string, userId: string): StoredRunMeta[] {
    const runs = this.database()
      .prepare("SELECT * FROM runs WHERE session_id = ? AND user_id = ? ORDER BY created_at ASC")
      .all(sessionId, userId) as RunRow[];
    const messages = this.database()
      .prepare("SELECT run_id, content FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at ASC")
      .all(sessionId) as Array<{ run_id: string; content: string | null }>;
    const rawByRunId = new Map<string, string>();
    for (const message of messages) {
      rawByRunId.set(message.run_id, `${rawByRunId.get(message.run_id) ?? ""}${message.content ?? ""}`);
    }

    return runs.map((row) => {
      const usage = this.extractRunUsage(row.id);
      return {
        runId: row.id,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens:
          usage.inputTokens !== undefined || usage.outputTokens !== undefined
            ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
            : undefined,
        costUsd: row.cost_usd ?? usage.costUsd,
        raw: rawByRunId.get(row.id)
      };
    });
  }

  countRunningRuns(userId: string) {
    const row = this.database()
      .prepare("SELECT COUNT(*) as count FROM runs WHERE user_id = ? AND status = 'running'")
      .get(userId) as { count: number };
    return row.count;
  }

  async updateRun(id: string, patch: Partial<Run>) {
    const run = this.getRun(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    const updated = { ...run, ...patch, updatedAt: now() };
    this.database()
      .prepare(
        `UPDATE runs SET
          status = ?, model = ?, input_json = ?, started_at = ?, finished_at = ?, error = ?,
          cost_usd = ?, num_turns = ?, stop_reason = ?, updated_at = ?
        WHERE id = ?`
      )
      .run(
        updated.status,
        updated.model,
        JSON.stringify(updated.input),
        updated.startedAt ?? null,
        updated.finishedAt ?? null,
        updated.error ?? null,
        updated.costUsd ?? null,
        updated.numTurns ?? null,
        updated.stopReason ?? null,
        updated.updatedAt,
        id
      );
    return updated;
  }

  async appendEvent(event: AgentStreamEnvelope) {
    this.database()
      .prepare("INSERT OR REPLACE INTO events (run_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?)")
      .run(event.runId, event.sequence, JSON.stringify(event), event.timestamp);
    this.appendEventToMessages(event);
  }

  getEvents(runId: string, afterSequence = 0) {
    const rows = this.database()
      .prepare("SELECT event_json FROM events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC")
      .all(runId, afterSequence) as Array<{ event_json: string }>;
    return rows.map((row) => JSON.parse(row.event_json) as AgentStreamEnvelope);
  }

  private createSchema() {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        shared_home_path TEXT NOT NULL,
        sdk_session_storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        sdk_session_id TEXT,
        sdk_session_storage_path TEXT NOT NULL,
        current_model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        input_json TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error TEXT,
        cost_usd REAL,
        num_turns INTEGER,
        stop_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, sequence),
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_use_id TEXT,
        tool_name TEXT,
        tool_input_json TEXT,
        tool_result_json TEXT,
        tool_status TEXT,
        attachments_json TEXT,
        sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_session_created ON runs(session_id, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_messages_session_sequence ON messages(session_id, sequence ASC);
    `);
  }

  private async migrateLegacyStoreIfNeeded() {
    const migrated = this.database().prepare("SELECT value FROM meta WHERE key = 'legacy_store_migrated'").get();
    if (migrated || !existsSync(this.legacyPath)) return;

    const raw = await readFile(this.legacyPath, "utf8");
    const legacy = JSON.parse(raw) as DatabaseShape;
    const db = this.database();
    db.exec("BEGIN");
    try {
      for (const user of legacy.users ?? []) this.insertUser(user);
      for (const workspace of legacy.workspaces ?? []) this.insertWorkspace(workspace);
      for (const session of legacy.sessions ?? []) this.insertSession(session);
      for (const run of legacy.runs ?? []) {
        this.insertRunOnly(run);
        this.insertUserMessage(run);
      }
      for (const [runId, events] of Object.entries(legacy.events ?? {})) {
        const streamedRunIds = new Set<string>();
        for (const event of events) {
          this.database()
            .prepare("INSERT OR REPLACE INTO events (run_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?)")
            .run(runId, event.sequence, JSON.stringify(event), event.timestamp);
          this.appendEventToMessages(event, streamedRunIds);
        }
      }
      this.database().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_store_migrated', ?)").run(now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    await rename(this.legacyPath, `${this.legacyPath}.migrated-${Date.now()}`);
  }

  private async markRunningRunsInterrupted() {
    this.database()
      .prepare(
        `UPDATE runs
        SET status = 'interrupted_by_restart',
            finished_at = ?,
            stop_reason = 'interrupted_by_restart',
            updated_at = ?
        WHERE status IN ('running', 'queued')`
      )
      .run(now(), now());
  }

  private async discardLegacySessionWorkspaces() {
    const migrated = this.database().prepare("SELECT value FROM meta WHERE key = 'global_workspace_v1'").get();
    if (migrated) return;

    const users = this.database().prepare("SELECT id FROM users").all() as Array<{ id: string }>;
    this.database().exec("BEGIN");
    try {
      this.database().prepare("DELETE FROM workspaces").run();
      this.database().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('global_workspace_v1', ?)").run(now());
      this.database().exec("COMMIT");
    } catch (error) {
      this.database().exec("ROLLBACK");
      throw error;
    }

    for (const user of users) {
      await rm(path.join(this.dataDir, "users", user.id, "workspaces"), { recursive: true, force: true });
    }
    await rm(path.join(this.dataDir, "run-events"), { recursive: true, force: true });
  }

  private async discardVisibleWorkspaceInternals() {
    const migrated = this.database().prepare("SELECT value FROM meta WHERE key = 'visible_workspace_v1'").get();
    if (migrated) return;

    const users = this.database().prepare("SELECT id FROM users").all() as Array<{ id: string }>;
    this.database().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('visible_workspace_v1', ?)").run(now());
    for (const user of users) {
      const workspaceRoot = path.join(this.dataDir, "users", user.id, "workspace");
      for (const internalName of [".claude", "files", "uploads"]) {
        await rm(path.join(workspaceRoot, internalName), { recursive: true, force: true });
      }
    }
  }

  private async ensureAdminUser() {
    const timestamp = now();
    const existing = this.getUserById("admin");
    if (!existing) {
      this.insertUser({
        id: "admin",
        username: this.adminUsername,
        role: "admin",
        createdAt: timestamp,
        updatedAt: timestamp
      });
      return;
    }
    if (existing.username !== this.adminUsername) {
      this.database().prepare("UPDATE users SET username = ?, updated_at = ? WHERE id = 'admin'").run(this.adminUsername, timestamp);
    }
  }

  private appendEventToMessages(event: AgentStreamEnvelope, streamedRunIds = this.streamedRunIds) {
    const run = this.getRun(event.runId);
    if (!run) return;

    const toolUse = extractToolUse(event.sdkEvent);
    if (toolUse) {
      this.database()
        .prepare(
          `INSERT OR IGNORE INTO messages (
            id, session_id, run_id, role, tool_use_id, tool_name, tool_input_json, tool_status,
            sequence, created_at, updated_at
          ) VALUES (?, ?, ?, 'tool', ?, ?, ?, 'running', ?, ?, ?)`
        )
        .run(
          `tool-${toolUse.id}`,
          run.sessionId,
          run.id,
          toolUse.id,
          toolUse.name,
          toolUse.input === undefined ? null : JSON.stringify(toolUse.input),
          event.sequence,
          event.timestamp,
          event.timestamp
        );
      return;
    }

    const toolResult = extractToolResult(event.sdkEvent);
    if (toolResult) {
      const existing = this.database()
        .prepare("SELECT id FROM messages WHERE tool_use_id = ? AND role = 'tool'")
        .get(toolResult.toolUseId) as { id: string } | undefined;
      if (existing) {
        this.database()
          .prepare("UPDATE messages SET tool_result_json = ?, tool_status = 'done', updated_at = ? WHERE id = ?")
          .run(JSON.stringify(toolResult.result), event.timestamp, existing.id);
      } else {
        this.database()
          .prepare(
            `INSERT INTO messages (
              id, session_id, run_id, role, tool_use_id, tool_name, tool_result_json, tool_status,
              sequence, created_at, updated_at
            ) VALUES (?, ?, ?, 'tool', ?, 'Tool', ?, 'done', ?, ?, ?)`
          )
          .run(
            `tool-${toolResult.toolUseId}`,
            run.sessionId,
            run.id,
            toolResult.toolUseId,
            JSON.stringify(toolResult.result),
            event.sequence,
            event.timestamp,
            event.timestamp
          );
      }
      return;
    }

    if (event.uiHints?.kind !== "text" || !event.uiHints.textDelta) return;
    if (event.uiHints.isPartial) {
      streamedRunIds.add(event.runId);
    } else if (streamedRunIds.has(event.runId)) {
      return;
    }

    const assistantId = `assistant-${event.runId}`;
    const existing = this.database().prepare("SELECT content FROM messages WHERE id = ?").get(assistantId) as
      | { content: string | null }
      | undefined;
    if (existing) {
      this.database()
        .prepare("UPDATE messages SET content = ?, updated_at = ? WHERE id = ?")
        .run(`${existing.content ?? ""}${event.uiHints.textDelta}`, event.timestamp, assistantId);
      return;
    }
    this.database()
      .prepare(
        `INSERT INTO messages (
          id, session_id, run_id, role, content, sequence, created_at, updated_at
        ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)`
      )
      .run(assistantId, run.sessionId, run.id, event.uiHints.textDelta, event.sequence, event.timestamp, event.timestamp);
  }

  private insertUserMessage(run: Run) {
    const attachments: StoredMessageAttachment[] =
      run.input.attachments
        ?.filter((attachment) => attachment.kind === "image")
        .map((attachment) => ({
          filename: path.basename(attachment.workspaceFilePath),
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes
        })) ?? [];

    this.database()
      .prepare(
        `INSERT OR IGNORE INTO messages (
          id, session_id, run_id, role, content, attachments_json, sequence, created_at, updated_at
        ) VALUES (?, ?, ?, 'user', ?, ?, 0, ?, ?)`
      )
      .run(
        `user-${run.id}`,
        run.sessionId,
        run.id,
        run.input.prompt,
        attachments.length > 0 ? JSON.stringify(attachments) : null,
        run.createdAt,
        run.updatedAt
      );
  }

  private touchSession(sessionId: string) {
    this.database().prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), sessionId);
  }

  private insertUser(user: User) {
    this.database()
      .prepare("INSERT OR REPLACE INTO users (id, username, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, user.username, user.role, user.createdAt, user.updatedAt);
  }

  private insertWorkspace(workspace: Workspace) {
    // IMPORTANT: do not use `INSERT OR REPLACE` here. SQLite implements
    // `REPLACE` as DELETE + INSERT, which fires the `ON DELETE CASCADE`
    // on `sessions.workspace_id` and wipes out every session, run,
    // message, and event for the workspace. Use a real upsert instead.
    this.database()
      .prepare(
        `INSERT INTO workspaces (
          id, user_id, name, root_path, shared_home_path, sdk_session_storage_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          user_id = excluded.user_id,
          name = excluded.name,
          root_path = excluded.root_path,
          shared_home_path = excluded.shared_home_path,
          sdk_session_storage_path = excluded.sdk_session_storage_path,
          updated_at = excluded.updated_at`
      )
      .run(
        workspace.id,
        workspace.userId,
        workspace.name,
        workspace.rootPath,
        workspace.sharedHomePath,
        workspace.sdkSessionStoragePath,
        workspace.createdAt,
        workspace.updatedAt
      );
  }

  private insertSession(session: Session) {
    this.database()
      .prepare(
        `INSERT OR REPLACE INTO sessions (
          id, user_id, workspace_id, title, sdk_session_id, sdk_session_storage_path, current_model, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.userId,
        session.workspaceId,
        session.title,
        session.sdkSessionId ?? null,
        session.sdkSessionStoragePath,
        session.currentModel,
        session.createdAt,
        session.updatedAt
      );
  }

  private insertRunOnly(run: Run) {
    this.database()
      .prepare(
        `INSERT OR REPLACE INTO runs (
          id, session_id, user_id, workspace_id, status, model, input_json,
          started_at, finished_at, error, cost_usd, num_turns, stop_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.id,
        run.sessionId,
        run.userId,
        run.workspaceId,
        run.status,
        run.model,
        JSON.stringify(run.input),
        run.startedAt ?? null,
        run.finishedAt ?? null,
        run.error ?? null,
        run.costUsd ?? null,
        run.numTurns ?? null,
        run.stopReason ?? null,
        run.createdAt,
        run.updatedAt
      );
  }

  private database() {
    if (!this.db) throw new Error("Store has not been loaded");
    return this.db;
  }

  private extractRunUsage(runId: string) {
    const rows = this.database()
      .prepare("SELECT event_json FROM events WHERE run_id = ? ORDER BY sequence ASC")
      .all(runId) as Array<{ event_json: string }>;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let costUsd: number | undefined;
    for (const row of rows) {
      const envelope = JSON.parse(row.event_json) as AgentStreamEnvelope;
      const usage = extractUsage(envelope.sdkEvent);
      if (usage.inputTokens !== undefined) inputTokens = usage.inputTokens;
      if (usage.outputTokens !== undefined) outputTokens = usage.outputTokens;
      if (usage.costUsd !== undefined) costUsd = usage.costUsd;
    }
    return { inputTokens, outputTokens, costUsd };
  }
}

export function createTimestamped<T extends object>(value: T): T & { createdAt: string; updatedAt: string } {
  const timestamp = now();
  return { ...value, createdAt: timestamp, updatedAt: timestamp };
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    username: String(row.username),
    role: row.role as User["role"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    rootPath: row.root_path,
    sharedHomePath: row.shared_home_path,
    sdkSessionStoragePath: row.sdk_session_storage_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    title: row.title,
    sdkSessionId: row.sdk_session_id ?? undefined,
    sdkSessionStoragePath: row.sdk_session_storage_path,
    currentModel: row.current_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    status: row.status,
    model: row.model,
    input: JSON.parse(row.input_json) as Run["input"],
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
    costUsd: row.cost_usd ?? undefined,
    numTurns: row.num_turns ?? undefined,
    stopReason: row.stop_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    role: row.role as StoredMessage["role"],
    content: nullableString(row.content),
    toolUseId: nullableString(row.tool_use_id),
    toolName: nullableString(row.tool_name),
    toolInput: row.tool_input_json ? JSON.parse(String(row.tool_input_json)) : undefined,
    toolResult: row.tool_result_json ? JSON.parse(String(row.tool_result_json)) : undefined,
    toolStatus: (nullableString(row.tool_status) as StoredMessage["toolStatus"]) ?? undefined,
    attachments: row.attachments_json
      ? (JSON.parse(String(row.attachments_json)) as StoredMessageAttachment[])
      : undefined,
    sequence: Number(row.sequence),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function extractToolUse(event: unknown): { id: string; name: string; input?: unknown } | undefined {
  const message = event as { message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: unknown }> } };
  const toolUse = message.message?.content?.find((block) => block.type === "tool_use");
  if (!toolUse?.id || !toolUse.name) return undefined;
  return { id: toolUse.id, name: toolUse.name, input: toolUse.input };
}

function extractToolResult(event: unknown): { toolUseId: string; result: unknown } | undefined {
  const message = event as {
    message?: { content?: Array<{ type?: string; tool_use_id?: string; content?: unknown }> };
    tool_use_result?: unknown;
  };
  const toolResult = message.message?.content?.find((block) => block.type === "tool_result");
  if (!toolResult?.tool_use_id) return undefined;
  return { toolUseId: toolResult.tool_use_id, result: message.tool_use_result ?? toolResult.content };
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function extractUsage(event: unknown): { inputTokens?: number; outputTokens?: number; costUsd?: number } {
  if (!event || typeof event !== "object") return {};
  const candidate = event as {
    total_cost_usd?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cost?: unknown;
      cost_details?: { upstream_inference_cost?: unknown };
    };
    event?: {
      usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        cost?: unknown;
        cost_details?: { upstream_inference_cost?: unknown };
      };
      message?: {
        usage?: {
          input_tokens?: unknown;
          output_tokens?: unknown;
          cost?: unknown;
          cost_details?: { upstream_inference_cost?: unknown };
        };
      };
    };
    message?: {
      usage?: {
        input_tokens?: unknown;
        output_tokens?: unknown;
        cost?: unknown;
        cost_details?: { upstream_inference_cost?: unknown };
      };
    };
  };
  const usage = candidate.usage ?? candidate.event?.usage ?? candidate.event?.message?.usage ?? candidate.message?.usage;
  return {
    inputTokens: numberOrUndefined(usage?.input_tokens),
    outputTokens: numberOrUndefined(usage?.output_tokens),
    costUsd:
      numberOrUndefined(candidate.total_cost_usd) ??
      numberOrUndefined(usage?.cost) ??
      numberOrUndefined(usage?.cost_details?.upstream_inference_cost)
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
