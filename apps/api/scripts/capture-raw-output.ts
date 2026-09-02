/*
 * 抓取本地模型原始输出，定位 JSON 非法字符（只读诊断，会调用本地 LLM）。
 *
 *   pnpm tsx scripts/capture-raw-output.ts 9
 *
 * 直接调 Ollama /api/chat，绕过 provider 的 JSON 解析，
 * 把原始 content 落到 data/raw-capture-segment-<index>.txt 供逐行分析。
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

import { createDatabase } from "../src/db/database.js";
import { appConfig } from "../src/config.js";
import { parseLlmSettings, mergeLlmSettings, settingsDefaultsFromConfig } from "../src/settings.js";
import { buildSystemPrompt } from "../src/providers/openai-compatible.js";
import { tokenizeJapanese } from "../src/tokenization.js";
import { prepareSegmentTokens } from "../src/segment-preparation.js";

const index = Number.parseInt(process.argv[2] ?? "9", 10);
const documentId = process.env.DIAG_DOCUMENT_ID ?? "eedf7237-bc60-46ea-9e6b-62189a8e4e3b";

const database = await createDatabase(appConfig.databaseFile);
const row = database.get<{ id: string; text: string; speaker: string | null }>(
  "SELECT id, text, speaker FROM segments WHERE document_id = ? AND segment_index = ?",
  [documentId, index]
);
if (!row) {
  throw new Error(`segment ${index} not found`);
}
const settingsRow = database.get<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", ["llm"]);
const merged = mergeLlmSettings(
  settingsDefaultsFromConfig(appConfig),
  settingsRow ? parseLlmSettings(JSON.parse(settingsRow.value)) : {}
);
database.close();

const boundaries = tokenizeJapanese(row.text, row.id);
const { llmBoundaries } = await prepareSegmentTokens({ id: row.id, text: row.text } as never, boundaries);
console.log(`段 ${index}: ${row.text.length} 字符, ${boundaries.length} boundary, 送 LLM ${llmBoundaries.length} token`);

const maxTokens = Math.min(merged.maxTokens, 8_192);
const body = {
  model: merged.model,
  messages: [
    { role: "system", content: buildSystemPrompt(merged.segmentFields) },
    {
      role: "user",
      content: JSON.stringify({
        contentType: "dialogue",
        targetLevel: "auto",
        surroundingContext: [{ segmentId: row.id, context: [] }],
        segments: [{ segmentId: row.id, index, speaker: row.speaker, text: row.text }],
        tokenBoundaries: [{ segmentId: row.id, tokens: llmBoundaries }]
      })
    }
  ],
  think: false,
  options: { num_ctx: maxTokens + 4_096, num_predict: maxTokens, temperature: merged.temperature },
  stream: true
};

const endpoint = new URL("api/chat", `${merged.baseUrl.replace(/\/+$/u, "").replace(/\/v1$/iu, "")}/`).toString();
const startedAt = Date.now();
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(600_000)
});

let content = "";
let doneReason: string | null = null;
let evalCount: number | null = null;
let promptEvalCount: number | null = null;
const reader = response.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let nl: number;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = chunk.message as { content?: string } | undefined;
    if (message?.content) content += message.content;
    if (chunk.done) {
      doneReason = (chunk.done_reason as string) ?? "stop";
      evalCount = (chunk.eval_count as number) ?? null;
      promptEvalCount = (chunk.prompt_eval_count as number) ?? null;
    }
  }
}
reader.releaseLock();

const durationMs = Date.now() - startedAt;
console.log(`耗时 ${durationMs}ms | finish=${doneReason} | prompt ${promptEvalCount} / output ${evalCount} tokens`);

const outFile = path.resolve(appConfig.dataDirectory, `raw-capture-segment-${index}.txt`);
fs.writeFileSync(outFile, content, "utf8");
console.log(`原始输出已写入: ${outFile} (${content.length} 字符)`);

/* JSON 合法性检查 */
try {
  JSON.parse(content);
  console.log("JSON.parse：✓ 合法");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`JSON.parse：✗ ${message}`);
  const match = /(?:position (\d+))?.*?(?:line (\d+) column (\d+))?/u.exec(message);
  const positionMatch = /position (\d+)/u.exec(message);
  if (positionMatch) {
    const pos = Number.parseInt(positionMatch[1]!, 10);
    console.log("\n--- 出错位置上下文（±180 字符）---");
    console.log(JSON.stringify(content.slice(Math.max(0, pos - 180), pos + 180)));
  }
  const lineMatch = /line (\d+) column (\d+)/u.exec(message);
  if (lineMatch) {
    const lineNo = Number.parseInt(lineMatch[1]!, 10);
    const lines = content.split("\n");
    console.log(`\n--- 第 ${lineNo} 行原文 ---`);
    console.log(lines[lineNo - 1]);
    console.log(`\n--- 第 ${lineNo - 1} ~ ${lineNo + 1} 行 ---`);
    for (const n of [lineNo - 1, lineNo, lineNo + 1]) {
      if (lines[n - 1] !== undefined) console.log(`${n}: ${lines[n - 1]}`);
    }
  }
  void match;
}

/* 统计可疑字符：字符串值内部的 ASCII 双引号 */
const suspicious: Array<{ line: number; text: string }> = [];
content.split("\n").forEach((line, i) => {
  const trimmed = line.trim();
  const quoteCount = (trimmed.match(/"/gu) ?? []).length;
  // 正常的 key": "value" 结构：偶数个引号；奇数或过多说明混用了
  if (quoteCount % 2 !== 0) {
    suspicious.push({ line: i + 1, text: trimmed });
  }
});
if (suspicious.length > 0) {
  console.log(`\n--- 引号数为奇数的行（${suspicious.length} 行，前 10）---`);
  for (const item of suspicious.slice(0, 10)) {
    console.log(`  L${item.line}: ${item.text.slice(0, 160)}`);
  }
}
