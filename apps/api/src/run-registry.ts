import { watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AgentRuntime, RunningAgentQuery } from "@openclaude/agent-runtime";
import type { AgentStreamEnvelope, ClientControlMessage, Run, RunInput, Session, WorkspaceChangedMessage } from "@openclaude/shared";
import { LocalWorkspaceManager } from "@openclaude/sandbox";
import { config } from "./config.js";
import { authenticateToken } from "./auth.js";
import type { FileStore } from "./store.js";

type Subscriber = {
  socket: WebSocket;
  runId: string;
};

type WorkspaceSubscriber = {
  socket: WebSocket;
  userId: string;
};

type WorkspaceWatcher = {
  watchers: FSWatcher[];
  refreshTimer?: ReturnType<typeof setTimeout>;
  broadcastTimer?: ReturnType<typeof setTimeout>;
};

const terminalStatuses = new Set<Run["status"]>([
  "completed",
  "failed",
  "stopped",
  "interrupted_by_restart"
]);

export class RunRegistry {
  private readonly running = new Map<string, RunningAgentQuery>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly persistQueues = new Map<string, Promise<void>>();
  private readonly latestSequences = new Map<string, number>();
  private readonly workspaceManager = new LocalWorkspaceManager(config.dataDir);
  private readonly workspaceSubscribers = new Set<WorkspaceSubscriber>();
  private readonly workspaceWatchers = new Map<string, WorkspaceWatcher>();

  constructor(
    private readonly store: FileStore,
    private readonly runtime: AgentRuntime
  ) {}

