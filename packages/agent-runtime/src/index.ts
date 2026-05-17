import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { query, type McpServerConfig, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { getModel, getOpenRouterDefaults } from "@openclaude/model-registry";
import { shouldBlockBashCommand } from "@openclaude/sandbox";
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
        maxTurns: 20,
        includePartialMessages: true,
        tools: { type: "preset", preset: "claude_code" },
        permissionMode: "acceptEdits",
        settingSources: ["project"],
        ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
        ...(input.skills?.length ? { skills: input.skills } : {}),
        ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
        canUseTool: async (toolName, rawInput) => {
          const toolInput = rawInput as Record<string, unknown>;
          if (toolName === "AskUserQuestion") {
            return {
              behavior: "deny" as const,
              message: "OpenClaude paused this run so the browser user can answer the question.",
              interrupt: true
            };
          }
          if (toolName === "Bash") {
            const command = typeof toolInput.command === "string" ? toolInput.command : "";
            const reason = shouldBlockBashCommand(command);
            if (reason) {
              return {
                behavior: "deny" as const,
                message: reason,
                interrupt: true
              };
            }
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
