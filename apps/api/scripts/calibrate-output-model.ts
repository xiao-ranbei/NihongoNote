/*
 * 输出 token 估算模型的离线标定脚本（纯本地、零 LLM 调用）。
 *
 *   pnpm --filter @nihongonote/api calibrate            # 人类可读报告
 *   pnpm --filter @nihongonote/api calibrate -- --json  # JSON（便于贴进 provider）
 *   pnpm --filter @nihongonote/api calibrate -- --model=qwen3.5:9b
 *
 * 为什么需要它：装箱（planBatches）与自适应 max_tokens 都要预估「这批会吐多少 token」。
 * 早期系数（3500/段 + 230/字符）是 2026-08-29 照着 DeepSeek thinking 档标定的，
 * 换成本地小模型（think 关闭）后**高估约 4.8 倍**，导致本地场景批次恒为 1 段、
 * LLM_BATCH_SIZE 完全空转。正解不是运行时自适应（会破坏成本预估的确定性），
 * 而是用真实用量把系数标定对（见 docs/architecture-v2.md §6）。
 *
 * 数据来源：`segment_analyses.usage_json` 是**批次级**的——同一批的 N 个句段共享
 * 完全相同的 usage 字符串（仓储层正是靠字符串去重来避免重复计费）。
 * 因此按 usage_json 分组即可还原「每批包含哪些段、共多少字符、实际吐了多少 token」。
 *
 * 模型：outputTokens ≈ overheadPerSegment × 段数 + tokensPerCharacter × 字符数
 * 无截距二元最小二乘（段数与字符数都为 0 时输出应为 0）。
 */
import "dotenv/config";

import { appConfig } from "../src/config.js";
import { createDatabase } from "../src/db/database.js";

interface RawRow {
  segment_id: string;
  model: string;
  usage_json: string;
  text: string;
}

interface BatchSample {
  model: string;
  segmentCount: number;
  characters: number;
  outputTokens: number;
}

interface Coefficients {
  overheadPerSegment: number;
  tokensPerCharacter: number;
}

interface FitReport {
  model: string;
  batches: number;
  segments: number;
  characterRange: [number, number];
  outputRange: [number, number];
  mean: Coefficients;
  upper: Coefficients;
  worstUnderestimateRatio: number;
  r2: number;
  mape: number;
  reliable: boolean;
}

const asJson = process.argv.includes("--json");
const modelFilter = process.argv
  .find((argument) => argument.startsWith("--model="))
  ?.slice("--model=".length);

/** 低于这个批次样本数时二元拟合不可信，只作参考。 */
const minimumReliableBatches = 3;

