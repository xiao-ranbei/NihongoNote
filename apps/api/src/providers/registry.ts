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
      timeoutMs: config.llmTimeoutMs
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
