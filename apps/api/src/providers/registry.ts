import type { AppConfig } from "../config.js";
import { DisabledLlmProvider, DisabledTtsProvider } from "./disabled.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAiCompatibleLlmProvider } from "./openai-compatible.js";
import type { LlmProvider, TtsProvider } from "./types.js";

export interface LlmProviderHolder {
  current: LlmProvider;
  /** 热切换：保存设置后替换当前 provider，进行中的请求不受影响（旧引用仍在栈上）。 */
  replace(next: LlmProvider): void;
}

export interface ProviderRegistry {
  llm: LlmProviderHolder;
  tts: TtsProvider;
}

/** buildLlmProvider 需要的字段子集（热重建时由 LlmSettings + env 兜底构造）。 */
export type LlmBuildConfig = Pick<
  AppConfig,
  | "llmProvider"
  | "llmProtocol"
  | "llmBaseUrl"
  | "llmApiKey"
  | "llmModel"
  | "llmTemperature"
  | "llmMaxTokens"
  | "llmTimeoutMs"
  | "llmThinkingType"
  | "llmReasoningEffort"
  | "llmDebugLogging"
  | "llmDebugLogFile"
>;

export function buildLlmProvider(config: LlmBuildConfig): LlmProvider {
  if (config.llmProvider === "disabled") {
    return new DisabledLlmProvider();
  }
  if (config.llmProvider === "ollama") {
    // Ollama 本地模型（设计文档 3.9）：走原生 /api/chat 协议。
    // OpenAI 兼容层实测有 num_ctx=4096 硬限制且无法关闭思考（2026-08-30），
    // 原生协议才能扩上下文 + think:false。无 API key、无余额端点。
    if (config.llmProtocol !== "openai") {
      throw new Error(
        `LLM provider "${config.llmProvider}" currently supports only LLM_PROTOCOL=openai`
      );
    }

    return new OllamaProvider({
      providerName: config.llmProvider,
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
      temperature: config.llmTemperature,
      maxTokens: config.llmMaxTokens,
      timeoutMs: config.llmTimeoutMs,
      debugLogging: config.llmDebugLogging,
      debugLogFile: config.llmDebugLogFile
    });
  }
  if (
    config.llmProvider === "deepseek"
    || config.llmProvider === "openai"
    || config.llmProvider === "openai-compatible"
  ) {
    if (config.llmProtocol !== "openai") {
      throw new Error(
        `LLM provider "${config.llmProvider}" currently supports only LLM_PROTOCOL=openai`
      );
    }

    return new OpenAiCompatibleLlmProvider({
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
  }
  throw new Error(`Unsupported LLM provider: ${config.llmProvider}`);
}

export function createProviderRegistry(config: AppConfig): ProviderRegistry {
  const holder: LlmProviderHolder = {
    current: buildLlmProvider(config),
    replace(next: LlmProvider): void {
      holder.current = next;
    }
  };

  if (config.ttsProvider !== "disabled") {
    throw new Error(`Configured TTS provider is not implemented yet: ${config.ttsProvider}`);
  }

  return {
    llm: holder,
    tts: new DisabledTtsProvider()
  };
}