async function loadBatches(): Promise<BatchSample[]> {
  const database = await createDatabase(appConfig.databaseFile);
  const rows = database.all<RawRow>(`
    SELECT sa.segment_id, sa.model, sa.usage_json, s.text
    FROM segment_analyses sa
    INNER JOIN segments s ON s.id = sa.segment_id
    WHERE sa.usage_json IS NOT NULL AND sa.usage_json <> 'null'
  `);
  database.close();

  // 同批次共享同一份 usage_json：按「模型 + usage 串」分组即还原批次。
  const grouped = new Map<string, BatchSample>();
  for (const row of rows) {
    let usage: { outputTokens?: unknown } | null;
    try {
      usage = JSON.parse(row.usage_json) as typeof usage;
    } catch {
      continue;
    }
    if (!usage || typeof usage.outputTokens !== "number" || usage.outputTokens <= 0) {
      continue;
    }

    const key = `${row.model}\u0000${row.usage_json}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.segmentCount += 1;
      existing.characters += row.text.length;
      continue;
    }
    grouped.set(key, {
      model: row.model,
      segmentCount: 1,
      characters: row.text.length,
      outputTokens: usage.outputTokens
    });
  }

  return [...grouped.values()];
}

/** 无截距二元最小二乘：解 y = a·n + b·c。 */
function fit(points: BatchSample[]): Coefficients | null {
  let sumNN = 0;
  let sumNC = 0;
  let sumCC = 0;
  let sumNY = 0;
  let sumCY = 0;

  for (const point of points) {
    sumNN += point.segmentCount * point.segmentCount;
    sumNC += point.segmentCount * point.characters;
    sumCC += point.characters * point.characters;
    sumNY += point.segmentCount * point.outputTokens;
    sumCY += point.characters * point.outputTokens;
  }

  const determinant = sumNN * sumCC - sumNC * sumNC;
  if (Math.abs(determinant) < 1e-6) {
    return null;
  }

  return {
    overheadPerSegment: (sumCC * sumNY - sumNC * sumCY) / determinant,
    tokensPerCharacter: (sumNN * sumCY - sumNC * sumNY) / determinant
  };
}

function evaluate(
  points: BatchSample[],
  coefficients: Coefficients
): { r2: number; mape: number } {
  const mean = points.reduce((total, point) => total + point.outputTokens, 0) / points.length;
  let residualSum = 0;
  let totalSum = 0;
  let absolutePercentageError = 0;

  for (const point of points) {
    const predicted =
      coefficients.overheadPerSegment * point.segmentCount
      + coefficients.tokensPerCharacter * point.characters;
    residualSum += (point.outputTokens - predicted) ** 2;
    totalSum += (point.outputTokens - mean) ** 2;
    absolutePercentageError += Math.abs(point.outputTokens - predicted) / point.outputTokens;
  }

  return {
    r2: totalSum > 0 ? 1 - residualSum / totalSum : 1,
    mape: (absolutePercentageError / points.length) * 100
  };
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 把均值系数整体放大成「历史数据零低估」的上界系数。
 *
 * 为什么需要：回归给出的是期望值，而装箱要的是安全上界——高估只会让批次变小、
 * 请求变多，低估则会让整批被 token 上限截断（截断的损失远大于多一次请求）。
 * 做法是取历史样本里「实际 / 预测」的最大倍数，等比例放大两个系数。
 */
function toUpperBound(
  points: BatchSample[],
  coefficients: Coefficients
): { upper: Coefficients; ratio: number } {
  let worstRatio = 1;

  for (const point of points) {
    const predicted =
      coefficients.overheadPerSegment * point.segmentCount
      + coefficients.tokensPerCharacter * point.characters;
    if (predicted > 0) {
      worstRatio = Math.max(worstRatio, point.outputTokens / predicted);
    }
  }

  return {
    upper: {
      // 固定开销不允许为负（负截距在单段样本下是共线性的产物，物理上无意义）
      overheadPerSegment: Math.max(0, coefficients.overheadPerSegment * worstRatio),
      tokensPerCharacter: coefficients.tokensPerCharacter * worstRatio
    },
    ratio: worstRatio
  };
}

const batches = (await loadBatches()).filter(
  (batch) => modelFilter === undefined || batch.model === modelFilter
);

if (batches.length === 0) {
  console.log("数据库里还没有可用的真实用量记录（usage_json）。");
  console.log("先跑一次真实分析（云端需按 LLM-011 取得许可；本地 Ollama 免费）后重试。");
  process.exit(0);
}

const byModel = new Map<string, BatchSample[]>();
for (const batch of batches) {
  const list = byModel.get(batch.model) ?? [];
  list.push(batch);
  byModel.set(batch.model, list);
}

const reports: FitReport[] = [];
for (const [model, points] of byModel) {
  const mean = fit(points);
  if (!mean) {
    continue;
  }
  const { r2, mape } = evaluate(points, mean);
  const { upper, ratio } = toUpperBound(points, mean);
  const characters = points.map((point) => point.characters);
  const outputs = points.map((point) => point.outputTokens);

  reports.push({
    model,
    batches: points.length,
    segments: points.reduce((total, point) => total + point.segmentCount, 0),
    characterRange: [Math.min(...characters), Math.max(...characters)],
    outputRange: [Math.min(...outputs), Math.max(...outputs)],
    mean: {
      overheadPerSegment: round(mean.overheadPerSegment),
      tokensPerCharacter: round(mean.tokensPerCharacter, 1)
    },
    upper: {
      overheadPerSegment: round(upper.overheadPerSegment),
      tokensPerCharacter: round(upper.tokensPerCharacter, 1)
    },
    worstUnderestimateRatio: round(ratio, 2),
    r2: round(r2, 4),
    mape: round(mape, 1),
    reliable: points.length >= minimumReliableBatches
  });
}

if (reports.length === 0) {
  console.log("样本的段数与字符数没有变化，无法做二元拟合（需要至少两种不同规模）。");
  process.exit(0);
}

if (asJson) {
  const payload: Record<string, unknown> = {};
  for (const report of reports) {
    payload[report.model] = {
      mean: report.mean,
      upper: report.upper,
      worstUnderestimateRatio: report.worstUnderestimateRatio,
      batches: report.batches,
      r2: report.r2,
      mape: report.mape,
      reliable: report.reliable
    };
  }
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

console.log("=== 输出 token 估算模型标定（零 LLM）===");
console.log(`数据库：${appConfig.databaseFile}`);
console.log(`可用批次样本：${batches.length}`);
console.log("");

for (const report of reports) {
  console.log(`模型 ${report.model}`);
  console.log(
    `  批次 ${report.batches} 个 / 覆盖 ${report.segments} 段 /`
    + ` 字符 ${report.characterRange[0]}–${report.characterRange[1]} /`
    + ` 实测输出 ${report.outputRange[0]}–${report.outputRange[1]} tokens`
  );
  console.log(
    `  均值系数（成本预估用）：overheadPerSegment = ${report.mean.overheadPerSegment},`
    + ` tokensPerCharacter = ${report.mean.tokensPerCharacter}`
  );
  console.log(
    `  上界系数（装箱用，历史零低估 ×${report.worstUnderestimateRatio}）：`
    + `overheadPerSegment = ${report.upper.overheadPerSegment},`
    + ` tokensPerCharacter = ${report.upper.tokensPerCharacter}`
  );
  console.log(`  拟合优度：R² = ${report.r2}，平均绝对误差 ${report.mape}%`);
  if (!report.reliable) {
    console.log(
      `  ⚠ 样本少于 ${minimumReliableBatches} 批，系数仅供参照；`
      + "请沿用「宁可高估」的保守值，待积累更多批次后重新标定。"
    );
  }
  if (report.batches === report.segments) {
    console.log(
      "  注：该模型的样本全是「1 段 1 批」，无法区分每段固定开销与每字符增量；"
      + "上界系数取保守值，合并多段后需重新标定。"
    );
  }
  console.log("");
}

console.log("装箱用 upper、成本预估用 mean（见 docs/architecture-v2.md §6 与 src/llm-budget.ts）。");
