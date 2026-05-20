import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { query, type McpServerConfig, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { getModel, getOpenRouterDefaults } from "@openclaude/model-registry";
import type { AgentStreamEnvelope, RunInput } from "@openclaude/shared";
import { inferUiHint } from "@openclaude/shared";

export type AgentProvider = "openrouter" | "anthropic" | "mock";

export type RuntimeEventSink = (envelope: AgentStreamEnvelope) => Promise<void> | void;

export type RuntimeRunInput = {
  runId: string;
  prompt: string;
  attachments?: RunInput["attachments"];
  modelId: string;
  workspaceRoot: string;
  sharedHomePath: string;
  sdkSessionStoragePath: string;
  resumeSessionId?: string;
  skills?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  onEvent: RuntimeEventSink;
  onSession?: (sdkSessionId: string) => Promise<void> | void;
  signal?: AbortSignal;
};

const SUPPORTED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export type RuntimeRunResult = {
  sdkSessionId?: string;
  costUsd?: number;
  numTurns?: number;
  stopReason?: string;
};

export type RunningAgentQuery = {
  done: Promise<RuntimeRunResult>;
  close: () => void;
};

export interface AgentRuntime {
  start(input: RuntimeRunInput): RunningAgentQuery;
}

export type ClaudeAgentRuntimeOptions = {
  openRouterApiKey?: string;
  baseUrl?: string;
  provider?: Exclude<AgentProvider, "mock">;
  wallClockTimeoutMs?: number;
};

export class ClaudeAgentRuntime implements AgentRuntime {
  constructor(private readonly options: ClaudeAgentRuntimeOptions) {}

  start(input: RuntimeRunInput): RunningAgentQuery {
    const model = getModel(input.modelId);
    const controller = new AbortController();
    const wallClockTimeoutMs = this.options.wallClockTimeoutMs ?? 10 * 60 * 1000;
    const timeout = setTimeout(() => controller.abort(), wallClockTimeoutMs);

    const candidateImageAttachments =
      input.attachments?.filter(
        (attachment) => attachment.kind === "image" && attachment.mimeType && SUPPORTED_IMAGE_MIME.has(attachment.mimeType)
      ) ?? [];

    const imageAttachments = model.supportsMultimodal ? candidateImageAttachments : [];
    if (!model.supportsMultimodal && candidateImageAttachments.length > 0) {
      console.warn(
        `Model ${model.id} does not support multimodal input; dropping ${candidateImageAttachments.length} image attachment(s).`
      );
    }

    const promptInput: string | AsyncIterable<SDKUserMessage> =
      imageAttachments.length > 0
        ? buildMultimodalPrompt(input.prompt, imageAttachments)
        : input.prompt;

    if (input.resumeSessionId) {
      try {
        sanitizeTranscriptForCrossModelResume({
          sdkSessionStoragePath: input.sdkSessionStoragePath,
          workspaceRoot: input.workspaceRoot,
          sessionId: input.resumeSessionId,
          targetOpenRouterModel: model.openRouterModel,
          targetSupportsMultimodal: model.supportsMultimodal
        });
      } catch (error) {
        console.warn("Failed to sanitize transcript for cross-model resume", error);
      }
    }

    const stream = query({
      prompt: promptInput,
      options: {
        cwd: input.workspaceRoot,
        env: {
          ...process.env,
          HOME: input.sharedHomePath,
          CLAUDE_CONFIG_DIR: input.sdkSessionStoragePath,
          ANTHROPIC_BASE_URL: this.options.baseUrl ?? "https://openrouter.ai/api",
          ANTHROPIC_AUTH_TOKEN: this.options.openRouterApiKey ?? "",
          ANTHROPIC_API_KEY: "",
          ...getOpenRouterDefaults(input.modelId)
        },
        model: model.sdkModel,
        maxTurns: 60,
        includePartialMessages: true,
        tools: { type: "preset", preset: "claude_code" },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project"],
        ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
        ...(input.skills?.length ? { skills: input.skills } : {}),
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        canUseTool: async (toolName) => {
          if (toolName === "AskUserQuestion") {
            return {
              behavior: "deny" as const,
              message: "OpenClaude paused this run so the browser user can answer the question.",
              interrupt: true
            };
          }
          return { behavior: "allow" as const, updatedInput: {} };
        }
      }
    });

    const done = (async (): Promise<RuntimeRunResult> => {
      let sequence = 0;
      let sdkSessionId: string | undefined;
      let lastResult: RuntimeRunResult = {};
      let sawPartialText = false;
      const forward = async (sdkEvent: SDKMessage | Record<string, unknown>) => {
        let uiHints = inferUiHint(sdkEvent);
        const eventType = (sdkEvent as { type?: string }).type;
        if (eventType === "stream_event" && uiHints?.kind === "text") {
          sawPartialText = true;
        }
        if (eventType === "assistant" && sawPartialText && uiHints?.kind === "text") {
          uiHints = { kind: "status" };
        }
        const envelope: AgentStreamEnvelope = {
          version: 1,
          runId: input.runId,
          sequence: ++sequence,
          timestamp: new Date().toISOString(),
          provider: this.options.provider ?? "openrouter",
          sdkEvent,
          uiHints
        };
        await input.onEvent(envelope);
      };

      try {
        for await (const message of stream) {
          if (message.type === "system" && "subtype" in message && message.subtype === "init") {
            sdkSessionId = message.session_id;
            await input.onSession?.(sdkSessionId);
          }

          if (message.type === "result") {
            lastResult = {
              sdkSessionId,
              costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined,
              numTurns: typeof message.num_turns === "number" ? message.num_turns : undefined,
              stopReason: "subtype" in message && typeof message.subtype === "string" ? message.subtype : undefined
            };
          }

          await forward(message);
        }

        return { ...lastResult, sdkSessionId: lastResult.sdkSessionId ?? sdkSessionId };
      } finally {
        clearTimeout(timeout);
      }
    })();

    const close = () => {
      controller.abort();
      stream.close();
    };

    input.signal?.addEventListener("abort", close, { once: true });
    controller.signal.addEventListener("abort", () => stream.close(), { once: true });

    return { done, close };
  }
}

export class MockAgentRuntime implements AgentRuntime {
  start(input: RuntimeRunInput): RunningAgentQuery {
    let closed = false;
    const close = () => {
      closed = true;
    };

    const done = (async (): Promise<RuntimeRunResult> => {
      let sequence = 0;
      const emit = async (sdkEvent: Record<string, unknown>, kind?: AgentStreamEnvelope["uiHints"]) => {
        if (closed) return;
        await input.onEvent({
          version: 1,
          runId: input.runId,
          sequence: ++sequence,
          timestamp: new Date().toISOString(),
          provider: "mock",
          sdkEvent,
          uiHints: kind ?? inferUiHint(sdkEvent)
        });
      };

      const sessionId = input.resumeSessionId ?? `mock-session-${input.runId}`;
      await input.onSession?.(sessionId);
      await emit({ type: "system", subtype: "init", session_id: sessionId, cwd: input.workspaceRoot });
      await delay(250);
      await emit({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: `Mock runtime received: ${input.prompt}\n\n配置 OPENROUTER_API_KEY 并把 AGENT_RUNTIME_MODE=claude 后，会切换到 Claude Agent SDK。`
            }
          ]
        }
      });
      await delay(250);
      await emit({ type: "result", subtype: closed ? "stopped" : "success", total_cost_usd: 0, num_turns: 1 });
      return { sdkSessionId: sessionId, costUsd: 0, numTurns: 1, stopReason: closed ? "stopped" : "success" };
    })();

    return { done, close };
  }
}

