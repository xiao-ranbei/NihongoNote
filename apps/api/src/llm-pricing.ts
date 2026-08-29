import type { LlmUsage } from "./providers/types.js";

/**
 * 模型单价（每百万 tokens，人民币）。
 *
 * 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 高峰时段 = 北京时区周一至周五 9:00–12:00、14:00–18:00，其余为闲时；
 * 闲时价格为高峰的一半。输入价格区分缓存命中/未命中
 * （DeepSeek 在 usage 里通过 prompt_cache_hit_tokens / prompt_cache_miss_tokens 区分）。
 *
 * 只内置当前项目实际使用的模型。模型不在表内时 estimateCost 返回 null，
 * 前端显示「价格未知」而不是编一个数。价格会变，定期对照官方页更新。
 */
export interface TokenPrice {
  offPeak: number;
  peak: number;
}

export interface ModelPriceTable {
  inputCacheHitPerMillion: TokenPrice;
  inputCacheMissPerMillion: TokenPrice;
  outputPerMillion: TokenPrice;
  currency: "CNY";
}

export const builtinPriceTables: Readonly<Record<string, ModelPriceTable>> = {
  "deepseek-v4-flash": {
    inputCacheHitPerMillion: { offPeak: 0.05, peak: 0.10 },
    inputCacheMissPerMillion: { offPeak: 1.5, peak: 3.0 },
    outputPerMillion: { offPeak: 4.5, peak: 9.0 },
    currency: "CNY"
  }
};

export type PriceTier = "peak" | "off-peak";

/**
 * 判断当前时间是否落在 DeepSeek 高峰时段。
 * 规则：北京时区（UTC+8）周一至周五 9:00–12:00、14:00–18:00。
 * 实现用「本地时间 + 8 小时再读 UTC 分量」得到北京时间，不依赖运行环境时区。
 */
export function isPeakHour(date: Date): boolean {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const day = shifted.getUTCDay(); // 0 = Sunday
  if (day === 0 || day === 6) {
    return false;
  }
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return (minutes >= 9 * 60 && minutes < 12 * 60)
    || (minutes >= 14 * 60 && minutes < 18 * 60);
}

export function priceTierFor(date: Date): PriceTier {
  return isPeakHour(date) ? "peak" : "off-peak";
}

export interface CostBreakdown {
  model: string;
  currency: "CNY";
  tier: PriceTier;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  /** 输入总费用（缓存命中 + 未命中），单位：元。 */
  inputCost: number;
  /** 输出总费用，单位：元。 */
  outputCost: number;
  /** 本次合计费用，单位：元。 */
  totalCost: number;
}

/**
 * 按 usage 与当前时刻估算一次请求的费用。
 * 模型不在内置价格表内时返回 null（前端显示「价格未知」）。
 */
export function estimateCost(
  model: string,
  usage: LlmUsage | null,
  date: Date = new Date()
): CostBreakdown | null {
  if (!usage) {
    return null;
  }
  const prices = builtinPriceTables[model];
  if (!prices) {
    return null;
  }

  const cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
  const inputTokens = Math.max(0, usage.inputTokens ?? 0);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const outputTokens = Math.max(0, usage.outputTokens ?? 0);
  const tier = priceTierFor(date);
  // tier 是 "off-peak"（连字符），价格表键是 offPeak（驼峰），做一次映射
  const priceKey: keyof TokenPrice = tier === "peak" ? "peak" : "offPeak";

  const inputCost = (
    cachedInputTokens / 1_000_000 * prices.inputCacheHitPerMillion[priceKey]
    + uncachedInputTokens / 1_000_000 * prices.inputCacheMissPerMillion[priceKey]
  );
  const outputCost = outputTokens / 1_000_000 * prices.outputPerMillion[priceKey];

  return {
    model,
    currency: prices.currency,
    tier,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost
  };
}
