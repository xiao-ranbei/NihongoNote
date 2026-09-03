import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type { SegmentView, TokenCategory } from "@nihongonote/core";

import { createDatabase } from "../src/db/database.js";
import { createProviderRegistry } from "../src/providers/registry.js";
import { createContentDictionaryHolder } from "../src/dictionary/content/index.js";
import { OllamaGlossTranslator } from "../src/dictionary/content/translator.js";
import { DocumentRepository } from "../src/repositories/document-repository.js";
import { AnalysisService } from "../src/services/analysis-service.js";
import { measureSourceCoverage } from "../src/segmentation.js";
import { tokenizeJapanese } from "../src/tokenization.js";

/*
 * 完整两篇语料回归（LLM-002 验收）。
 *
 * 走真实的 repository + analysis-service，因此同时覆盖：
 * 分段 / 分词 / 提示词 / 结构化输出校验 / 落盘 / 失败重试语义。
 *
 *   pnpm --filter @nihongonote/api regression
 *
 * 默认使用独立数据目录和独立调试日志，不污染日常数据。
 * 注意执行顺序：先写入环境变量默认值，再手动 dotenv.config()
 * （dotenv 不会覆盖已存在的键），最后才动态 import config ——
 * 否则 config.ts 会在模块求值时就锁定 .env 里的日常配置。
 */
process.env.NIHONGO_DATA_DIR ??= "./data/regression";
process.env.LLM_DEBUG_LOGGING ??= "true";
process.env.LLM_DEBUG_LOG_FILE ??= "./data/regression/llm-debug.jsonl";

const dotenv = await import("dotenv");
dotenv.config();

const { appConfig } = await import("../src/config.js");

interface CorpusSample {
  id: string;
  title: string;
  text: string;
}

interface CategoryTally {
  word: number;
  particle: number;
  functional: number;
  adverb: number;
  grammar: number;
}

interface SampleReport {
  id: string;
  title: string;
  sourceCharacters: number;
  coverage: ReturnType<typeof measureSourceCoverage>;
  missingGaps: string;
  speakers: string[];
  segments: number;
  completed: number;
  failed: number;
  tokens: number;
  boundaryMismatches: string[];
  categories: CategoryTally;
  confidenceNull: number;
  confidenceNumeric: number;
  confidenceLow: number;
  politenessValues: string[];
  missingLemma: number;
  missingReading: number;
  missingExplanation: number;
  failures: Array<{ segmentId: string; message: string }>;
  wallClockMs: number;
}

function emptyTally(): CategoryTally {
  return { word: 0, particle: 0, functional: 0, adverb: 0, grammar: 0 };
}

function parseCorpus(filePath: string): CorpusSample[] {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const samples: CorpusSample[] = [];
  let title: string | undefined;
  let id: string | undefined;
  let inOriginal = false;
  let inFence = false;
  let buffer: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## 样本")) {
      title = line.replace(/^#+\s*/, "").trim();
      id = undefined;
      inOriginal = false;
      inFence = false;
      buffer = [];
      continue;
    }
    if (title === undefined) {
      continue;
    }

    const idMatch = /^-\s*\*\*ID\*\*：`([^`]+)`/.exec(line);
    if (idMatch) {
      id = idMatch[1]!.trim();
      continue;
    }

    if (line.startsWith("### ")) {
      inOriginal = line.includes("原始文本");
      inFence = false;
      continue;
    }

    if (!inOriginal) {
      continue;
    }
    if (!inFence) {
      if (line.trim() === "```text") {
        inFence = true;
        buffer = [];
      }
      continue;
    }
    if (line.trim() === "```") {
      const sample = { id: id ?? title, title, text: buffer.join("\n") };
      // 跳过文末的「后续追加模板」占位示例
      if (!sample.title.includes("<标题>") && !/\s/.test(sample.id)) {
        samples.push(sample);
      }
      title = undefined;
      id = undefined;
      inOriginal = false;
      inFence = false;
      continue;
    }
    buffer.push(line);
  }

  return samples;
}

