/*
 * 「分析失败」排查脚本（只读诊断，默认不发起 LLM 调用）。
 *
 *   pnpm tsx scripts/diagnose-failures.ts            # 阶段 0-2：配置体检 + 本地预处理（零 LLM）
 *   pnpm tsx scripts/diagnose-failures.ts --llm      # 阶段 3：真实调用本地模型复现
 *   pnpm tsx scripts/diagnose-failures.ts --llm --generous-timeout
 *                                                    # 阶段 3 放宽 timeout，测「真实需要多久」
 */
import "dotenv/config";

import { createDatabase } from "../src/db/database.js";
import { appConfig } from "../src/config.js";
import { parseLlmSettings, mergeLlmSettings, settingsDefaultsFromConfig } from "../src/settings.js";
import { buildLlmProvider } from "../src/providers/registry.js";
import { tokenizeJapanese } from "../src/tokenization.js";
import { prepareSegmentTokens } from "../src/segment-preparation.js";
import { estimateCompletionTokens } from "../src/llm-budget.js";

const useLlm = process.argv.includes("--llm");
const generousTimeout = process.argv.includes("--generous-timeout");

const targetDocumentId = process.env.DIAG_DOCUMENT_ID
  ?? "eedf7237-bc60-46ea-9e6b-62189a8e4e3b";
const targetIndices = (process.env.DIAG_INDICES ?? "7,9")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isInteger(value));

function bar(): void {
  console.log("-".repeat(78));
}

/* ---------- 阶段 0：配置体检 ---------- */
bar();
console.log("[阶段 0] 配置体检");
bar();

const database = await createDatabase(appConfig.databaseFile);
const row = database.get<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", ["llm"]);
const stored = row ? parseLlmSettings(JSON.parse(row.value)) : {};
const merged = mergeLlmSettings(settingsDefaultsFromConfig(appConfig), stored);

console.log("生效配置（db 覆盖 .env）：");
for (const [key, value] of Object.entries(merged)) {
  if (key === "profiles" || key === "activeProfileId") continue;
  console.log(`  ${key} = ${JSON.stringify(value)}  [${stored[key as keyof typeof stored] != null ? "db" : "env"}]`);
}
console.log("仅 .env 控制（设置页不暴露）：");
console.log(`  timeoutMs        = ${appConfig.llmTimeoutMs}`);
console.log(`  batchSize        = ${appConfig.llmBatchSize}`);
console.log(`  batchConcurrency = ${appConfig.llmBatchConcurrency}`);
console.log(`  debugLogging     = ${appConfig.llmDebugLogging}`);
console.log(`  promptVersion    = ${appConfig.llmPromptVersion}`);

