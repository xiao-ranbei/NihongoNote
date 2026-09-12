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

/**
 * 尾批「过短」的判定阈值：批成本低于预算的这个比例时，才考虑并入前一批。
 *
 * 取 0.3 的理由：一段的固定开销就有 3500 token，短句段的批很容易只占预算的一两成；
 * 这种批单独发一次请求，等于为一个小尾巴多付一轮 Reasoning 固定开销与等待。
 * 借鉴 japanese-analyzer 的 minChars 保护（他们在 280/420 之上留了 180 的下限，
 * 避免切出没有意义的碎块）。
 */
export const shortTailUtilizationRatio = 0.3;

export function estimateCompletionTokens(
  segments: readonly Pick<Segment, "text">[]
): number {
  return segments.reduce(
    (total, segment) =>
      total + completionOverheadPerSegment + segment.text.length * completionTokensPerCharacter,
    0
  );
}

/** 顺序装箱：按估算成本切批，段数上限与预算都不突破。 */
function packSegments<T extends Pick<Segment, "text">>(
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

/**
 * 最小块保护：尾批明显过短时并入前一批，避免为一个小尾巴单独发一次请求。
 *
 * 为什么需要它：切批时机由「段数上限」或「预算」触发。段数上限触发时预算往往还有余量，
 * 于是尾部留下一个只占预算一两成的批——它的估算成本几乎全是固定开销，
 * 单独发一次等于白白多付一轮请求与等待。
 *
 * 三种情况不合并（均由断言守住）：
 * 1. 只有一批——没有合并对象；
 * 2. `maxItems < 2`——视为「严格单段模式」，尊重用户显式配置的意图；
 * 3. 并入后会超出预算——宁可留一个小尾批，也不能让批次越过 token 上限
 *    （越界会被截断，那才是真正的浪费）。
 *
 * 为此允许合并后的批次比 `maxItems` 多 1 段：`maxItems` 是装箱目标，预算是硬约束。
 */
function mergeShortTail<T extends Pick<Segment, "text">>(
  batches: T[][],
  maxItems: number,
  tokenBudget: number
): T[][] {
  if (batches.length < 2 || maxItems < 2) {
    return batches;
  }

  const tail = batches[batches.length - 1]!;
  const previous = batches[batches.length - 2]!;
  const tailCost = estimateCompletionTokens(tail);

  if (tailCost >= tokenBudget * shortTailUtilizationRatio) {
    return batches;
  }
  if (previous.length + tail.length > maxItems + 1) {
    return batches;
  }
  if (estimateCompletionTokens([...previous, ...tail]) > tokenBudget) {
    return batches;
  }

  batches.splice(batches.length - 2, 2, [...previous, ...tail]);
  return batches;
}

/**
 * 按估算成本装箱，而不是固定段数：
 * 三个长句段凑一批必然打满 token 上限（实测样本 2 就是这样丢掉 3 个句段的），
 * 而固定调小批量又会让短句段白白多花一轮请求。
 * 单个句段即使超预算也单独成批，保证不重不漏、不会死循环。
 *
 * 返回结果对同一输入完全确定：只依赖 segments / maxItems / tokenBudget，
 * 不含任何运行时状态——这是「成本预估可信」的前提（docs/architecture-v2.md §6）。
 */
export function planBatches<T extends Pick<Segment, "text">>(
  segments: readonly T[],
  maxItems: number,
  tokenBudget: number
): T[][] {
  return mergeShortTail(packSegments(segments, maxItems, tokenBudget), maxItems, tokenBudget);
}
