import type {
  AuthResponse,
  CreateRunRequest,
  Run,
  RunSnapshot,
  SessionWithWorkspace,
  WorkspaceFileContentResponse,
  WorkspaceFileNode,
  WorkspaceFilesResponse,
  WorkspaceUploadResponse
} from "@openclaude/shared";

export type ModelOption = {
  id: string;
  label: string;
  group: string;
  supportsMultimodal: boolean;
  supportsTools: boolean;
  supportsEffort: boolean;
};

export type StoredHistoryAttachment = {
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type StoredHistoryMessage = {
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
  attachments?: StoredHistoryAttachment[];
  sequence: number;
  createdAt: string;
  updatedAt: string;
};

export type StoredRunMeta = {
  runId: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  raw?: string;
};

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export async function login(username: string, password: string): Promise<AuthResponse> {
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password })
  });
}

export async function getSessions(token: string): Promise<{ sessions: SessionWithWorkspace[] }> {
  return request("/api/sessions", { token });
}

export async function getModels(): Promise<{
  models: ModelOption[];
  effortLevels: string[];
  defaultModelId: string;
}> {
  return request("/api/models");
}

export async function createSession(token: string, model?: string): Promise<{ session: SessionWithWorkspace }> {
  return request("/api/sessions", {
    token,
    method: "POST",
    body: JSON.stringify({ title: "New chat", model })
  });
}

export async function getSessionHistory(
  token: string,
  sessionId: string
): Promise<{
  session: SessionWithWorkspace;
  messages?: StoredHistoryMessage[];
  runMeta?: StoredRunMeta[];
  runs?: RunSnapshot[];
}> {
  return request(`/api/sessions/${sessionId}/history`, { token });
}

export async function createRun(token: string, body: CreateRunRequest): Promise<{ run: Run }> {
  return request("/api/runs", {
    token,
    method: "POST",
    body: JSON.stringify(body)
  });
}

export type UploadedAttachment = {
  id: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
};

export async function uploadAttachments(
  token: string,
  files: File[]
): Promise<{ uploads: UploadedAttachment[] }> {
  const formData = new FormData();
  for (const file of files) formData.append("files", file, file.name);
  const response = await fetch(`${API_BASE_URL}/api/uploads`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: formData
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || response.statusText);
  }
  return response.json() as Promise<{ uploads: UploadedAttachment[] }>;
}

export async function deleteSession(token: string, sessionId: string): Promise<{ ok: true }> {
  return request(`/api/sessions/${sessionId}`, {
    token,
    method: "DELETE"
  });
}

export async function listWorkspaceFiles(token: string, path = ""): Promise<WorkspaceFilesResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return request(`/api/workspace/files${query}`, { token });
}

export async function getWorkspaceFileContent(
  token: string,
  path: string
): Promise<WorkspaceFileContentResponse> {
  return request(`/api/workspace/files/content?path=${encodeURIComponent(path)}`, { token });
}

export async function createWorkspaceFolder(token: string, path: string): Promise<{ ok: true }> {
  return request("/api/workspace/folders", {
    token,
    method: "POST",
    body: JSON.stringify({ path })
  });
}

export async function deleteWorkspacePath(token: string, path: string): Promise<{ ok: true }> {
  return request(`/api/workspace/files?path=${encodeURIComponent(path)}`, {
    token,
    method: "DELETE"
  });
}

export async function uploadWorkspaceFiles(
  token: string,
  files: Array<{ file: File; path?: string }>,
  targetPath = ""
): Promise<WorkspaceUploadResponse> {
  const formData = new FormData();
  formData.set("targetPath", targetPath);
  formData.set("paths", JSON.stringify(files.map((item) => item.path ?? item.file.name)));
  for (const item of files) formData.append("files", item.file, item.file.name);
  const response = await fetch(`${API_BASE_URL}/api/workspace/files/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: formData
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || response.statusText);
  }
  return response.json() as Promise<WorkspaceUploadResponse>;
}

export function workspaceRawUrl(path: string, token: string): string {
  return `${API_BASE_URL}/api/workspace/files/raw?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`;
}

export type { WorkspaceFileContentResponse, WorkspaceFileNode };

async function request<T>(path: string, options: RequestInit & { token?: string } = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || response.statusText);
  }
  return response.json() as Promise<T>;
}
