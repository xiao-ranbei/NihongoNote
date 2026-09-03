import type { Segment, SegmentFieldProfile } from "@nihongonote/core";

import { estimateCost } from "./llm-pricing.js";
import { prepareSegmentTokens } from "./segment-preparation.js";
import type { ContentDictionaryProvider } from "./dictionary/content/types.js";
import { tokenizeJapanese } from "./tokenization.js";

/**
 * 分析工具页的预览统计与费用估算（设计文档 3.5/§六-4，纯本地、零 LLM 调用）。
 *
 * 职责：
 * 1. countSegmentTokens —— 逐段分词 + 三层链路本地预处理（形态素 + 词典查表），
 *    统计「词典命中 token（不花 token）」与「未命中 token（完整分析时走 LLM）」；
 * 2. estimateAnalysisTokens / estimatePreviewCost / estimateDurationSeconds ——
 *    把未命中 token 折算成预计输入/输出 tokens、闲时/高峰费用与时长，
 *    供成本确认弹窗（LLM-011）展示。
 *
 * 估算系数是经验值，宁高勿低：高估只会让用户多预留预算，低估则会超支。
 */

export interface PreviewCoefficients {
  inputTokensPerSegment: number;
  inputTokensPerUnmissedToken: number;
  outputTokensPerSegmentOverhead: number;
  outputTokensPerUnmissedToken: number;
}

/**
 * 各档位的 token 估算系数（标定自 2026-08-29 两篇评估样本 19 次真实请求，
 * 原始记录在 docs/regression-2026-08-29.md；档位设计见 docs/analysis-tools-design.md 3.8）：
 *
 * - 实测 799 字/30 段 → 去重后输入 33,340 / 输出 192,052（medium 档，推理占输出 72.8%）；
 * - full 档段级固定开销 ≈ 3,500 输出 tokens/段（段级字段与推理的固定部分，
 *   与 llm-budget.completionOverheadPerSegment 同源）；
 * - standard 档 ≈ 2,200/段（7 字段合并为 4 字段 + 键级省略，模型思考与序列化同步减少）；
 * - minimal 档 ≈ 1,500/段（只输出翻译 + 语法要点）；
 * - 每未命中 token 输出：full 400（14 字段宽表 JSON）/ standard 320 / minimal 300；
 * - 输入：约 1,000/段（prompt 模板 + 原文 + 上下文）+ 80/未命中 token（boundary JSON），
 *   三个档位差异极小（仅 prompt 字段清单长短），统一取同值。
 *
 * 词典命中的 token 不参与任何估算（零 token）。
 */
export const previewCoefficientsByProfile: Record<SegmentFieldProfile, PreviewCoefficients> = {
  full: {
    inputTokensPerSegment: 1_000,
    inputTokensPerUnmissedToken: 80,
    outputTokensPerSegmentOverhead: 3_500,
    outputTokensPerUnmissedToken: 400
  },
  standard: {
    inputTokensPerSegment: 1_000,
    inputTokensPerUnmissedToken: 80,
    outputTokensPerSegmentOverhead: 2_200,
    outputTokensPerUnmissedToken: 320
  },
  minimal: {
    inputTokensPerSegment: 1_000,
    inputTokensPerUnmissedToken: 80,
    outputTokensPerSegmentOverhead: 1_500,
    outputTokensPerUnmissedToken: 300
  }
};

/** 兼容导出：full 档系数（历史行为），verify 与既有引用不受影响。 */
export const previewCoefficients = previewCoefficientsByProfile.full;

/** 默认档位（与 config.LLM_SEGMENT_FIELDS 默认值保持一致）。 */
export const defaultSegmentFieldProfile: SegmentFieldProfile = "standard";

/** 时长估算速率（输出 tokens/秒），minimal 档经验值，宁慢勿快。 */
export const estimatedTokensPerSecond = 40;

export interface TokenStats {
  totalTokens: number;
  matchedTokens: number;
  unmissedTokens: number;
}

export interface AnalysisTokenEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * 逐段做本地预处理并统计命中情况（零 LLM）。
 *
 * 注意：形态素分析（kuromoji）在模块内是单例，多篇文章预览只初始化一次。
 */
export async function countSegmentTokens(
  segments: Segment[],
  contentDictionary?: ContentDictionaryProvider | null
): Promise<TokenStats> {
  let totalTokens = 0;
  let matchedTokens = 0;
  for (const segment of segments) {
    const boundaries = tokenizeJapanese(segment.text, segment.id);
    const { localTokens } = await prepareSegmentTokens(segment, boundaries, contentDictionary);
    totalTokens += boundaries.length;
    matchedTokens += localTokens.length;
  }
  return {
    totalTokens,
    matchedTokens,
    unmissedTokens: totalTokens - matchedTokens
  };
}

/** 按段数、未命中 token 数与档位估算一次完整分析的输入/输出 tokens。 */
export function estimateAnalysisTokens(
  segmentCount: number,
  unmissedTokens: number,
  profile: SegmentFieldProfile = defaultSegmentFieldProfile
): AnalysisTokenEstimate {
  const coefficients = previewCoefficientsByProfile[profile];
  const inputTokens = Math.round(
    segmentCount * coefficients.inputTokensPerSegment
    + unmissedTokens * coefficients.inputTokensPerUnmissedToken
  );
  const outputTokens = Math.round(
    segmentCount * coefficients.outputTokensPerSegmentOverhead
    + unmissedTokens * coefficients.outputTokensPerUnmissedToken
  );
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  };
}

/** 时长估算（秒）：输出 token 速率折算，minimal 档经验值。 */
export function estimateDurationSeconds(outputTokens: number): number {
  return Math.ceil(outputTokens / estimatedTokensPerSecond);
}

/** 北京时间「必为高峰」/「必为闲时」的固定时刻，用于同时给出两档单价。 */
const peakDate = new Date("2026-08-31T01:00:00Z"); // 北京 2026-08-31(周一) 09:00
const offPeakDate = new Date("2026-08-30T02:00:00Z"); // 北京 2026-08-30(周日) 10:00

/**
 * 按模型内置价格表估算闲时/高峰两档费用（元）。
 * 模型不在内置价格表内时返回 null（前端显示「价格未知」而不是编一个数）。
 */
export function estimatePreviewCost(
  model: string,
  estimate: AnalysisTokenEstimate
): { offPeak: number | null; peak: number | null } | null {
  const usage = {
    inputTokens: estimate.inputTokens,
    outputTokens: estimate.outputTokens,
    totalTokens: estimate.totalTokens,
    cachedInputTokens: 0
  };
  const offPeak = estimateCost(model, usage, offPeakDate);
  const peak = estimateCost(model, usage, peakDate);
  if (!offPeak || !peak) {
    return null;
  }
  return { offPeak: offPeak.totalCost, peak: peak.totalCost };
}
