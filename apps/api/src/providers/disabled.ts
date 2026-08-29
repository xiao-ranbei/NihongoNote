import { hardMaxCompletionTokens } from "../llm-budget.js";
import {
  ProviderNotConfiguredError,
  type AnalysisRequest,
  type LlmAnalysisResult,
  type LlmBalance,
  type LlmProvider,
  type TtsProvider,
  type TtsRequest,
  type TtsResult
} from "./types.js";

export class DisabledLlmProvider implements LlmProvider {
  public readonly name = "disabled";
  public readonly protocol = "openai" as const;
  public readonly model = "disabled";
  public readonly configured = false;
  public readonly completionTokenBudget = hardMaxCompletionTokens;

  public async analyze(_request: AnalysisRequest): Promise<LlmAnalysisResult> {
    throw new ProviderNotConfiguredError("LLM");
  }

  public async fetchBalance(): Promise<LlmBalance | null> {
    return null;
  }
}

export class DisabledTtsProvider implements TtsProvider {
  public readonly name = "disabled";
  public readonly configured = false;

  public async synthesize(_request: TtsRequest): Promise<TtsResult> {
    throw new ProviderNotConfiguredError("TTS");
  }
}
