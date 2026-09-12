import type { ContentType, Segment, SegmentAnalysis, SegmentFieldProfile } from "@nihongonote/core";

import type { OutputTokenModel } from "../llm-budget.js";
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
  /**
   * 段级语义字段档位（设计文档 3.8）。缺省由 provider 取默认档位（standard），
   * 与 config.LLM_SEGMENT_FIELDS 保持一致。
   */
  segmentFields?: SegmentFieldProfile;
  signal: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /**
   * DeepSeek 特有：缓存命中的输入 token（prompt_cache_hit_tokens）。
   * 命中部分的单价远低于未命中部分，计费必须分开。
   */
  cachedInputTokens?: number | null;
}

export interface LlmBalanceEntry {
  currency: string;
  totalBalance: string;
  grantedBalance: string | null;
  toppedUpBalance: string | null;
}

export interface LlmBalance {
  isAvailable: boolean;
  /** 脱敏后的 API key（如 sk-49af…be98），供前端展示，绝不回传完整 key。 */
  apiKeyMasked: string;
  model: string;
  baseUrl: string;
  entries: LlmBalanceEntry[];
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
  /**
   * 单次请求允许的最大 completion token。
   * 业务层用它来装箱：批次的估算成本必须留出安全余量，否则长句段凑一批会被截断。
   */
  readonly completionTokenBudget: number;
  /**
   * 输出 token 估算模型（离线标定的产物，见 scripts/calibrate-output-model.ts）。
   *
   * 必须由 provider 自己声明，而不是业务层用一套通用系数：各provider 的输出特性差异极大——
   * DeepSeek thinking 档每段固定开销就有数千 token，本地小模型（think 关闭）几乎只有
   * 与字符数成正比的部分。用错模型会让本地场景批次恒为 1 段（实测高估约 4.8 倍）。
   */
  readonly outputTokenModel: OutputTokenModel;
  analyze(request: AnalysisRequest): Promise<LlmAnalysisResult>;
  /**
   * 查询当前账号余额。provider 未配置或无余额接口时返回 null。
   * 抛 ProviderRequestError 表示查询失败（网络/鉴权/非 2xx）。
   */
  fetchBalance(): Promise<LlmBalance | null>;
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
