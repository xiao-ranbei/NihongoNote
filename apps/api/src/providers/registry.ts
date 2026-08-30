import type { AppConfig } from "../config.js";
import { DisabledLlmProvider, DisabledTtsProvider } from "./disabled.js";
import { OpenAiCompatibleLlmProvider } from "./openai-compatible.js";
import type { LlmProvider, TtsProvider } from "./types.js";

export interface ProviderRegistry {
  llm: LlmProvider;
  tts: TtsProvider;
}

export function createProviderRegistry(config: AppConfig): ProviderRegistry {
  let llm: LlmProvider;

  if (config.llmProvider === "disabled") {
    llm = new DisabledLlmProvider();
  } else if (
    config.llmProvider === "deepseek"
    || config.llmProvider === "openai"
    || config.llmProvider === "openai-compatible"
    // Ollama 本地模型（设计文档 3.9）：/v1 端点与 OpenAI 兼容层天然对齐，
    // 无 API key、无余额端点，configured/balance 由 provider 内部特判。
    || config.llmProvider === "ollama"
  ) {
    if (config.llmProtocol !== "openai") {
      throw new Error(
        `LLM provider "${config.llmProvider}" currently supports only LLM_PROTOCOL=openai`
      );
    }

    llm = new OpenAiCompatibleLlmProvider({
      providerName: config.llmProvider,
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.llmModel,
      temperature: config.llmTemperature,
      maxTokens: config.llmMaxTokens,
      timeoutMs: config.llmTimeoutMs,
      thinkingType: config.llmThinkingType,
      reasoningEffort: config.llmReasoningEffort,
      debugLogging: config.llmDebugLogging,
      debugLogFile: config.llmDebugLogFile
    });
  } else {
    throw new Error(`Unsupported LLM provider: ${config.llmProvider}`);
  }

  if (config.ttsProvider !== "disabled") {
    throw new Error(`Configured TTS provider is not implemented yet: ${config.ttsProvider}`);
  }

  return {
    llm,
    tts: new DisabledTtsProvider()
  };
}