  attach(server: Server) {
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (socket, request) => {
      const url = new URL(request.url ?? "", `http://${request.headers.host}`);
      const user = authenticateToken(this.store, url.searchParams.get("token") ?? undefined);
      if (!user) {
        socket.close(1008, "Unauthorized");
        return;
      }

      socket.on("message", async (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as ClientControlMessage;
          if (message.type === "subscribe_run") {
            const run = this.store.getRun(message.runId);
            if (!run || run.userId !== user.id) {
              socket.send(JSON.stringify({ type: "error", error: "Run not found" }));
              return;
            }
            this.subscribers.add({ socket, runId: message.runId });
            for (const event of this.store.getEvents(message.runId, message.afterSequence ?? 0)) {
              socket.send(JSON.stringify(event));
            }
            return;
          }
          if (message.type === "subscribe_workspace") {
            this.workspaceSubscribers.add({ socket, userId: user.id });
            await this.ensureWorkspaceWatcher(user.id);
            return;
          }
          if (message.type === "stop_run") {
            await this.stopRun(message.runId, user.id);
          }
        } catch (error) {
          socket.send(JSON.stringify({ type: "error", error: String(error) }));
        }
      });

      socket.on("close", () => {
        for (const subscriber of [...this.subscribers]) {
          if (subscriber.socket === socket) this.subscribers.delete(subscriber);
        }
        for (const subscriber of [...this.workspaceSubscribers]) {
          if (subscriber.socket === socket) this.workspaceSubscribers.delete(subscriber);
        }
      });
    });
  }

  async startRun(session: Session, run: Run, input: RunInput) {
    if (this.store.countRunningRuns(run.userId) >= config.perUserConcurrentRuns) {
      await this.store.updateRun(run.id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: "Per-user concurrent run limit reached"
      });
      return;
    }

    const workspace = this.store.getWorkspace(session.workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${session.workspaceId}`);
    const layout = await this.workspaceManager.ensureWorkspace(workspace);
    const eventsPath = path.join(config.dataDir, "run-events", `${run.id}.jsonl`);
    await mkdir(path.dirname(eventsPath), { recursive: true });

    await this.store.updateRun(run.id, { status: "running", startedAt: new Date().toISOString() });

    const query = this.runtime.start({
      runId: run.id,
      prompt: input.prompt,
      attachments: input.attachments,
      modelId: run.model,
      workspaceRoot: layout.workspaceRoot,
      sharedHomePath: layout.sharedHomePath,
      sdkSessionStoragePath: layout.sdkSessionStoragePath,
      resumeSessionId: session.sdkSessionId,
      onSession: async (sdkSessionId) => {
        await this.store.updateSession(session.id, {
          sdkSessionId,
          sdkSessionStoragePath: layout.sdkSessionStoragePath
        });
      },
      onEvent: async (event) => {
        await this.recordEvent(event, eventsPath);
      }
    });

    this.running.set(run.id, query);

    void query.done
      .then(async (result) => {
        const latest = this.store.getRun(run.id);
        if (!latest || terminalStatuses.has(latest.status)) return;
        await this.store.updateRun(run.id, {
          status: "completed",
          finishedAt: new Date().toISOString(),
          costUsd: result.costUsd,
          numTurns: result.numTurns,
          stopReason: result.stopReason
        });
      })
      .catch(async (error) => {
        const latest = this.store.getRun(run.id);
        if (!latest || terminalStatuses.has(latest.status)) return;
        await this.store.updateRun(run.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => {
        this.running.delete(run.id);
        this.latestSequences.delete(run.id);
      });
  }

  async stopRun(runId: string, userId: string) {
    const run = this.store.getRun(runId);
    if (!run || run.userId !== userId) throw new Error("Run not found");
    const query = this.running.get(runId);
    query?.close();
    await this.store.updateRun(runId, {
      status: "stopped",
      finishedAt: new Date().toISOString(),
      stopReason: "user_stop"
    });
    const lastEvent = this.store.getEvents(runId).at(-1);
    const latestSequence = this.latestSequences.get(runId) ?? lastEvent?.sequence ?? 0;
    await this.recordEvent(
      {
        version: 1,
        runId,
        sequence: latestSequence + 1,
        timestamp: new Date().toISOString(),
        provider: "openrouter",
        sdkEvent: { type: "result", subtype: "stopped", stop_reason: "user_stop" },
        uiHints: { kind: "result" }
      },
      path.join(config.dataDir, "run-events", `${runId}.jsonl`)
    );
  }

  private async recordEvent(event: AgentStreamEnvelope, eventsPath: string) {
    this.latestSequences.set(event.runId, Math.max(this.latestSequences.get(event.runId) ?? 0, event.sequence));
    this.broadcastEvent(event);
    this.enqueuePersist(event, eventsPath);
  }

  private broadcastEvent(event: AgentStreamEnvelope) {
    const payload = JSON.stringify(event);
    for (const subscriber of this.subscribers) {
      if (subscriber.runId === event.runId && subscriber.socket.readyState === subscriber.socket.OPEN) {
        subscriber.socket.send(payload);
      }
    }
  }

  private enqueuePersist(event: AgentStreamEnvelope, eventsPath: string) {
    const previous = this.persistQueues.get(event.runId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await this.persistEvent(event, eventsPath);
      });
    this.persistQueues.set(event.runId, next);
    void next
      .catch((error) => {
        console.error("Failed to persist run event", error);
      })
      .finally(() => {
        if (this.persistQueues.get(event.runId) === next) {
          this.persistQueues.delete(event.runId);
        }
      });
  }

  private async persistEvent(event: AgentStreamEnvelope, eventsPath: string) {
    await this.store.appendEvent(event);
    await writeFile(eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  }

  private async ensureWorkspaceWatcher(userId: string) {
    if (this.workspaceWatchers.has(userId)) return;
    const layout = await this.workspaceManager.ensureGlobalWorkspace(userId);
    const watcher: WorkspaceWatcher = { watchers: [] };
    this.workspaceWatchers.set(userId, watcher);
    await this.rebuildWorkspaceWatcher(userId, layout.workspaceRoot);
  }

  private async rebuildWorkspaceWatcher(userId: string, workspaceRoot: string) {
    const current = this.workspaceWatchers.get(userId);
    if (!current) return;
    for (const watcher of current.watchers) watcher.close();
    current.watchers = [];

    const directories = await listDirectories(workspaceRoot);
    for (const directory of directories) {
      try {
        const watcher = watch(directory, { persistent: false }, () => {
          this.scheduleWorkspaceBroadcast(userId);
          this.scheduleWorkspaceWatcherRefresh(userId, workspaceRoot);
        });
        current.watchers.push(watcher);
      } catch (error) {
        console.warn("Failed to watch workspace directory", directory, error);
      }
    }
  }

  private scheduleWorkspaceBroadcast(userId: string) {
    const watcher = this.workspaceWatchers.get(userId);
    if (!watcher || watcher.broadcastTimer) return;
    watcher.broadcastTimer = setTimeout(() => {
      watcher.broadcastTimer = undefined;
      this.broadcastWorkspaceChanged(userId);
    }, 250);
  }

  private scheduleWorkspaceWatcherRefresh(userId: string, workspaceRoot: string) {
    const watcher = this.workspaceWatchers.get(userId);
    if (!watcher || watcher.refreshTimer) return;
    watcher.refreshTimer = setTimeout(() => {
      watcher.refreshTimer = undefined;
      void this.rebuildWorkspaceWatcher(userId, workspaceRoot).catch((error) => {
        console.warn("Failed to refresh workspace watchers", error);
      });
    }, 1000);
  }

  private broadcastWorkspaceChanged(userId: string) {
    const payload: WorkspaceChangedMessage = { type: "workspace_changed", timestamp: new Date().toISOString() };
    const encoded = JSON.stringify(payload);
    for (const subscriber of this.workspaceSubscribers) {
      if (subscriber.userId === userId && subscriber.socket.readyState === subscriber.socket.OPEN) {
        subscriber.socket.send(encoded);
      }
    }
  }
}

async function listDirectories(root: string): Promise<string[]> {
  const directories = [root];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".DS_Store") continue;
    directories.push(...(await listDirectories(path.join(root, entry.name))));
  }
  return directories;
}
