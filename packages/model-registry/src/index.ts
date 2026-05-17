export type EffortLevel = "low" | "medium" | "high";

export type OpenClaudeModel = {
  id: string;
  label: string;
  provider: "openrouter";
  sdkModel: "sonnet" | "opus" | "haiku" | string;
  openRouterModel: string;
  supportsTools: boolean;
  supportsMultimodal: boolean;
  supportsEffort: boolean;
  group: "claude" | "deepseek" | "other";
  isClaudeNative: boolean;
};

export const DEFAULT_MODEL_ID = "claude-sonnet-4.6";
export const TITLE_MODEL = "anthropic/claude-haiku-4.5";
export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high"];

export const models: OpenClaudeModel[] = [
  {
    id: DEFAULT_MODEL_ID,
    label: "Sonnet 4.6",
    provider: "openrouter",
    sdkModel: "sonnet",
    openRouterModel: "anthropic/claude-sonnet-4.6",
    supportsTools: true,
    supportsMultimodal: true,
    supportsEffort: true,
    group: "claude",
    isClaudeNative: true
  },
  {
    id: "claude-opus-4.7",
    label: "Opus 4.7",
    provider: "openrouter",
    sdkModel: "opus",
    openRouterModel: "anthropic/claude-opus-4.7",
    supportsTools: true,
    supportsMultimodal: true,
    supportsEffort: true,
    group: "claude",
    isClaudeNative: true
  },
  {
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "openrouter",
    sdkModel: "sonnet",
    openRouterModel: "deepseek/deepseek-v4-flash",
    supportsTools: true,
    supportsMultimodal: false,
    supportsEffort: false,
    group: "deepseek",
    isClaudeNative: false
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "openrouter",
    sdkModel: "sonnet",
    openRouterModel: "deepseek/deepseek-v4-pro",
    supportsTools: true,
    supportsMultimodal: false,
    supportsEffort: false,
    group: "deepseek",
    isClaudeNative: false
  }
];

export function getModel(id: string | undefined): OpenClaudeModel {
  return models.find((model) => model.id === id) ?? models[0]!;
}

export function getOpenRouterDefaults(modelId: string | undefined): Record<string, string> {
  const model = getModel(modelId);
  if (!model.isClaudeNative) {
    return {
      ANTHROPIC_DEFAULT_SONNET_MODEL: model.openRouterModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: TITLE_MODEL
    };
  }
  const sonnet = models.find((candidate) => candidate.sdkModel === "sonnet" && candidate.isClaudeNative) ?? models[0]!;
  const opus = models.find((candidate) => candidate.sdkModel === "opus" && candidate.isClaudeNative);
  return {
    ANTHROPIC_DEFAULT_SONNET_MODEL:
      model.sdkModel === "sonnet" ? model.openRouterModel : sonnet.openRouterModel,
    ...(opus
      ? {
          ANTHROPIC_DEFAULT_OPUS_MODEL:
            model.sdkModel === "opus" ? model.openRouterModel : opus.openRouterModel
        }
      : {}),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: TITLE_MODEL
  };
}
