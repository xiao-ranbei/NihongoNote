import type { AppConfig } from "../config.js";
import { DisabledLlmProvider, DisabledTtsProvider } from "./disabled.js";
import type { LlmProvider, TtsProvider } from "./types.js";

export interface ProviderRegistry {
  llm: LlmProvider;
  tts: TtsProvider;
}

export function createProviderRegistry(config: AppConfig): ProviderRegistry {
  if (config.llmProvider !== "disabled" || config.ttsProvider !== "disabled") {
    throw new Error(
      `Configured providers are not implemented in the foundation build (LLM=${config.llmProvider}, TTS=${config.ttsProvider})`
    );
  }

  return {
    llm: new DisabledLlmProvider(),
    tts: new DisabledTtsProvider()
  };
}