/* ---------- 阶段 1：本地服务连通性 ---------- */
bar();
console.log("[阶段 1] 本地模型服务连通性");
bar();
let ollamaReachable = false;
try {
  const response = await fetch(new URL("api/tags", `${merged.baseUrl.replace(/\/+$/u, "")}/`), {
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) {
    console.log(`  /api/tags -> HTTP ${response.status}（服务在但异常）`);
  } else {
    const payload = await response.json() as { models?: Array<{ name: string; size: number }> };
    ollamaReachable = true;
    const names = (payload.models ?? []).map((model) => model.name);
    console.log(`  已加载模型: ${names.join(", ") || "(空)"}`);
    console.log(`  目标模型 "${merged.model}" ${names.includes(merged.model) ? "存在" : "★ 不存在 → 必然失败"}`);
  }
} catch (error) {
  console.log(`  ✗ 无法连接 ${merged.baseUrl}：${error instanceof Error ? error.message : String(error)}`);
  console.log("  → OllamaProvider.configured 恒为 true，服务不在时每次分析都会 fetch failed");
}
console.log(`  当前进程 OLLAMA_MODELS = ${process.env.OLLAMA_MODELS ?? "(未设置)"}`);

/* ---------- 阶段 2：本地预处理（零 LLM） ---------- */
bar();
console.log("[阶段 2] 本地预处理：分词 + 词典（零 LLM 调用）");
bar();

interface Row {
  id: string;
  segment_index: number;
  text: string;
  speaker: string | null;
  status: string;
  error_message: string | null;
}

const segments = targetIndices
  .map((index) => database.get<Row>(
    "SELECT id, segment_index, text, speaker, status, error_message FROM segments WHERE document_id = ? AND segment_index = ?",
    [targetDocumentId, index]
  ))
  .filter((value): value is Row => value !== undefined);

const prepared: Array<{
  row: Row;
  boundaries: ReturnType<typeof tokenizeJapanese>;
  llmBoundaries: ReturnType<typeof tokenizeJapanese>;
  localCount: number;
  estimatedOutputTokens: number;
}> = [];

for (const row of segments) {
  const boundaries = tokenizeJapanese(row.text, row.id);
  const { localTokens, llmBoundaries } = await prepareSegmentTokens(
    { id: row.id, text: row.text } as never,
    boundaries
  );
  const estimatedOutputTokens = Math.ceil(estimateCompletionTokens([{ text: row.text }]));
  prepared.push({ row, boundaries, llmBoundaries, localCount: localTokens.length, estimatedOutputTokens });
  console.log(
    `  段 ${row.segment_index} | 状态 ${row.status} | 字符 ${row.text.length} `
    + `| boundary ${boundaries.length} | 词典命中 ${localTokens.length} `
    + `| 送 LLM ${llmBoundaries.length} | 估算输出 ~${estimatedOutputTokens} tokens`
  );
  if (row.error_message) {
    console.log(`      已记录错误: ${row.error_message}`);
  }
}

/* ---------- 阶段 2b：全篇超时风险扫描（零 LLM） ---------- */
/*
 * 实测标定（2026-09-01，qwen3.5:9b，num_ctx=12288）：
 *   25 个 LLM token → 4995 输出 tokens → 78.1s
 *   11 个 LLM token → 2388 输出 tokens → 37.4s
 * 线性拟合：outputTokens ≈ 340 + 186 × n，速率 ≈ 63.9 tok/s。
 * 据此反推当前 timeout 下的可承受 token 上限。
 */
bar();
console.log("[阶段 2b] 全篇超时风险扫描（按实测速率 63.9 tok/s 外推）");
bar();
{
  const outputTokensPerToken = 186;
  const fixedOverhead = 340;
  const tokensPerSecond = 63.9;
  const budgetSeconds = appConfig.llmTimeoutMs / 1_000;
  const maxTokensInBudget = budgetSeconds * tokensPerSecond;
  const maxLlmTokens = (maxTokensInBudget - fixedOverhead) / outputTokensPerToken;
  console.log(
    `  ${budgetSeconds}s 内最多可生成 ~${Math.round(maxTokensInBudget)} 输出 tokens `
    + `→ 送 LLM 的 token 数超过 ~${maxLlmTokens.toFixed(1)} 个即必然超时`
  );

  const all = database.all<Row>(
    "SELECT id, segment_index, text, speaker, status, error_message FROM segments "
    + "WHERE document_id = ? ORDER BY segment_index",
    [targetDocumentId]
  );
  const risky: string[] = [];
  for (const item of all) {
    const boundaries = tokenizeJapanese(item.text, item.id);
    const { llmBoundaries } = await prepareSegmentTokens({ id: item.id, text: item.text } as never, boundaries);
    const estimatedOutput = Math.round(fixedOverhead + outputTokensPerToken * llmBoundaries.length);
    const estimatedSeconds = estimatedOutput / tokensPerSecond;
    const over = estimatedSeconds > budgetSeconds;
    if (over) {
      risky.push(
        `  段 ${item.segment_index} [${item.status}] 送 LLM ${llmBoundaries.length} token `
        + `→ 预估 ~${estimatedOutput} tokens / ~${estimatedSeconds.toFixed(0)}s ★超时风险`
      );
    }
  }
  console.log(`  文档共 ${all.length} 段，超时风险段 ${risky.length} 段：`);
  for (const line of risky) {
    console.log(line);
  }
}

/* ---------- 阶段 3：LLM 实测复现 ---------- */
bar();
console.log("[阶段 3] LLM 实测复现");
bar();
if (!useLlm) {
  console.log("  跳过（未传 --llm）。");
  console.log("  预估：本地 9B 约 40 tokens/s，按上表估算输出量可判断 60s 超时是否够用。");
} else {
  const buildConfig = {
    llmProvider: merged.provider,
    llmProtocol: "openai" as const,
    llmBaseUrl: merged.baseUrl,
    llmApiKey: merged.apiKey ?? undefined,
    llmModel: merged.model,
    llmTemperature: merged.temperature,
    llmMaxTokens: merged.maxTokens,
    llmTimeoutMs: generousTimeout ? 600_000 : appConfig.llmTimeoutMs,
    llmThinkingType: merged.thinkingType ?? undefined,
    // AppConfig.llmReasoningEffort 有 default，非 undefined；LlmBuildConfig 不接受 undefined
    llmReasoningEffort: merged.reasoningEffort ?? appConfig.llmReasoningEffort,
    // 跟随 .env，与真实服务行为一致（否则排查时拿不到原始响应）
    llmDebugLogging: appConfig.llmDebugLogging,
    llmDebugLogFile: appConfig.llmDebugLogFile
  };
  const provider = buildLlmProvider(buildConfig);
  console.log(
    `  provider=${provider.name} model=${provider.model} `
    + `timeout=${buildConfig.llmTimeoutMs}ms budget=${provider.completionTokenBudget}`
  );

  for (const item of prepared) {
    const startedAt = Date.now();
    const label = `段 ${item.row.segment_index}`;
    try {
      const result = await provider.analyze({
        segments: [{
          id: item.row.id,
          index: item.row.segment_index,
          speaker: item.row.speaker ?? undefined,
          text: item.row.text
        }] as never,
        tokenBoundaries: [{ segmentId: item.row.id, tokens: item.llmBoundaries }],
        surroundingContext: [{ segmentId: item.row.id, context: [] }],
        contentType: "dialogue",
        targetLevel: "auto",
        promptVersion: appConfig.llmPromptVersion,
        segmentFields: merged.segmentFields,
        signal: new AbortController().signal
      });
      const durationMs = Date.now() - startedAt;
      const rate = result.usage?.outputTokens
        ? (result.usage.outputTokens / (durationMs / 1000)).toFixed(1)
        : "n/a";
      console.log(
        `  ✓ ${label} 成功 ${durationMs}ms | 输出 ${result.usage?.outputTokens ?? "?"} tokens `
        + `(${rate} tok/s) | 解析 ${result.analyses.length} | 失败 ${result.failures.length}`
      );
      for (const failure of result.failures) {
        console.log(`      failure: ${failure.message}`);
      }
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      console.log(
        `  ✗ ${label} 失败 ${durationMs}ms | ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

database.close();
