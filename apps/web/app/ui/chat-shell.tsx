"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentStreamEnvelope, RunSnapshot, SessionWithWorkspace } from "@openclaude/shared";
import {
  createRun,
  createSession,
  deleteSession,
  getModels,
  getSessionHistory,
  getSessions,
  login,
  type ModelOption,
  type StoredHistoryMessage,
  type StoredRunMeta
} from "./api";

type TextMessage = {
  id: string;
  role: "user" | "assistant" | "status";
  content: string;
  runId?: string;
  images?: Array<{ dataUrl: string; name: string }>;
};

type ToolMessage = {
  id: string;
  role: "tool";
  toolUseId: string;
  name: string;
  input?: unknown;
  result?: unknown;
  status: "running" | "done" | "stopped";
  runId?: string;
};

type ChatMessage = TextMessage | ToolMessage;

type EffortLevel = "low" | "medium" | "high";

type AskQuestionOption = {
  label: string;
  description?: string;
};

type AskQuestion = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
};

type PendingAskUserQuestion = {
  toolUseId: string;
  questions: AskQuestion[];
};

type ConversationCache = {
  version: 1;
  messages: ChatMessage[];
  runMetaById: Record<string, StoredRunMeta>;
  selectedModel: string;
  cachedAt: number;
};

type PendingImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  base64: string;
};

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function getWsBaseUrl() {
  if (process.env.NEXT_PUBLIC_WS_BASE_URL) return process.env.NEXT_PUBLIC_WS_BASE_URL;
  if (typeof window === "undefined") return "ws://localhost:4000/ws";
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export function ChatShell() {
  const [token, setToken] = useState<string | undefined>();
  const [authInitialized, setAuthInitialized] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [sessions, setSessions] = useState<SessionWithWorkspace[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("claude-sonnet-4.6");
  const [effortByModel, setEffortByModel] = useState<Record<string, EffortLevel>>({});
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [runMetaById, setRunMetaById] = useState<Record<string, StoredRunMeta>>({});
  const [openRawRunId, setOpenRawRunId] = useState<string | undefined>();
  const [pendingAsk, setPendingAsk] = useState<PendingAskUserQuestion | undefined>();
  const [askSelections, setAskSelections] = useState<Record<number, string[]>>({});
  const [askCustomAnswer, setAskCustomAnswer] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const chatLogRef = useRef<HTMLElement | null>(null);
  const stickToBottomRef = useRef(true);
  const streamedRunIds = useRef(new Set<string>());
  const textQueues = useRef(new Map<string, string>());
  const textTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const conversationCache = useRef(new Map<string, ConversationCache>());

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions]
  );

  useEffect(() => {
    const saved = window.localStorage.getItem("openclaude.token");
    if (saved) setToken(saved);
    setAuthInitialized(true);
    void getModels()
      .then((result) => {
        setModels(result.models);
        setSelectedModel(result.defaultModelId);
      })
      .catch((err) => setError(String(err)));
  }, []);

  useEffect(() => {
    return () => {
      clearTextQueues();
    };
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!token) return;
    const result = await getSessions(token);
    setSessions(result.sessions);
  }, [token]);

  useEffect(() => {
    void refreshSessions().catch((err) => setError(String(err)));
  }, [refreshSessions]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, activeRunId]);

  function handleChatScroll(event: React.UIEvent<HTMLElement>) {
    const el = event.currentTarget;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < 80;
  }

  useEffect(() => {
    if (!activeSessionId || messages.length === 0) return;
    saveConversationCache(activeSessionId, {
      version: 1,
      messages,
      runMetaById,
      selectedModel,
      cachedAt: Date.now()
    });
  }, [activeSessionId, messages, runMetaById, selectedModel]);

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      const result = await login(username, password);
      window.localStorage.setItem("openclaude.token", result.token);
      setToken(result.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function clearPendingAsk() {
    setPendingAsk(undefined);
    setAskSelections({});
    setAskCustomAnswer("");
  }

  function clearTextQueues() {
    for (const timer of textTimers.current.values()) {
      clearTimeout(timer);
    }
    textTimers.current.clear();
    textQueues.current.clear();
  }

  async function ingestFiles(files: FileList | File[]) {
    const list = Array.from(files);
    const accepted: PendingImage[] = [];
    for (const file of list) {
      if (!SUPPORTED_IMAGE_MIME_TYPES.has(file.type)) {
        setError(`不支持的图片类型: ${file.type || file.name}`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError(`图片过大: ${file.name}（最大 10MB）`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = dataUrl.split(",", 2)[1] ?? "";
        accepted.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          mimeType: file.type,
          dataUrl,
          base64
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    if (accepted.length > 0) {
      setPendingImages((current) => [...current, ...accepted].slice(0, 8));
    }
  }

  function removePendingImage(id: string) {
    setPendingImages((current) => current.filter((image) => image.id !== id));
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && SUPPORTED_IMAGE_MIME_TYPES.has(file.type)) files.push(file);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      void ingestFiles(files);
    }
  }

  function handleComposerDrop(event: React.DragEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsDragging(false);
    if (event.dataTransfer?.files?.length) {
      void ingestFiles(event.dataTransfer.files);
    }
  }

  function handleComposerDragOver(event: React.DragEvent<HTMLFormElement>) {
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
      setIsDragging(true);
    }
  }

  function handleComposerDragLeave(event: React.DragEvent<HTMLFormElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return;
    setIsDragging(false);
  }

  function readConversationCache(sessionId: string): ConversationCache | undefined {
    const memoryCache = conversationCache.current.get(sessionId);
    if (memoryCache) return memoryCache;
    try {
      const raw = window.sessionStorage.getItem(historyCacheKey(sessionId));
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as ConversationCache;
      if (parsed.version !== 1 || !Array.isArray(parsed.messages)) return undefined;
      conversationCache.current.set(sessionId, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  function saveConversationCache(sessionId: string, cache: ConversationCache) {
    conversationCache.current.set(sessionId, cache);
    try {
      window.sessionStorage.setItem(historyCacheKey(sessionId), JSON.stringify(cache));
    } catch {
      // Session storage can be full; in-memory cache still avoids refetches during this tab.
    }
  }

  function removeConversationCache(sessionId: string) {
    conversationCache.current.delete(sessionId);
    try {
      window.sessionStorage.removeItem(historyCacheKey(sessionId));
    } catch {
      // Ignore storage cleanup failures.
    }
  }

  function clearAllConversationCaches() {
    conversationCache.current.clear();
    try {
      for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = window.sessionStorage.key(index);
        if (key?.startsWith("openclaude.history.")) {
          window.sessionStorage.removeItem(key);
        }
      }
    } catch {
      // Ignore storage cleanup failures.
    }
  }

  function handleLogout() {
    window.localStorage.removeItem("openclaude.token");
    clearAllConversationCaches();
    setToken(undefined);
    setActiveSessionId(undefined);
    setMessages([]);
    setRunMetaById({});
    setOpenRawRunId(undefined);
    setPendingImages([]);
    clearPendingAsk();
    clearTextQueues();
    wsRef.current?.close();
  }

  async function handleDeleteSession(sessionId: string) {
    if (!token) return;
    try {
      await deleteSession(token, sessionId);
      const remaining = sessions.filter((candidate) => candidate.id !== sessionId);
      removeConversationCache(sessionId);
      setSessions(remaining);
      if (activeSessionId === sessionId) {
        setActiveSessionId(undefined);
        setMessages([]);
        setRunMetaById({});
        setOpenRawRunId(undefined);
        clearPendingAsk();
        clearTextQueues();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCreateSession() {
    setActiveSessionId(undefined);
    setMessages([]);
    setRunMetaById({});
    setOpenRawRunId(undefined);
    setPendingImages([]);
    setError(undefined);
    clearPendingAsk();
    clearTextQueues();
  }

  async function handleSelectSession(sessionId: string) {
    if (!token) return;
    if (activeSessionId && messages.length > 0) {
      saveConversationCache(activeSessionId, {
        version: 1,
        messages,
        runMetaById,
        selectedModel,
        cachedAt: Date.now()
      });
    }
    const session = sessions.find((candidate) => candidate.id === sessionId);
    setActiveSessionId(sessionId);
    setSelectedModel(session?.currentModel ?? selectedModel);
    setMessages([]);
    setIsSidebarOpen(false);
    setError(undefined);
    setRunMetaById({});
    setOpenRawRunId(undefined);
    clearPendingAsk();
    clearTextQueues();
    stickToBottomRef.current = true;
    const cached = readConversationCache(sessionId);
    if (cached) {
      setSelectedModel(cached.selectedModel);
      setMessages(cached.messages);
      setRunMetaById(cached.runMetaById);
      return;
    }
    try {
      const history = await getSessionHistory(token, sessionId);
      setSelectedModel(history.session.currentModel);
      const nextMessages = history.messages ? buildMessagesFromHistory(history.messages) : buildMessagesFromRuns(history.runs ?? []);
      const nextRunMeta = Object.fromEntries((history.runMeta ?? []).map((meta) => [meta.runId, meta]));
      setMessages(nextMessages);
      setRunMetaById(nextRunMeta);
      saveConversationCache(sessionId, {
        version: 1,
        messages: nextMessages,
        runMetaById: nextRunMeta,
        selectedModel: history.session.currentModel,
        cachedAt: Date.now()
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    await submitPrompt();
  }

  async function submitPrompt(overridePrompt?: string, displayContent?: string) {
    const rawPrompt = overridePrompt ?? prompt;
    const isAskAnswer = Boolean(overridePrompt);
    const imagesForRun = isAskAnswer ? [] : pendingImages;
    if (!token) return;
    if (!rawPrompt.trim() && imagesForRun.length === 0) return;
    setError(undefined);
    stickToBottomRef.current = true;
    const nextPrompt = rawPrompt.trim() || (imagesForRun.length > 0 ? "(image input)" : "");
    if (!overridePrompt) {
      setPrompt("");
      setPendingImages([]);
    }

    try {
      let session = activeSession;
      if (!session) {
        const created = await createSession(token, selectedModel);
        session = created.session;
        setSessions((current) => [created.session, ...current]);
        setActiveSessionId(created.session.id);
      }
      const userMessageId = crypto.randomUUID();
      const userImages = imagesForRun.map((image) => ({ dataUrl: image.dataUrl, name: image.name }));
      setMessages((current) => [
        ...current,
        {
          id: userMessageId,
          role: "user",
          content: displayContent ?? nextPrompt,
          images: userImages.length > 0 ? userImages : undefined
        }
      ]);
      const response = await createRun(token, {
        sessionId: session.id,
        prompt: nextPrompt,
        model: selectedModel,
        images: imagesForRun.map((image) => ({
          name: image.name,
          mimeType: image.mimeType,
          base64: image.base64
        }))
      });
      const runId = response.run.id as string;
      setActiveRunId(runId);
      subscribeToRun(token, runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function subscribeToRun(nextToken: string, runId: string) {
    wsRef.current?.close();
    const socket = new WebSocket(`${getWsBaseUrl()}?token=${encodeURIComponent(nextToken)}`);
    wsRef.current = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "subscribe_run", runId }));
    });

    socket.addEventListener("message", (event) => {
      const envelope = JSON.parse(event.data as string) as AgentStreamEnvelope | { type: string; error?: string };
      if (!("version" in envelope)) {
        setError(envelope.error);
        return;
      }
      appendEnvelope(envelope);
    });

    socket.addEventListener("close", () => {
      setActiveRunId((current) => (current === runId ? undefined : current));
    });
  }

  function appendEnvelope(envelope: AgentStreamEnvelope) {
    const usage = extractRunUsage(envelope.sdkEvent);
    if (usage) {
      setRunMetaById((current) => ({
        ...current,
        [envelope.runId]: {
          ...current[envelope.runId],
          runId: envelope.runId,
          ...usage,
          totalTokens:
            usage.totalTokens ??
            (usage.inputTokens !== undefined || usage.outputTokens !== undefined
              ? (usage.inputTokens ?? current[envelope.runId]?.inputTokens ?? 0) +
                (usage.outputTokens ?? current[envelope.runId]?.outputTokens ?? 0)
              : current[envelope.runId]?.totalTokens)
        }
      }));
    }
    const toolUse = extractToolUse(envelope.sdkEvent);
    if (toolUse) {
      flushTextQueue(envelope.runId);
      const askInput = parseAskUserQuestionInput(toolUse.input);
      if (toolUse.name === "AskUserQuestion" && askInput) {
        setPendingAsk({ toolUseId: toolUse.id, questions: askInput.questions });
        setAskSelections({});
        setAskCustomAnswer("");
      }
      setMessages((current) => [
        ...current,
        {
          id: `tool-${toolUse.id}`,
          role: "tool",
          toolUseId: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
          runId: envelope.runId,
          status: "running"
        }
      ]);
      return;
    }

    const toolResult = extractToolResult(envelope.sdkEvent);
    if (toolResult) {
      setMessages((current) => {
        const index = current.findIndex(
          (message) => message.role === "tool" && message.toolUseId === toolResult.toolUseId
        );
        if (index === -1) {
          return [
            ...current,
            {
              id: `tool-${toolResult.toolUseId}`,
              role: "tool",
              toolUseId: toolResult.toolUseId,
              name: "Tool",
              result: toolResult.result,
              runId: envelope.runId,
              status: "done"
            }
          ];
        }
        return current.map((message, messageIndex) =>
          messageIndex === index && message.role === "tool"
            ? { ...message, result: toolResult.result, status: "done" }
            : message
        );
      });
      return;
    }

    if (envelope.uiHints?.kind === "text" && envelope.uiHints.textDelta) {
      if (envelope.uiHints.isPartial) {
        streamedRunIds.current.add(envelope.runId);
      } else if (streamedRunIds.current.has(envelope.runId)) {
        return;
      }

      queueAssistantText(envelope.runId, envelope.uiHints.textDelta);
      return;
    }

    if (envelope.uiHints?.kind === "result") {
      flushTextQueue(envelope.runId);
      if (isStoppedResult(envelope.sdkEvent)) {
        markRunningToolsStopped(envelope.runId);
      }
      setActiveRunId((current) => (current === envelope.runId ? undefined : current));
      void refreshSessions();
      return;
    }

    if (envelope.uiHints?.kind === "tool") return;
  }

  async function handleStopRun() {
    if (!activeRunId || !wsRef.current) return;
    const runId = activeRunId;
    flushTextQueue(runId);
    setActiveRunId(undefined);
    markRunningToolsStopped(runId);
    try {
      wsRef.current.send(JSON.stringify({ type: "stop_run", runId }));
      void refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function markRunningToolsStopped(runId: string) {
    setMessages((current) =>
      current.map((message) =>
        message.role === "tool" && message.runId === runId && message.status === "running"
          ? { ...message, status: "stopped", result: "Stopped by user" }
          : message
      )
    );
  }

  function queueAssistantText(runId: string, delta: string) {
    textQueues.current.set(runId, `${textQueues.current.get(runId) ?? ""}${delta}`);
    if (!textTimers.current.has(runId)) {
      pumpTextQueue(runId);
    }
  }

  function pumpTextQueue(runId: string) {
    const queued = textQueues.current.get(runId) ?? "";
    if (!queued) {
      textTimers.current.delete(runId);
      return;
    }
    const chunkSize = Math.min(4, Math.max(1, Math.ceil(queued.length / 30)));
    appendAssistantText(runId, queued.slice(0, chunkSize));
    textQueues.current.set(runId, queued.slice(chunkSize));
    const timer = setTimeout(() => pumpTextQueue(runId), 24);
    textTimers.current.set(runId, timer);
  }

  function flushTextQueue(runId: string) {
    const timer = textTimers.current.get(runId);
    if (timer) clearTimeout(timer);
    textTimers.current.delete(runId);
    const queued = textQueues.current.get(runId);
    textQueues.current.delete(runId);
    if (queued) appendAssistantText(runId, queued);
  }

  function appendAssistantText(runId: string, text: string) {
    setMessages((current) => {
      const latest = current[current.length - 1];
      if (latest?.role === "assistant") {
        return [...current.slice(0, -1), { ...latest, content: `${latest.content}${text}` }];
      }
      return [...current, { id: `assistant-${runId}`, role: "assistant", runId, content: text }];
    });
    setRunMetaById((current) => ({
      ...current,
      [runId]: {
        ...current[runId],
        runId,
        raw: `${current[runId]?.raw ?? ""}${text}`
      }
    }));
  }

  function toggleAskOption(questionIndex: number, optionLabel: string, multiSelect: boolean) {
    setAskSelections((current) => {
      const selected = current[questionIndex] ?? [];
      if (!multiSelect) return { ...current, [questionIndex]: [optionLabel] };
      return {
        ...current,
        [questionIndex]: selected.includes(optionLabel)
          ? selected.filter((label) => label !== optionLabel)
          : [...selected, optionLabel]
      };
    });
  }

  async function submitAskAnswer() {
    if (!pendingAsk) return;
    const answerPrompt = buildAskAnswerPrompt(pendingAsk, askSelections, askCustomAnswer);
    if (!answerPrompt) return;
    const visibleAnswer = buildVisibleAskAnswer(pendingAsk, askSelections, askCustomAnswer);
    clearPendingAsk();
    await submitPrompt(answerPrompt, visibleAnswer);
  }

  if (!authInitialized) {
    return <main className="boot-screen" aria-label="Loading OpenClaude" />;
  }

  if (!token) {
    return (
      <main className="login-screen">
        <section className="login-card">
          <div className="login-mark">OC</div>
          <h1>登录 OpenClaude</h1>
          <p>进入你的 Agent 工作区。</p>
          <form onSubmit={handleLogin}>
            <input className="input" value={username} onChange={(event) => setUsername(event.target.value)} />
            <input
              className="input"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error ? <p className="error-text">{error}</p> : null}
            <button className="primary-button" type="submit">
              继续
            </button>
          </form>
        </section>
      </main>
    );
  }

  return (
    <div className={`claude-shell ${isSidebarOpen ? "sidebar-open" : ""}`}>
      <button className="mobile-scrim" aria-label="关闭侧边栏" onClick={() => setIsSidebarOpen(false)} />
      <aside className="claude-sidebar">
        <div className="sidebar-header">
          <div className="wordmark">OpenClaude</div>
          <button className="icon-button mobile-only" aria-label="关闭侧边栏" onClick={() => setIsSidebarOpen(false)}>
            ×
          </button>
        </div>

        <button
          className="new-chat-button"
          onClick={() => {
            void handleCreateSession();
            setIsSidebarOpen(false);
          }}
        >
          <span>+</span>
          New chat
        </button>

        <div className="sidebar-section-title">Recent</div>
        <div className="session-list compact-scroll">
          {sessions.map((session) => (
            <div className={`session-item ${session.id === activeSessionId ? "active" : ""}`} key={session.id}>
              <button
                className="session-select"
                onClick={() => {
                  void handleSelectSession(session.id);
                }}
              >
                <span>{session.title}</span>
                <small>{session.workspace.name}</small>
              </button>
              <button
                className="session-delete"
                aria-label={`删除 ${session.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDeleteSession(session.id);
                }}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>

        <div className="sidebar-user">
          <div className="avatar">A</div>
          <div>
            <strong>{username}</strong>
            <small>Admin</small>
          </div>
          <button className="logout-button" onClick={handleLogout}>
            退出
          </button>
        </div>
      </aside>

      <main className="chat-main">
        <header className="chat-header">
          <div className="header-left">
            <button className="mobile-menu-button" aria-label="打开侧边栏" onClick={() => setIsSidebarOpen(true)}>
              ☰
            </button>
            <button className="conversation-title">{activeSession?.title ?? "New chat"}</button>
          </div>
        </header>

        <section
          className={`chat-log compact-scroll ${messages.length === 0 ? "empty" : ""}`}
          ref={chatLogRef}
          onScroll={handleChatScroll}
        >
          {messages.length === 0 ? (
            <div className="hero">
              <h1>今天想探索什么？</h1>
            </div>
          ) : (
            <div className="message-stack">
              {messages.map((message) => (
                <article
                  className={`message ${message.role} ${
                    message.role === "assistant" && activeRunId && message.id === `assistant-${activeRunId}`
                      ? "streaming"
                      : ""
                  }`}
                  key={message.id}
                >
                  {message.role === "assistant" || message.role === "tool" ? (
                    <div className="assistant-avatar">OC</div>
                  ) : null}
                  <div className="message-body">
                    {message.role === "tool" ? <ToolCallCard message={message} /> : null}
                    {message.role === "assistant" && message.runId && openRawRunId === message.runId ? (
                      <RawMarkdownCard content={runMetaById[message.runId]?.raw ?? message.content} />
                    ) : null}
                    {message.role === "assistant" && (!message.runId || openRawRunId !== message.runId) ? (
                      <MarkdownContent content={message.content} />
                    ) : null}
                    {message.role === "user" && message.images?.length ? (
                      <div className="user-images">
                        {message.images.map((image, index) => (
                          <img
                            key={`${message.id}-img-${index}`}
                            src={image.dataUrl}
                            alt={image.name}
                          />
                        ))}
                      </div>
                    ) : null}
                    {message.role === "user" || message.role === "status" ? message.content : null}
                    {message.role === "assistant" && activeRunId && message.id === `assistant-${activeRunId}` ? (
                      <span className="typing-cursor" />
                    ) : null}
                    {message.role === "assistant" && message.runId ? (
                      <AssistantMetaBar
                        meta={runMetaById[message.runId]}
                        isRawOpen={openRawRunId === message.runId}
                        onShowView={() => setOpenRawRunId(undefined)}
                        onShowRaw={() => setOpenRawRunId(message.runId)}
                      />
                    ) : null}
                  </div>
                </article>
              ))}
              {activeRunId ? (
                <div className="message assistant thinking-message">
                  <div className="assistant-avatar">OC</div>
                  <div className="message-body">
                    <span className="thinking-dots" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                    OpenClaude 正在思考
                  </div>
                </div>
              ) : null}
              {error ? <div className="inline-error">{error}</div> : null}
              <div ref={chatEndRef} />
            </div>
          )}
        </section>

        <div className="composer-wrap">
          {pendingAsk ? (
            <AskUserQuestionComposer
              pendingAsk={pendingAsk}
              selections={askSelections}
              customAnswer={askCustomAnswer}
              isSubmitting={Boolean(activeRunId)}
              onCustomAnswerChange={setAskCustomAnswer}
              onSubmit={() => {
                void submitAskAnswer();
              }}
              onToggleOption={toggleAskOption}
            />
          ) : (
            <form
              className={`composer ${isDragging ? "dragging" : ""}`}
              onSubmit={handleSubmit}
              onDrop={handleComposerDrop}
              onDragOver={handleComposerDragOver}
              onDragLeave={handleComposerDragLeave}
            >
              {pendingImages.length > 0 ? (
                <div className="composer-attachments">
                  {pendingImages.map((image) => (
                    <div className="composer-attachment" key={image.id}>
                      <img src={image.dataUrl} alt={image.name} />
                      <button
                        type="button"
                        aria-label={`移除 ${image.name}`}
                        onClick={() => removePendingImage(image.id)}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                placeholder={
                  pendingImages.length > 0
                    ? "Describe the image..."
                    : "Write a message, drag images here, or paste a screenshot..."
                }
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onPaste={handleComposerPaste}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submitPrompt();
                  }
                }}
              />
              <input
                type="file"
                ref={fileInputRef}
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                style={{ display: "none" }}
                onChange={(event) => {
                  if (event.target.files) {
                    void ingestFiles(event.target.files);
                    event.target.value = "";
                  }
                }}
              />
              <div className="composer-footer">
                <button
                  className="round-button"
                  type="button"
                  aria-label="添加图片"
                  onClick={() => fileInputRef.current?.click()}
                >
                  +
                </button>
                <ModelPicker
                  models={models}
                  selectedModel={selectedModel}
                  effortByModel={effortByModel}
                  isOpen={isModelPickerOpen}
                  onToggle={() => setIsModelPickerOpen((open) => !open)}
                  onSelectModel={(id) => {
                    setSelectedModel(id);
                    setIsModelPickerOpen(false);
                  }}
                  onSetEffort={(modelId, effort) =>
                    setEffortByModel((current) => ({ ...current, [modelId]: effort }))
                  }
                />
                {activeRunId ? (
                  <button className="send-button stop-send-button" type="button" aria-label="停止生成" onClick={handleStopRun}>
                    ■
                  </button>
                ) : (
                  <button
                    className="send-button"
                    type="submit"
                    disabled={!prompt.trim() && pendingImages.length === 0}
                  >
                    ↑
                  </button>
                )}
              </div>
            </form>
          )}
          <div className="composer-note">OpenClaude 可能会出错。请核查重要信息。</div>
        </div>
      </main>
    </div>
  );
}

function ModelPicker({
  models,
  selectedModel,
  effortByModel,
  isOpen,
  onToggle,
  onSelectModel,
  onSetEffort
}: {
  models: ModelOption[];
  selectedModel: string;
  effortByModel: Record<string, EffortLevel>;
  isOpen: boolean;
  onToggle: () => void;
  onSelectModel: (id: string) => void;
  onSetEffort: (modelId: string, effort: EffortLevel) => void;
}) {
  const [editingEffortModelId, setEditingEffortModelId] = useState<string | undefined>();
  const current = models.find((model) => model.id === selectedModel);
  const currentEffort = effortByModel[selectedModel] ?? "medium";
  const effortLabel = currentEffort.charAt(0).toUpperCase() + currentEffort.slice(1);
  const groups = groupModels(models);

  useEffect(() => {
    if (!isOpen) setEditingEffortModelId(undefined);
  }, [isOpen]);

  return (
    <div className="model-picker-wrap">
      <button className="model-picker-trigger" type="button" onClick={onToggle}>
        <span className="model-picker-label">{current?.label ?? selectedModel}</span>
        {current?.supportsMultimodal ? <ImageIcon /> : null}
        {current?.supportsEffort ? <span className="effort-badge">{effortLabel}</span> : null}
        <span className="model-picker-chevron">{isOpen ? "▴" : "▾"}</span>
      </button>
      {isOpen ? (
        <div className="model-picker-popover">
          {groups.map(([groupName, items]) => (
            <div className="model-group" key={groupName}>
              <div className="model-group-title">{groupName}</div>
              {items.map((model) => {
                const modelEffort = effortByModel[model.id] ?? "medium";
                const isEditing = editingEffortModelId === model.id;
                return (
                  <div className="model-item-row" key={model.id}>
                    <button
                      className={`model-item ${model.id === selectedModel ? "active" : ""}`}
                      type="button"
                      onClick={() => onSelectModel(model.id)}
                    >
                      <span className="model-item-name">{model.label}</span>
                      <span className="model-item-badges">
                        {model.supportsMultimodal ? <ImageIcon /> : null}
                      </span>
                      {model.supportsEffort ? (
                        <button
                          className={`effort-edit-button ${isEditing ? "active" : ""}`}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditingEffortModelId(isEditing ? undefined : model.id);
                          }}
                        >
                          {modelEffort.charAt(0).toUpperCase() + modelEffort.slice(1)}
                        </button>
                      ) : null}
                      {model.id === selectedModel ? <span className="model-check">✓</span> : null}
                    </button>
                    {isEditing ? (
                      <EffortSlider
                        value={modelEffort}
                        onChange={(level) => onSetEffort(model.id, level)}
                        onClose={() => setEditingEffortModelId(undefined)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EffortSlider({
  value,
  onChange,
  onClose
}: {
  value: EffortLevel;
  onChange: (level: EffortLevel) => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const levels: EffortLevel[] = ["low", "medium", "high"];
  const sliderIndex = levels.indexOf(value);

  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", onDocumentClick);
    return () => document.removeEventListener("mousedown", onDocumentClick);
  }, [onClose]);

  return (
    <div className="effort-slider-popover" ref={containerRef}>
      <div className="effort-slider-title">Effort</div>
      <input
        className="effort-slider-input"
        type="range"
        min={0}
        max={2}
        step={1}
        value={sliderIndex}
        onChange={(event) => {
          const next = levels[Number(event.target.value)];
          if (next) onChange(next);
        }}
      />
      <div className="effort-slider-labels">
        {levels.map((level) => (
          <button
            className={`effort-slider-label ${value === level ? "active" : ""}`}
            key={level}
            type="button"
            onClick={() => onChange(level)}
          >
            {level.charAt(0).toUpperCase()}{level.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

function groupModels(models: ModelOption[]): Array<[string, ModelOption[]]> {
  const groupMap = new Map<string, ModelOption[]>();
  for (const model of models) {
    const name = model.group === "claude" ? "Claude" : model.group === "deepseek" ? "DeepSeek" : "Other";
    const list = groupMap.get(name) ?? [];
    list.push(model);
    groupMap.set(name, list);
  }
  return [...groupMap.entries()];
}

function ImageIcon() {
  return (
    <svg className="model-badge-icon" aria-label="Supports images" viewBox="0 0 20 20" width="14" height="14">
      <rect x="2" y="3" width="16" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="8" r="1.5" fill="currentColor" />
      <path d="M4 15l4-5 3 3.5 2-2 3 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15">
      <path
        d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-.7 11H7.7L7 9Zm3 2 .25 7h1.5L11.5 11H10Zm3.75 0-.25 7H15l.25-7h-1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function historyCacheKey(sessionId: string) {
  return `openclaude.history.${sessionId}`;
}

function AssistantMetaBar({
  meta,
  isRawOpen,
  onShowView,
  onShowRaw
}: {
  meta?: StoredRunMeta;
  isRawOpen: boolean;
  onShowView: () => void;
  onShowRaw: () => void;
}) {
  const tokenText = meta?.totalTokens !== undefined ? `${formatNumber(meta.totalTokens)} tokens` : "tokens -";
  const costText = meta?.costUsd !== undefined ? `$${meta.costUsd.toFixed(5)}` : "$-";
  return (
    <div className="assistant-meta">
      <div className="assistant-meta-line">
        <span>{tokenText}</span>
        <span>{costText}</span>
        <span className="view-raw-toggle">
          <button className={!isRawOpen ? "active" : ""} type="button" onClick={onShowView}>
            view
          </button>
          <button className={isRawOpen ? "active" : ""} type="button" onClick={onShowRaw}>
            raw
          </button>
        </span>
      </div>
    </div>
  );
}

function RawMarkdownCard({ content }: { content: string }) {
  return (
    <div className="raw-message-card">
      <pre>{content}</pre>
    </div>
  );
}

function AskUserQuestionComposer({
  pendingAsk,
  selections,
  customAnswer,
  isSubmitting,
  onCustomAnswerChange,
  onSubmit,
  onToggleOption
}: {
  pendingAsk: PendingAskUserQuestion;
  selections: Record<number, string[]>;
  customAnswer: string;
  isSubmitting: boolean;
  onCustomAnswerChange: (value: string) => void;
  onSubmit: () => void;
  onToggleOption: (questionIndex: number, optionLabel: string, multiSelect: boolean) => void;
}) {
  const canSubmit = Boolean(buildAskAnswerPrompt(pendingAsk, selections, customAnswer)) && !isSubmitting;
  return (
    <div className="ask-composer">
      <div className="ask-composer-header">
        <strong>OpenClaude 需要你的选择</strong>
        <span>也可以直接输入自定义回答</span>
      </div>
      <div className="ask-question-list">
        {pendingAsk.questions.map((question, questionIndex) => {
          const selected = selections[questionIndex] ?? [];
          return (
            <section className="ask-question" key={`${pendingAsk.toolUseId}-${questionIndex}`}>
              {question.header ? <div className="ask-question-header">{question.header}</div> : null}
              <div className="ask-question-title">{question.question}</div>
              <div className="ask-options">
                {question.options.map((option) => {
                  const isSelected = selected.includes(option.label);
                  return (
                    <button
                      className={`ask-option ${isSelected ? "selected" : ""}`}
                      key={option.label}
                      type="button"
                      onClick={() => onToggleOption(questionIndex, option.label, Boolean(question.multiSelect))}
                    >
                      <span className="ask-option-label">{option.label}</span>
                      {option.description ? <small>{option.description}</small> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      <textarea
        className="ask-custom-input"
        placeholder="自定义回答..."
        value={customAnswer}
        onChange={(event) => onCustomAnswerChange(event.target.value)}
      />
      <div className="ask-composer-footer">
        <button className="ask-submit-button" type="button" disabled={!canSubmit} onClick={onSubmit}>
          提交回答
        </button>
      </div>
    </div>
  );
}

function extractToolUse(event: unknown): { id: string; name: string; input?: unknown } | undefined {
  const message = event as { message?: { content?: Array<{ type?: string; name?: string }> } };
  const toolUse = message.message?.content?.find((block) => block.type === "tool_use") as
    | { id?: string; name?: string; input?: unknown }
    | undefined;
  if (!toolUse?.id || !toolUse.name) return undefined;
  return { id: toolUse.id, name: toolUse.name, input: toolUse.input };
}

function extractRunUsage(event: unknown): Partial<StoredRunMeta> | undefined {
  if (!event || typeof event !== "object") return undefined;
  const candidate = event as {
    total_cost_usd?: unknown;
    usage?: UsageShape;
    event?: { usage?: UsageShape; message?: { usage?: UsageShape } };
    message?: { usage?: UsageShape };
  };
  const usage = candidate.usage ?? candidate.event?.usage ?? candidate.event?.message?.usage ?? candidate.message?.usage;
  const inputTokens = numberOrUndefined(usage?.input_tokens);
  const outputTokens = numberOrUndefined(usage?.output_tokens);
  const costUsd =
    numberOrUndefined(candidate.total_cost_usd) ??
    numberOrUndefined(usage?.cost) ??
    numberOrUndefined(usage?.cost_details?.upstream_inference_cost);
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined,
    costUsd
  };
}

function isStoppedResult(event: unknown) {
  if (!event || typeof event !== "object") return false;
  const candidate = event as { type?: unknown; subtype?: unknown; stop_reason?: unknown };
  return candidate.type === "result" && (candidate.subtype === "stopped" || candidate.stop_reason === "user_stop");
}

type UsageShape = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cost?: unknown;
  cost_details?: { upstream_inference_cost?: unknown };
};

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function parseAskUserQuestionInput(input: unknown): { questions: AskQuestion[] } | undefined {
  if (!input || typeof input !== "object") return undefined;
  const candidate = input as {
    questions?: Array<{
      question?: unknown;
      header?: unknown;
      multiSelect?: unknown;
      options?: Array<{ label?: unknown; description?: unknown }>;
    }>;
  };
  const questions = candidate.questions
    ?.map((question): AskQuestion | undefined => {
      if (typeof question.question !== "string" || !Array.isArray(question.options)) return undefined;
      const options = question.options
        .map((option): AskQuestionOption | undefined => {
          if (typeof option.label !== "string") return undefined;
          return {
            label: option.label,
            description: typeof option.description === "string" ? option.description : undefined
          };
        })
        .filter((option): option is AskQuestionOption => Boolean(option));
      if (options.length === 0) return undefined;
      return {
        question: question.question,
        header: typeof question.header === "string" ? question.header : undefined,
        multiSelect: question.multiSelect === true,
        options
      };
    })
    .filter((question): question is AskQuestion => Boolean(question));
  return questions?.length ? { questions } : undefined;
}

function buildAskAnswerPrompt(
  pendingAsk: PendingAskUserQuestion,
  selections: Record<number, string[]>,
  customAnswer: string
) {
  const lines: string[] = ["用户对你刚才 AskUserQuestion 的回答如下："];
  let hasAnswer = false;
  pendingAsk.questions.forEach((question, index) => {
    const selected = selections[index] ?? [];
    const answer = selected.join("、");
    if (answer) hasAnswer = true;
    lines.push(`${index + 1}. ${question.question}`);
    if (answer) lines.push(`回答：${answer}`);
  });
  const custom = customAnswer.trim();
  if (custom) {
    hasAnswer = true;
    lines.push(`自定义补充：${custom}`);
  }
  return hasAnswer ? lines.join("\n") : undefined;
}

function buildVisibleAskAnswer(
  pendingAsk: PendingAskUserQuestion,
  selections: Record<number, string[]>,
  customAnswer: string
) {
  const selected = pendingAsk.questions
    .flatMap((_, index) => selections[index] ?? [])
    .filter(Boolean)
    .join("、");
  const custom = customAnswer.trim();
  if (selected && custom) return `我的选择：${selected}\n补充：${custom}`;
  if (selected) return `我的选择：${selected}`;
  return custom;
}

function buildMessagesFromRuns(runs: RunSnapshot[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const run of runs) {
    messages.push({
      id: `user-${run.id}`,
      role: "user",
      runId: run.id,
      content: run.input.prompt
    });

    const streamedRunIds = new Set<string>();
    for (const event of run.events) {
      appendEnvelopeToMessageList(messages, event, streamedRunIds);
    }
  }
  return messages;
}

function buildMessagesFromHistory(historyMessages: StoredHistoryMessage[]): ChatMessage[] {
  return historyMessages.map((message): ChatMessage => {
    if (message.role === "tool") {
      return {
        id: message.id,
        role: "tool",
        toolUseId: message.toolUseId ?? message.id,
        name: message.toolName ?? "Tool",
        input: message.toolInput,
        result: message.toolResult,
        status: message.toolStatus ?? "done"
      };
    }
    return {
      id: message.id,
      role: message.role,
      runId: message.runId,
      content: message.content ?? ""
    };
  });
}

function appendEnvelopeToMessageList(
  messages: ChatMessage[],
  envelope: AgentStreamEnvelope,
  streamedRunIds: Set<string>
) {
  const toolUse = extractToolUse(envelope.sdkEvent);
  if (toolUse) {
    if (!messages.some((message) => message.role === "tool" && message.toolUseId === toolUse.id)) {
      messages.push({
        id: `tool-${toolUse.id}`,
        role: "tool",
        toolUseId: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
        status: "running"
      });
    }
    return;
  }

  const toolResult = extractToolResult(envelope.sdkEvent);
  if (toolResult) {
    const index = messages.findIndex(
      (message) => message.role === "tool" && message.toolUseId === toolResult.toolUseId
    );
    if (index === -1) {
      messages.push({
        id: `tool-${toolResult.toolUseId}`,
        role: "tool",
        toolUseId: toolResult.toolUseId,
        name: "Tool",
        result: toolResult.result,
        status: "done"
      });
      return;
    }
    const message = messages[index];
    if (message?.role === "tool") {
      messages[index] = { ...message, result: toolResult.result, status: "done" };
    }
    return;
  }

  if (envelope.uiHints?.kind !== "text" || !envelope.uiHints.textDelta) return;
  if (envelope.uiHints.isPartial) {
    streamedRunIds.add(envelope.runId);
  } else if (streamedRunIds.has(envelope.runId)) {
    return;
  }

  const latest = messages[messages.length - 1];
  if (latest?.role === "assistant") {
    latest.content += envelope.uiHints.textDelta;
    return;
  }
  messages.push({
    id: `assistant-${envelope.runId}`,
    role: "assistant",
    runId: envelope.runId,
    content: envelope.uiHints.textDelta
  });
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

function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function ToolCallCard({ message }: { message: ToolMessage }) {
  const statusLabel =
    message.status === "done" ? "已完成" : message.status === "stopped" ? "已停止" : "正在使用";
  const preview = getToolPreview(message);
  return (
    <details className="tool-card">
      <summary>
        <span className={`tool-status ${message.status}`} />
        <span className="tool-summary-text">
          <strong>{statusLabel} {message.name}</strong>
          {preview ? <small>{preview}</small> : null}
        </span>
      </summary>
      <div className="tool-detail">
        {message.input !== undefined ? (
          <section>
            <div className="tool-detail-title">参数</div>
            <pre>{formatToolPayload(message.input)}</pre>
          </section>
        ) : null}
        {message.result !== undefined ? (
          <section>
            <div className="tool-detail-title">返回</div>
            <pre>{formatToolPayload(message.result)}</pre>
          </section>
        ) : null}
      </div>
    </details>
  );
}

function formatToolPayload(payload: unknown) {
  if (typeof payload === "string") return payload;
  return JSON.stringify(payload, null, 2);
}

function getToolPreview(message: ToolMessage) {
  const input = message.input as { command?: unknown; query?: unknown; pattern?: unknown; path?: unknown } | undefined;
  const value = input?.command ?? input?.query ?? input?.pattern ?? input?.path;
  if (typeof value === "string" && value.trim()) {
    return value.trim().slice(0, 140);
  }
  if (message.input !== undefined) return formatToolPayload(message.input).replace(/\s+/g, " ").slice(0, 140);
  return undefined;
}
