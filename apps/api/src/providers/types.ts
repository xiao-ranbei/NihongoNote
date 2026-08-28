import type { ContentType, Segment, SegmentAnalysis } from "@nihongonote/core";

import type { TokenBoundary } from "../tokenization.js";

export type LlmProtocol = "openai" | "anthropic";

export interface SegmentTokenBoundaries {
  segmentId: string;
  tokens: TokenBoundary[];
}

export interface SegmentContext {
  segmentId: string;
  context: string[];
}

export interface AnalysisRequest {
  segments: Segment[];
  tokenBoundaries: SegmentTokenBoundaries[];
  surroundingContext: SegmentContext[];
  contentType: ContentType;
  targetLevel: string;
  promptVersion: string;
  signal: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface LlmAnalysisResult {
  analyses: SegmentAnalysis[];
  failures: Array<{
    segmentId: string | null;
    message: string;
  }>;
  usage: LlmUsage | null;
}

export interface LlmProvider {
  readonly name: string;
  readonly protocol: LlmProtocol;
  readonly model: string;
  readonly configured: boolean;
  analyze(request: AnalysisRequest): Promise<LlmAnalysisResult>;
}

export interface TtsRequest {
  text: string;
  voice: string;
  speed: number;
  format: string;
  ssmlVersion?: string;
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
  readonly configured: boolean;
  synthesize(request: TtsRequest): Promise<TtsResult>;
}

export class ProviderNotConfiguredError extends Error {
  public constructor(providerType: "LLM" | "TTS") {
    super(`${providerType} provider is not configured yet`);
    this.name = "ProviderNotConfiguredError";
  }
}

export class ProviderConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

export class ProviderRequestError extends Error {
  public readonly statusCode: number | null;

  public constructor(message: string, statusCode: number | null = null) {
    super(message);
    this.name = "ProviderRequestError";
    this.statusCode = statusCode;
  }
}