function buildMultimodalPrompt(
  text: string,
  imageAttachments: NonNullable<RunInput["attachments"]>
): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    const content: Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string };
        }
    > = [];
    if (text.trim()) {
      content.push({ type: "text", text });
    }
    for (const attachment of imageAttachments) {
      if (!attachment.mimeType || !SUPPORTED_IMAGE_MIME.has(attachment.mimeType)) continue;
      try {
        const buffer = await readFile(attachment.workspaceFilePath);
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: attachment.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: buffer.toString("base64")
          }
        });
      } catch (error) {
        console.warn("Failed to read image attachment", attachment.workspaceFilePath, error);
      }
    }
    if (content.length === 0) {
      content.push({ type: "text", text: text || "(empty prompt)" });
    }
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null
    } as SDKUserMessage;
  })();
}

const CROSS_MODEL_INCOMPATIBLE_BLOCK_TYPES = new Set([
  // Reasoning blocks carry provider-specific signatures. Cross-vendor APIs
  // refuse them with HTTP 400 (e.g. Anthropic rejecting a DeepSeek thinking
  // signature it cannot verify), so when the resumed transcript was authored
  // by a different vendor we drop them and keep text + tool_use blocks.
  "thinking",
  "redacted_thinking",
  "reasoning",
  "reasoning_content"
]);

