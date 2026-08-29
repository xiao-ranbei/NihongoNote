import type { Segment } from "@nihongonote/core";

/** DeepSeek 单次请求 completion 的硬上限。 */
export const hardMaxCompletionTokens = 32_000;

/*
 * 完成 token 的经验估算，标定数据来自 2026-08-29 两篇评估样本 19 次真实请求
 * （原始记录在 docs/regression-2026-08-29.md）：
 * 实测 completion ≈ 200 ~ 500 × 原文字符，均值 294；段数越多、句子越短，
 * 固定开销占比越高。系数取这 19 个样本点的上界，宁可高估：
 * 高估只会让批次变小、请求变多，低估则会让整批被 token 上限截断。
 */
const completionOverheadPerSegment = 3_500;
const completionTokensPerCharacter = 230;

/** 装箱时给估算留的安全余量（约 1/1.3，与 resolveMaxTokens 的放大系数对应）。 */
export const packingSafetyRatio = 0.77;

export function estimateCompletionTokens(
  segments: readonly Pick<Segment, "text">[]
): number {
  return segments.reduce(
    (total, segment) =>
      total + completionOverheadPerSegment + segment.text.length * completionTokensPerCharacter,
    0
  );
}

/**
 * 按估算成本装箱，而不是固定段数：
 * 三个长句段凑一批必然打满 token 上限（实测样本 2 就是这样丢掉 3 个句段的），
 * 而固定调小批量又会让短句段白白多花一轮请求。
 * 单个句段即使超预算也单独成批，保证不重不漏、不会死循环。
 */
export function planBatches<T extends Pick<Segment, "text">>(
  segments: readonly T[],
  maxItems: number,
  tokenBudget: number
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let cost = 0;

  for (const segment of segments) {
    const segmentCost = estimateCompletionTokens([segment]);
    if (current.length > 0 && (current.length >= maxItems || cost + segmentCost > tokenBudget)) {
      batches.push(current);
      current = [];
      cost = 0;
    }
    current.push(segment);
    cost += segmentCost;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}
