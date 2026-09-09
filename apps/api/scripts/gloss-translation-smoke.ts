/**
 * 译中（阶段 B）实机冒烟（设计文档 jmdict-integration-design.md §6.5）。
 *
 * verify-pipeline 里的译中断言用的是「假 translator + 种子缓存」，不碰网络；
 * 本脚本才真正调用本机 Ollama 把内容词英文释义译中，验证三件事：
 *   1. 真实链路能出中文（模型/端点/提示词都对）；
 *   2. 结果落 vocabulary_cache，二次同词命中缓存、耗时显著下降（零重复推理）；
 *   3. 接入 prepareSegmentTokens 后内容词 token 的 gloss/explanation 是中文。
 *
 * 纯本地推理、零云端费用（LLM-011：不触发 DeepSeek）。
 * 用法：pnpm --filter @nihongonote/api gloss-smoke
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { createDatabase } from "../src/db/database.js";
import { createContentDictionaryHolder } from "../src/dictionary/content/index.js";
import { OllamaGlossTranslator } from "../src/dictionary/content/translator.js";
import { prepareSegmentTokens } from "../src/segment-preparation.js";
import { tokenizeJapanese } from "../src/tokenization.js";

const baseUrl = process.env.CONTENT_DICT_TRANSLATE_BASE_URL ?? "http://127.0.0.1:11434";
const model = process.env.CONTENT_DICT_TRANSLATE_MODEL ?? "qwen3.5:9b";

/** 真实语料里的高频内容词英文释义（取自 fixture / JMdict）。 */
const sampleTerms = [
  "business",
  "estimate",
  "efficiency",
  "personal history"
];

function tagsEndpoint(): string {
  return new URL(
    "api/tags",
    `${baseUrl.replace(/\/+$/u, "").replace(/\/v1$/iu, "")}/`
  ).toString();
}

async function probeOllama(): Promise<boolean> {
  try {
    const response = await fetch(tagsEndpoint(), {
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json() as { models?: Array<{ name: string }> };
    const names = (payload.models ?? []).map((item) => item.name);
    if (!names.some((name) => name === model || name.startsWith(`${model}:`))) {
      console.log(`✗ Ollama 已启动，但没有模型 ${model}。已装：${names.join(", ") || "（无）"}`);
      return false;
    }
    console.log(`✓ Ollama 就绪：${tagsEndpoint()}，模型 ${model} 已安装`);
    return true;
  } catch {
    console.log(`✗ 连不上 Ollama（${baseUrl}）。请先启动：`);
    console.log(`  OLLAMA_MODELS="D:/Ollama/Models" "/c/Users/xiao_/AppData/Local/Programs/Ollama/ollama.exe" serve`);
    return false;
  }
}

async function main(): Promise<void> {
  console.log("=== 译中（Ollama 中文释义）实机冒烟 ===");
  console.log(`端点 ${baseUrl} / 模型 ${model} / 零云端调用`);
  console.log("");

  if (!(await probeOllama())) {
    process.exit(1);
  }

  const dir = path.resolve(process.cwd(), "data", "_gloss_smoke");
  const file = path.join(dir, "gloss.db");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const database = await createDatabase(file);

  const translator = new OllamaGlossTranslator({
    database,
    baseUrl,
    model,
    enabled: true
  });

  console.log("");
  console.log("--- ① 真实译中（首次调用走 Ollama）---");
  const cold: Array<{ term: string; out: string; ms: number }> = [];
  for (const term of sampleTerms) {
    const startedAt = Date.now();
    const out = await translator.translate(term);
    cold.push({ term, out, ms: Date.now() - startedAt });
    console.log(`  ${term.padEnd(26)} → ${out}    (${cold.at(-1)!.ms} ms)`);
  }

  console.log("");
  console.log("--- ② 二次调用（应命中 vocabulary_cache，零推理）---");
  let allCached = true;
  for (const item of cold) {
    const startedAt = Date.now();
    const out = await translator.translate(item.term);
    const ms = Date.now() - startedAt;
    const same = out === item.out;
    if (!same) {
      allCached = false;
    }
    console.log(
      `  ${item.term.padEnd(26)} → ${out}    (${ms} ms, 首次 ${item.ms} ms) ${same ? "一致" : "不一致！"}${ms <= item.ms ? " ·更快" : ""}`
    );
  }

  const rows = database.all<{ term: string; translation: string }>(
    "SELECT term, translation FROM vocabulary_cache ORDER BY term"
  );
  console.log("");
  console.log(`--- ③ vocabulary_cache 落库：${rows.length} 条 ---`);
  for (const row of rows) {
    console.log(`  ${row.term.padEnd(26)} = ${row.translation}`);
  }

  console.log("");
  console.log("--- ④ 端到端：内容词典层 + 译中，看 token 释义是否为中文 ---");
  const holder = await createContentDictionaryHolder("jmdict-common");
  if (!holder.current.ready()) {
    console.log("  （跳过：data/jmdict-common-index.json 不存在，未启用内容词典层）");
  } else {
    const text = "営業の見積もりと効率を確認します。";
    const segment = { id: "smoke:1", text };
    const prepared = await prepareSegmentTokens(
      segment as never,
      tokenizeJapanese(text, "smoke:1"),
      holder.current,
      translator
    );
    console.log(`  原文：${text}`);
    for (const token of prepared.localTokens) {
      console.log(
        `    ${token.surface.padEnd(10)} [${(token.source ?? "-").padEnd(10)}] gloss=${token.gloss ?? "-"} / explanation=${token.explanation ?? "-"}`
      );
    }
    console.log(`  LLM 候选：${prepared.llmBoundaries.length} 个 token`);
  }

  database.close();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log("");
  console.log(allCached && rows.length === sampleTerms.length
    ? "✓ 译中实机冒烟通过：真实出中文 + 缓存一致 + 落库完整"
    : "✗ 译中实机冒烟未通过（见上）");
  if (!(allCached && rows.length === sampleTerms.length)) {
    process.exit(1);
  }
}

await main();