function providerFromOpenRouterModel(model: string | undefined): string {
  if (typeof model !== "string") return "unknown";
  const slash = model.indexOf("/");
  if (slash > 0) return model.slice(0, slash).toLowerCase();
  return model.toLowerCase();
}

function sdkTranscriptPath(sdkSessionStoragePath: string, workspaceRoot: string, sessionId: string): string {
  const encodedCwd = workspaceRoot.replace(/[/\\]/g, "-");
  return path.join(sdkSessionStoragePath, "projects", encodedCwd, `${sessionId}.jsonl`);
}

type ContentBlock = { type?: string; [key: string]: unknown };

type SdkTranscriptEvent = {
  type?: string;
  message?: { role?: string; model?: string; content?: ContentBlock[] | string };
};

function sanitizeTranscriptForCrossModelResume(args: {
  sdkSessionStoragePath: string;
  workspaceRoot: string;
  sessionId: string;
  targetOpenRouterModel: string;
  targetSupportsMultimodal: boolean;
}): void {
  const transcriptPath = sdkTranscriptPath(args.sdkSessionStoragePath, args.workspaceRoot, args.sessionId);
  if (!existsSync(transcriptPath)) return;

  const targetProvider = providerFromOpenRouterModel(args.targetOpenRouterModel);
  const raw = readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n");
  let changed = false;

  const next = lines.map((line) => {
    if (!line.trim()) return line;
    let event: SdkTranscriptEvent;
    try {
      event = JSON.parse(line) as SdkTranscriptEvent;
    } catch {
      return line;
    }
    if (!event.message || !Array.isArray(event.message.content)) return line;

    const original = event.message.content;
    let updated: ContentBlock[] = original;

    if (event.type === "assistant") {
      const sourceProvider = providerFromOpenRouterModel(event.message.model);
      if (sourceProvider !== targetProvider && sourceProvider !== "unknown") {
        updated = updated.filter(
          (block) => typeof block?.type === "string" && !CROSS_MODEL_INCOMPATIBLE_BLOCK_TYPES.has(block.type)
        );
      }
    }

    if (!args.targetSupportsMultimodal) {
      updated = updated.map((block) => {
        if (block?.type === "image") {
          return { type: "text", text: "[image attached in previous turn — omitted because the current model does not support image input]" };
        }
        return block;
      });
    }

    if (updated === original) return line;
    if (updated.length === 0) {
      updated = [{ type: "text", text: "[content omitted for cross-model resume]" }];
    }
    event.message.content = updated;
    changed = true;
    return JSON.stringify(event);
  });

  if (changed) {
    writeFileSync(transcriptPath, next.join("\n"), "utf8");
  }
}
