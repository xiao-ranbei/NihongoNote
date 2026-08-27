import {
  ProviderNotConfiguredError,
  type AnalysisRequest,
  type LlmAnalysisResult,
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

  public async analyze(_request: AnalysisRequest): Promise<LlmAnalysisResult> {
    throw new ProviderNotConfiguredError("LLM");
  }
}

export class DisabledTtsProvider implements TtsProvider {
  public readonly name = "disabled";
  public readonly configured = false;

  public async synthesize(_request: TtsRequest): Promise<TtsResult> {
    throw new ProviderNotConfiguredError("TTS");
  }
}
