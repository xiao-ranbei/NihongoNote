import type { Segment, SegmentAnalysis } from "@nihongonote/core";

export interface AnalysisRequest {
  segments: Segment[];
  surroundingContext: string[];
  targetLevel: string;
  promptVersion: string;
}

export interface LlmProvider {
  readonly name: string;
  analyze(request: AnalysisRequest): Promise<SegmentAnalysis[]>;
}

export interface TtsRequest {
  text: string;
  voice: string;
  speed: number;
  prosody: Record<string, string>;
}

export interface TtsResult {
  provider: string;
  voice: string;
  format: string;
  audio: Buffer;
}

export interface TtsProvider {
  readonly name: string;
  synthesize(request: TtsRequest): Promise<TtsResult>;
}

export class ProviderNotConfiguredError extends Error {
  public constructor(providerType: "LLM" | "TTS") {
    super(`${providerType} provider is not configured yet`);
    this.name = "ProviderNotConfiguredError";
  }
}
