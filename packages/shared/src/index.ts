import { z } from "zod";

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "stopped",
  "interrupted_by_restart"
]);

export type RunStatus = z.infer<typeof runStatusSchema>;

export const modelIdSchema = z.string().min(1);

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export type UserRole = "admin" | "member";

export type User = {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
};

export type Workspace = {
  id: string;
  userId: string;
  name: string;
  rootPath: string;
  sharedHomePath: string;
  sdkSessionStoragePath: string;
  createdAt: string;
  updatedAt: string;
};

export type Session = {
  id: string;
  userId: string;
  workspaceId: string;
  title: string;
  sdkSessionId?: string;
  sdkSessionStoragePath: string;
  currentModel: string;
  createdAt: string;
  updatedAt: string;
};

export type Run = {
  id: string;
  sessionId: string;
  userId: string;
  workspaceId: string;
  status: RunStatus;
  model: string;
  input: RunInput;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  costUsd?: number;
  numTurns?: number;
  stopReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type RunInput = {
  prompt: string;
  attachments?: Array<{
    workspaceFilePath: string;
    mimeType?: string;
    sizeBytes?: number;
    kind?: "image" | "file";
  }>;
};

export type UiHintKind = "text" | "tool" | "result" | "error" | "status";

export type AgentStreamEnvelope = {
  version: 1;
  runId: string;
  sequence: number;
  timestamp: string;
  provider: "openrouter" | "anthropic" | "mock";
  sdkEvent: unknown;
  uiHints?: {
    kind?: UiHintKind;
    textDelta?: string;
    isPartial?: boolean;
  };
};

export type ClientControlMessage =
  | { type: "subscribe_run"; runId: string; afterSequence?: number }
  | { type: "stop_run"; runId: string }
  | { type: "ack"; runId: string; sequence: number };

export const createSessionRequestSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  workspaceName: z.string().min(1).max(80).optional(),
  model: modelIdSchema.optional()
});

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const createRunRequestSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  model: modelIdSchema.optional(),
  attachmentIds: z.array(z.string().min(1)).max(8).optional()
});

export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

export type AuthResponse = {
  token: string;
  user: User;
};

export type SessionWithWorkspace = Session & {
  workspace: Workspace;
};

export type RunSnapshot = Run & {
  events: AgentStreamEnvelope[];
};

export function extractTextDeltaFromSdkEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const streamCandidate = event as {
    type?: string;
    event?: {
      type?: string;
      delta?: { type?: string; text?: string };
    };
  };
  if (
    streamCandidate.type === "stream_event" &&
    streamCandidate.event?.type === "content_block_delta" &&
    streamCandidate.event.delta?.type === "text_delta" &&
    typeof streamCandidate.event.delta.text === "string"
  ) {
    return streamCandidate.event.delta.text;
  }

  const candidate = event as {
    type?: string;
    message?: { content?: Array<{ type?: string; text?: string }> };
  };
  if (candidate.type !== "assistant" || !Array.isArray(candidate.message?.content)) {
    return undefined;
  }
  const text = candidate.message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  return text.length > 0 ? text : undefined;
}

export function inferUiHint(event: unknown): AgentStreamEnvelope["uiHints"] {
  if (!event || typeof event !== "object") return { kind: "status" };
  const message = event as { type?: string; message?: { content?: Array<{ type?: string }> } };
  if (message.type === "stream_event") {
    const textDelta = extractTextDeltaFromSdkEvent(event);
    if (textDelta) return { kind: "text", textDelta, isPartial: true };
    return { kind: "status" };
  }
  if (message.type === "result") return { kind: "result" };
  if (message.type === "assistant") {
    const textDelta = extractTextDeltaFromSdkEvent(event);
    if (textDelta) return { kind: "text", textDelta };
    const hasTool = message.message?.content?.some((block) => block.type === "tool_use");
    if (hasTool) return { kind: "tool" };
  }
  return { kind: "status" };
}
