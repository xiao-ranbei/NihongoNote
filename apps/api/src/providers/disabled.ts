import {
  type SegmentAnalysis
} from "@nihongonote/core";

import {
  ProviderNotConfiguredError,
  type AnalysisRequest,
  type LlmProvider,
  type TtsProvider,
  type TtsRequest,
  type TtsResult
} from "./types.js";

export class DisabledLlmProvider implements LlmProvider {
  public readonly name = "disabled";

  public async analyze(_request: AnalysisRequest): Promise<SegmentAnalysis[]> {
    throw new ProviderNotConfiguredError("LLM");
  }
}

export class DisabledTtsProvider implements TtsProvider {
  public readonly name = "disabled";

  public async synthesize(_request: TtsRequest): Promise<TtsResult> {
    throw new ProviderNotConfiguredError("TTS");
  }
}
