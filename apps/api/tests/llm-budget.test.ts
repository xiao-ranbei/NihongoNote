import { describe, expect, it } from "vitest";

import {
  deepseekOutputTokenModel,
  estimateCompletionTokens,
  localOutputTokenModel,
  packingSafetyRatio,
  planBatches
} from "../src/llm-budget.js";

/*
 * 装箱与输出估算的单元测试。
 *
 * 与 scripts/verify-pipeline.ts 的分工：那边是端到端自检（子进程崩溃补写、落盘时序、
 * 真实 kuromoji、provider 装配），这里只测纯函数的细粒度行为与边界，跑得更快、定位更细。
 * 两边都会覆盖装箱的核心路径——这层重复是有意的：verify 保证"整体没坏"，
 * 单元测试保证"改哪条规则时立刻知道踩了谁"。
 */

const segment = (id: string, charCount: number) => ({ id, text: "あ".repeat(charCount) });
const segments = (count: number, charCount: number) =>
  Array.from({ length: count }, (_, index) => segment(`s${index}`, charCount));

/** 模拟云端预算：32000 硬上限 × 安全系数。 */
const cloudBudget = Math.floor(32_000 * packingSafetyRatio);
/** 模拟本地预算：Ollama 的 min(12000, 8192) × 安全系数。 */
const localBudget = Math.floor(8_192 * packingSafetyRatio);

const sizes = (batches: Array<Array<{ id: string }>>) => batches.map((batch) => batch.length);
const ids = (batches: Array<Array<{ id: string }>>) => batches.flat().map((item) => item.id);

describe("estimateCompletionTokens", () => {
  it("不传模型时沿用云端系数（向后兼容）", () => {
    const sample = segments(2, 10);
    expect(estimateCompletionTokens(sample)).toBe(
      estimateCompletionTokens(sample, deepseekOutputTokenModel)
    );
    expect(estimateCompletionTokens(sample)).toBe(2 * (3_500 + 10 * 230));
  });

  it("空输入为 0（没有段就没有固定开销）", () => {
    expect(estimateCompletionTokens([])).toBe(0);
    expect(estimateCompletionTokens([], localOutputTokenModel)).toBe(0);
  });

  it("按传入模型的系数精确计算", () => {
    const tenChars = [segment("a", 10)];
    expect(estimateCompletionTokens(tenChars, deepseekOutputTokenModel)).toBe(3_500 + 2_300);
    expect(Math.round(estimateCompletionTokens(tenChars, localOutputTokenModel))).toBe(1_071);
  });

  it("随字符数单调不减", () => {
    for (const model of [deepseekOutputTokenModel, localOutputTokenModel]) {
      const short = estimateCompletionTokens([segment("a", 5)], model);
      const long = estimateCompletionTokens([segment("a", 50)], model);
      expect(long).toBeGreaterThan(short);
    }
  });
});

describe("planBatches", () => {
  it("不重不漏且保持原顺序", () => {
    const input = [...segments(3, 5), segment("long", 92), segment("mid", 20)];
    const batches = planBatches(input, 3, cloudBudget);
    expect(ids(batches)).toEqual(input.map((item) => item.id));
    expect(new Set(ids(batches)).size).toBe(input.length);
  });

  it("段数上限是硬约束（预算还有余量也要切）", () => {
    const batches = planBatches(segments(4, 5), 2, cloudBudget);
    expect(sizes(batches)).toEqual([2, 2]);
  });

  it("长句段单独成批，且不影响后续段", () => {
    const batches = planBatches(
      [segment("long", 92), ...segments(2, 5)],
      3,
      cloudBudget
    );
    expect(batches[0]!.map((item) => item.id)).toEqual(["long"]);
    expect(ids(batches).length).toBe(3);
  });

  it("单段超预算也单独成批，不丢段、不死循环", () => {
    const batches = planBatches([segment("huge", 500), ...segments(2, 5)], 3, cloudBudget);
    expect(batches[0]!.map((item) => item.id)).toEqual(["huge"]);
    expect(ids(batches).length).toBe(3);
  });

  it("同一输入必得同一分批（成本预估可信的前提）", () => {
    const input = segments(7, 12);
    const first = planBatches(input, 3, cloudBudget, deepseekOutputTokenModel);
    const second = planBatches(input, 3, cloudBudget, deepseekOutputTokenModel);
    expect(sizes(first)).toEqual(sizes(second));
  });
});

describe("planBatches 最小块保护", () => {
  it("尾批过短时并入前一批", () => {
    // 11 字：3500 + 2530 = 6030；4 段共 24120 ≤ 预算，尾批占比 24.5%
    const batches = planBatches(segments(4, 11), 3, cloudBudget);
    expect(sizes(batches)).toEqual([4]);
  });

  it("并入后会超预算则保持小尾批（宁可多一次请求也不越界）", () => {
    // 12 字：3500 + 2760 = 6260；4 段共 25040 > 预算
    const batches = planBatches(segments(4, 12), 3, cloudBudget);
    expect(sizes(batches)).toEqual([3, 1]);
  });

  it("尾批不算短时不做调整", () => {
    // 20 字：8100，占预算 32.9% ≥ 30% 阈值
    const batches = planBatches(segments(4, 20), 3, cloudBudget);
    expect(sizes(batches)).toEqual([3, 1]);
  });

  it("batchSize=1 视为严格单段模式，不触发合并", () => {
    expect(sizes(planBatches(segments(3, 11), 1, cloudBudget))).toEqual([1, 1, 1]);
  });
});

describe("按 provider 模型装箱", () => {
  it("本地模型能合并，沿用云端模型则只能单段", () => {
    const sample = segments(3, 20);
    expect(sizes(planBatches(sample, 3, localBudget, localOutputTokenModel))).toEqual([2, 1]);
    expect(sizes(planBatches(sample, 3, localBudget, deepseekOutputTokenModel))).toEqual([
      1, 1, 1
    ]);
  });
});
