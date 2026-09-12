import type { Segment } from "@nihongonote/core";

/** DeepSeek 单次请求 completion 的硬上限。 */
export const hardMaxCompletionTokens = 32_000;

/** 输出 token 估算模型：outputTokens ≈ overheadPerSegment × 段数 + tokensPerCharacter × 字符数。 */
export interface OutputTokenModel {
  overheadPerSegment: number;
  tokensPerCharacter: number;
}

/*
 * DeepSeek thinking 档（当前默认）。
 *
 * 标定数据来自 2026-08-29 两篇评估样本 19 次真实请求（原始记录在
 * docs/regression-2026-08-29.md）：实测 completion ≈ 200 ~ 500 × 原文字符，均值 294；
 * 段数越多、句子越短，固定开销占比越高。系数取这 19 个样本点的上界，宁可高估：
 * 高估只会让批次变小、请求变多，低估则会让整批被 token 上限截断。
 *
 * 2026-09-13 用 calibrate-output-model.ts 从落库 usage 复核（19 批 / 42 段）：
 * 回归均值 593/段 + 247.5/字符，但 R² 仅 0.44——thinking 输出方差极大，均值不可用于装箱；
 * 「历史零低估」上界为 884/段 + 369.2/字符。现用值比回归更保守（尤其短段），
 * 且已在实测中验证零截断，故保持不变。
 */
export const deepseekOutputTokenModel: OutputTokenModel = {
  overheadPerSegment: 3_500,
  tokensPerCharacter: 230
};

/*
 * 本地小模型（Ollama，think 关闭）。
 *
 * 2026-09-13 标定自 23 个单段批（字符 5–56，实测输出 367–3525 tokens）：
 * 均值 60.4/字符，历史零低估上界 107.1/字符（放大 1.77 倍）。
 *
 * ⚠️ overheadPerSegment 取 0 并不代表"真的没有固定开销"，而是**单段样本无法辨识**
 * 它（23 批全是 1 段 1 批，段数与字符数共线）。合并多段后必须用 calibrate 重新标定。
 *
 * 为什么必须单列：此前本地模型沿用 DeepSeek 系数（3500/段），对本地输出高估约 4.8 倍，
 * 预算 6308 连两段都装不下 → 批次恒为 1 段，LLM_BATCH_SIZE 完全空转。
 */
export const localOutputTokenModel: OutputTokenModel = {
  overheadPerSegment: 0,
  tokensPerCharacter: 107.1
};

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
  segments: readonly Pick<Segment, "text">[],
  model: OutputTokenModel = deepseekOutputTokenModel
): number {
  return segments.reduce(
    (total, segment) =>
      total + model.overheadPerSegment + segment.text.length * model.tokensPerCharacter,
    0
  );
}

/** 顺序装箱：按估算成本切批，段数上限与预算都不突破。 */
function packSegments<T extends Pick<Segment, "text">>(
  segments: readonly T[],
  maxItems: number,
  tokenBudget: number,
  model: OutputTokenModel
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let cost = 0;

  for (const segment of segments) {
    const segmentCost = estimateCompletionTokens([segment], model);
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
  tokenBudget: number,
  model: OutputTokenModel
): T[][] {
  if (batches.length < 2 || maxItems < 2) {
    return batches;
  }

  const tail = batches[batches.length - 1]!;
  const previous = batches[batches.length - 2]!;
  const tailCost = estimateCompletionTokens(tail, model);

  if (tailCost >= tokenBudget * shortTailUtilizationRatio) {
    return batches;
  }
  if (previous.length + tail.length > maxItems + 1) {
    return batches;
  }
  if (estimateCompletionTokens([...previous, ...tail], model) > tokenBudget) {
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
 * `model` 必须来自**当前 provider**（`provider.outputTokenModel`）：
 * 用错模型会让本地场景恒为 1 段/批（见 docs/architecture-v2.md §6）。
 *
 * 返回结果对同一输入完全确定：只依赖 segments / maxItems / tokenBudget / model，
 * 不含任何运行时状态——这是「成本预估可信」的前提。
 */
export function planBatches<T extends Pick<Segment, "text">>(
  segments: readonly T[],
  maxItems: number,
  tokenBudget: number,
  model: OutputTokenModel = deepseekOutputTokenModel
): T[][] {
  return mergeShortTail(
    packSegments(segments, maxItems, tokenBudget, model),
    maxItems,
    tokenBudget,
    model
  );
}