/** 取回被分段丢弃的原文片段，用来证明覆盖率缺口到底是什么 */
function describeMissingGaps(sourceText: string, segments: SegmentView[]): string {
  const ranges = [...segments]
    .filter((segment) => segment.endOffset > segment.startOffset)
    .sort((left, right) => left.startOffset - right.startOffset);
  const gaps: string[] = [];
  let cursor = 0;
  for (const segment of ranges) {
    if (segment.startOffset > cursor) {
      gaps.push(sourceText.slice(cursor, segment.startOffset));
    }
    cursor = Math.max(cursor, segment.endOffset);
  }
  if (cursor < sourceText.length) {
    gaps.push(sourceText.slice(cursor));
  }
  return gaps.join("").replace(/\s/gu, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForDocument(
  repository: DocumentRepository,
  documentId: string,
  onTick: (done: number, total: number) => void
): Promise<void> {
  for (;;) {
    const progress = repository.getAnalysisProgress(documentId);
    if (!progress) {
      throw new Error(`文档丢失：${documentId}`);
    }
    onTick(progress.completedSegments + progress.failedSegments, progress.totalSegments);
    const document = repository.getById(documentId);
    if (document && document.status !== "analyzing") {
      return;
    }
    await sleep(2_000);
  }
}

function inspectSample(
  sample: CorpusSample,
  segments: SegmentView[],
  wallClockMs: number
): SampleReport {
  const categories = emptyTally();
  const politeness = new Set<string>();
  const speakers = new Set<string>();
  const boundaryMismatches: string[] = [];
  const failures: Array<{ segmentId: string; message: string }> = [];

  let tokens = 0;
  let completed = 0;
  let failed = 0;
  let confidenceNull = 0;
  let confidenceNumeric = 0;
  let confidenceLow = 0;
  let missingLemma = 0;
  let missingReading = 0;
  let missingExplanation = 0;

  for (const segment of segments) {
    if (segment.speaker) {
      speakers.add(segment.speaker);
    }
    if (segment.status === "completed") {
      completed += 1;
    }
    if (segment.status === "failed") {
      failed += 1;
      failures.push({ segmentId: segment.id, message: segment.errorMessage ?? "未知错误" });
      continue;
    }

    const analysis = segment.analysis;
    if (!analysis) {
      continue;
    }
    politeness.add(analysis.politeness ?? "（未提供）");

    const local = tokenizeJapanese(segment.text, segment.id);
    if (local.length !== analysis.tokens.length) {
      boundaryMismatches.push(
        `${segment.id}：本地分词 ${local.length} 个，模型返回 ${analysis.tokens.length} 个`
      );
      continue;
    }

    for (const [index, token] of analysis.tokens.entries()) {
      const boundary = local[index]!;
      tokens += 1;
      if (
        token.tokenId !== boundary.tokenId
        || token.startOffset !== boundary.startOffset
        || token.endOffset !== boundary.endOffset
        || token.surface !== boundary.surface
      ) {
        boundaryMismatches.push(
          `${segment.id} 第 ${index + 1} 个 token 不一致：本地「${boundary.surface}」/ 模型「${token.surface}」`
        );
        continue;
      }
      categories[token.category as TokenCategory] += 1;

      if (token.confidence === null) {
        confidenceNull += 1;
      } else {
        confidenceNumeric += 1;
        if (token.confidence < 0.5) {
          confidenceLow += 1;
        }
      }
      if (!token.lemma) {
        missingLemma += 1;
      }
      if (!token.reading) {
        missingReading += 1;
      }
      if (!token.explanation) {
        missingExplanation += 1;
      }
    }
  }

  const coverage = measureSourceCoverage(sample.text, segments);

  return {
    id: sample.id,
    title: sample.title,
    sourceCharacters: sample.text.length,
    coverage,
    missingGaps: describeMissingGaps(sample.text, segments),
    speakers: [...speakers],
    segments: segments.length,
    completed,
    failed,
    tokens,
    boundaryMismatches,
    categories,
    confidenceNull,
    confidenceNumeric,
    confidenceLow,
    politenessValues: [...politeness].sort(),
    missingLemma,
    missingReading,
    missingExplanation,
    failures,
    wallClockMs
  };
}

function renderReport(reports: SampleReport[]): string {
  const lines: string[] = [];
  lines.push("| 样本 | 原文字符 | 句段 | 成功 | 失败 | Token | 边界差异 | 耗时 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const report of reports) {
    lines.push(
      `| ${report.id} | ${report.sourceCharacters} | ${report.segments} | ${report.completed} | ${report.failed} | ${report.tokens} | ${report.boundaryMismatches.length} | ${(report.wallClockMs / 1000).toFixed(1)}s |`
    );
  }

  for (const report of reports) {
    lines.push("");
    lines.push(`### ${report.title}（${report.id}）`);
    lines.push("");
    lines.push(`- 说话人：${report.speakers.join("、") || "（无）"}`);
    lines.push(
      `- 覆盖率：${(report.coverage.coverageRatio * 100).toFixed(1)}%（缺失 ${report.coverage.missingNonWhitespace} / ${report.coverage.sourceNonWhitespace} 个非空白字符）`
    );
    lines.push(
      `- 遗漏片段（去空白后，应只含角色标签与冒号）：\`${report.missingGaps}\``
    );
    lines.push(
      `- 类别分布：word ${report.categories.word} / particle ${report.categories.particle} / functional ${report.categories.functional} / adverb ${report.categories.adverb} / grammar ${report.categories.grammar}`
    );
    lines.push(
      `- confidence：数值 ${report.confidenceNumeric} / 空 ${report.confidenceNull} / 低于 0.5 的 ${report.confidenceLow}`
    );
    lines.push(
      `- 字段缺失：lemma ${report.missingLemma} / reading ${report.missingReading} / explanation ${report.missingExplanation}`
    );
    lines.push(`- politeness 取值：${report.politenessValues.join("、") || "（无）"}`);
    if (report.boundaryMismatches.length > 0) {
      lines.push(`- 边界差异 ${report.boundaryMismatches.length} 处：`);
      for (const mismatch of report.boundaryMismatches.slice(0, 20)) {
        lines.push(`  - ${mismatch}`);
      }
    }
    if (report.failures.length > 0) {
      lines.push(`- 失败 ${report.failures.length} 个：`);
      for (const failure of report.failures.slice(0, 20)) {
        lines.push(`  - ${failure.segmentId}：${failure.message}`);
      }
    }
  }

  return lines.join("\n");
}

async function main(): Promise<void> {
  const corpusFile = path.resolve(process.cwd(), "../../docs/evaluation-corpus.md");
  // 只跑指定样本时用 NIHONGO_REGRESSION_ONLY=<样本 ID>，省下重跑全量费用的开销
  const only = process.env.NIHONGO_REGRESSION_ONLY?.trim();
  const allSamples = parseCorpus(corpusFile);
  if (allSamples.length === 0) {
    throw new Error(`未能从 ${corpusFile} 解析出样本`);
  }
  const samples = only
    ? allSamples.filter((sample) => sample.id.includes(only))
    : allSamples;
  if (samples.length === 0) {
    throw new Error(`NIHONGO_REGRESSION_ONLY=${only} 没有匹配到样本`);
  }
  console.error(
    `[regression] 解析到 ${samples.length} 篇样本：${samples.map((s) => `${s.id}(${s.text.length}字)`).join(", ")}`
  );
  console.error(`[regression] provider=${appConfig.llmProvider} model=${appConfig.llmModel} prompt=${appConfig.llmPromptVersion} batch=${appConfig.llmBatchSize}x${appConfig.llmBatchConcurrency} reasoning=${appConfig.llmReasoningEffort ?? "default"} maxTokens=${appConfig.llmMaxTokens}`);

  const database = await createDatabase(appConfig.databaseFile);
  const repository = new DocumentRepository(database);

  for (const sample of samples) {
    const preview = repository.create({
      title: `[dry-run] ${sample.id}`,
      sourceText: sample.text,
      targetLevel: "auto",
      contentType: "dialogue"
    });
    const coverage = measureSourceCoverage(sample.text, preview.segments);
    console.error(
      `[regression] ${sample.id} → ${preview.segments.length} 句段，覆盖率 ${(coverage.coverageRatio * 100).toFixed(1)}%，说话人 ${[...new Set(preview.segments.map((s) => s.speaker).filter((s): s is string => Boolean(s)))].join("、") || "（无）"}`
    );
    repository.delete(preview.id);
  }

  const providers = createProviderRegistry(appConfig);
  if (!providers.llm.current.configured) {
    database.close();
    throw new Error("LLM 未配置，无法运行回归");
  }

  const service = new AnalysisService(
    repository,
    providers.llm,
    await createContentDictionaryHolder(appConfig.contentDictId),
    new OllamaGlossTranslator({
      database,
      baseUrl: appConfig.contentDictTranslateBaseUrl,
      model: appConfig.contentDictTranslateModel,
      debugLogging: appConfig.llmDebugLogging,
      debugLogFile: appConfig.llmDebugLogFile,
      enabled: appConfig.contentDictTranslateEnabled
    }),
    appConfig.llmPromptVersion,
    appConfig.llmBatchSize,
    appConfig.llmBatchConcurrency
  );

  const reports: SampleReport[] = [];
  try {
    for (const sample of samples) {
      const startedAt = Date.now();
      const detail = repository.create({
        title: sample.id,
        sourceText: sample.text,
        targetLevel: "auto",
        contentType: "dialogue"
      });
      console.error(`[regression] 开始：${sample.id}（${detail.segments.length} 个句段）`);

      service.start(detail.id);
      let lastLogged = -1;
      await waitForDocument(repository, detail.id, (done, total) => {
        if (done !== lastLogged) {
          lastLogged = done;
          console.error(`[regression]   进度 ${done}/${total}`);
        }
      });

      const finished = repository.getById(detail.id);
      if (!finished) {
        throw new Error(`文档丢失：${detail.id}`);
      }
      const report = inspectSample(sample, finished.segments, Date.now() - startedAt);
      reports.push(report);
      console.error(
        `[regression] 完成：${sample.id} → 成功 ${report.completed} / 失败 ${report.failed} / 边界差异 ${report.boundaryMismatches.length} / 耗时 ${(report.wallClockMs / 1000).toFixed(1)}s`
      );
    }
  } finally {
    service.cancelAll();
    database.close();
  }

  const markdown = renderReport(reports);
  const outputFile = path.resolve(process.cwd(), "regression-report.md");
  fs.writeFileSync(outputFile, `${markdown}\n`, "utf8");
  console.log(markdown);
  console.error(`[regression] 报告已写入 ${outputFile}`);
}

main().catch((reason: unknown) => {
  console.error(reason instanceof Error ? reason.stack ?? reason.message : reason);
  process.exitCode = 1;
});
