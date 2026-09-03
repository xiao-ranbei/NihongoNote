/**
 * 词典覆盖率纯本地统计（设计文档 §六-6，零 LLM）。
 *
 *   pnpm --filter @nihongonote/api dictionary-coverage
 *
 * 内容词数据源由 CONTENT_DICT_ID 控制（默认 none，不引入内容层；
 * 设 jmdict-common 则叠加 JMdict 英文词库，覆盖率会明显上升）。
 * 该开关与生产链路同源（apps/api/src/dictionary/content）。
 *
 * 走真实数据库（apps/api/data/nihongonote.db），对每篇文章的每段
 * tokenizeJapanese + prepareSegmentTokens（与生产路径同源），统计：
 *   - 词典命中 token（source=dictionary, confidence=1.0）—— 永久免费
 *   - 未命中 token（仍需 AI 解释）
 *   - 覆盖率 + 按词性细分 + 按文章细分
 *   - 未命中 TOP N（指出离线扩充的方向）
 *
 * 不发任何 LLM 请求、不写数据库。退出码始终为 0（这是统计而非断言）。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { tokenizeJapanese } from "../src/tokenization.js";
import { prepareSegmentTokens } from "../src/segment-preparation.js";
import {
  getDictionaryStats,
  getDictionaryVersion
} from "../src/dictionary/lookup.js";
import {
  createContentDictionaryHolder
} from "../src/dictionary/content/index.js";
import type { ContentDictionaryProvider } from "../src/dictionary/content/types.js";

import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";

interface DocRow {
  id: string;
  title: string;
  status: string;
}

interface SegmentRow {
  id: string;
  text: string;
  status: string;
}

interface ArticleCoverage {
  id: string;
  title: string;
  status: string;
  segmentCount: number;
  tokenCount: number;
  matchedCount: number;
  unmissedCount: number;
  coverage: number; // matchedCount / tokenCount
  /** 段级未命中边界数（≥1 即此段仍需 AI） */
  segmentsNeedAi: number;
}

interface GlobalReport {
  dictionaryVersion: string;
  dictionaryStats: ReturnType<typeof getDictionaryStats>;
  documents: ArticleCoverage[];
  totals: {
    documents: number;
    segments: number;
    tokens: number;
    matched: number;
    unmissed: number;
    coverage: number;
  };
  /** 按词性细分（命中端） */
  categoryMatched: Record<string, number>;
  /** 未命中 token TOP N（surface → 次数），按降序 */
  unmissedTop: Array<{ surface: string; count: number }>;
  /** 段级未命中覆盖：多少段至少有一个未命中 token */
  segmentsNeedAiTotal: number;
}

function loadDocuments(db: SqlJsDatabase): DocRow[] {
  const result = db.exec(
    "SELECT id, title, status FROM documents ORDER BY created_at"
  );
  const first = result[0];
  if (!first) return [];
  return first.values.map((row) => ({
    id: String(row[0]),
    title: String(row[1]),
    status: String(row[2])
  }));
}

function loadSegments(db: SqlJsDatabase, documentId: string): SegmentRow[] {
  const result = db.exec(
    "SELECT id, text, status FROM segments WHERE document_id = ? ORDER BY segment_index",
    [documentId]
  );
  const first = result[0];
  if (!first) return [];
  return first.values.map((row) => ({
    id: String(row[0]),
    text: String(row[1]),
    status: String(row[2])
  }));
}

function topN<T>(items: T[], n: number, key: (item: T) => number): T[] {
  return [...items].sort((a, b) => key(b) - key(a)).slice(0, n);
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

async function buildReport(
  documents: DocRow[],
  db: SqlJsDatabase,
  contentDictionary: ContentDictionaryProvider | null
): Promise<GlobalReport> {
  const articles: ArticleCoverage[] = [];
  const unmissedCountBySurface = new Map<string, number>();
  const categoryMatched: Record<string, number> = {};
  let totalTokens = 0;
  let totalMatched = 0;
  let totalSegments = 0;
  let totalSegmentsNeedAi = 0;

  for (const doc of documents) {
    const segments = loadSegments(db, doc.id);
    const article: ArticleCoverage = {
      id: doc.id,
      title: doc.title,
      status: doc.status,
      segmentCount: segments.length,
      tokenCount: 0,
      matchedCount: 0,
      unmissedCount: 0,
      coverage: 0,
      segmentsNeedAi: 0
    };

    for (const segment of segments) {
      const boundaries = tokenizeJapanese(segment.text, segment.id);
      const { localTokens, llmBoundaries } = await prepareSegmentTokens(
        { ...segment, documentId: doc.id, index: 0, startOffset: 0, endOffset: 0, speaker: null, errorMessage: null } as never,
        boundaries,
        contentDictionary
      );
      const segTokens = localTokens.length + llmBoundaries.length;
      article.tokenCount += segTokens;
      article.matchedCount += localTokens.length;
      article.unmissedCount += llmBoundaries.length;
      if (llmBoundaries.length > 0) {
        article.segmentsNeedAi += 1;
        for (const boundary of llmBoundaries) {
          unmissedCountBySurface.set(
            boundary.surface,
            (unmissedCountBySurface.get(boundary.surface) ?? 0) + 1
          );
        }
      }
      for (const token of localTokens) {
        const cat = token.category ?? "unknown";
        categoryMatched[cat] = (categoryMatched[cat] ?? 0) + 1;
      }
    }

    article.coverage =
      article.tokenCount === 0 ? 0 : article.matchedCount / article.tokenCount;
    articles.push(article);

    totalTokens += article.tokenCount;
    totalMatched += article.matchedCount;
    totalSegments += article.segmentCount;
    totalSegmentsNeedAi += article.segmentsNeedAi;
  }

  const totalUnmissed = totalTokens - totalMatched;
  const unmissedTop = topN(
    [...unmissedCountBySurface.entries()].map(([surface, count]) => ({
      surface,
      count
    })),
    30,
    (item) => item.count
  );

  return {
    dictionaryVersion: getDictionaryVersion(),
    dictionaryStats: getDictionaryStats(),
    documents: articles,
    totals: {
      documents: documents.length,
      segments: totalSegments,
      tokens: totalTokens,
      matched: totalMatched,
      unmissed: totalUnmissed,
      coverage: totalTokens === 0 ? 0 : totalMatched / totalTokens
    },
    categoryMatched,
    unmissedTop,
    segmentsNeedAiTotal: totalSegmentsNeedAi
  };
}

function renderReport(report: GlobalReport, activeContentDict: string): string {
  const lines: string[] = [];
  const { totals, dictionaryStats, dictionaryVersion } = report;
  lines.push("============================================================");
  lines.push("词典覆盖率统计（纯本地，零 LLM）");
  lines.push("============================================================");
  lines.push(`词典版本：v${dictionaryVersion}`);
  lines.push(
    `固定用法库：助词 ${dictionaryStats.particles} · 功能词 ${dictionaryStats.functional} · 句末模板 ${dictionaryStats.endings} = ${dictionaryStats.total} 条`
  );
  lines.push(`内容词数据源（CONTENT_DICT_ID）：${activeContentDict}`);
  lines.push("");
  lines.push("【总计】");
  lines.push(`  文章数：${totals.documents}`);
  lines.push(`  段数：${totals.segments}`);
  lines.push(`  Token 总数：${totals.tokens}`);
  lines.push(
    `  命中：${totals.matched}（${formatPercent(totals.coverage)}） · 未命中：${totals.unmissed}`
  );
  lines.push(
    `  段级至少 1 个未命中 token：${report.segmentsNeedAiTotal} / ${totals.segments}（${formatPercent(
      totals.segments === 0 ? 0 : report.segmentsNeedAiTotal / totals.segments
    )}）`
  );
  lines.push("");
  lines.push("【按文章细分】");
  const titleWidth = Math.max(...report.documents.map((d) => d.title.length), 4);
  lines.push(
    `  ${"标题".padEnd(titleWidth)}  ${"状态".padEnd(4)}  ${"段".padStart(3)}  ${"token".padStart(5)}  ${"命中".padStart(5)}  ${"未中".padStart(5)}  ${"覆盖".padStart(7)}  ${"需AI段".padStart(7)}`
  );
  for (const article of report.documents) {
    lines.push(
      `  ${article.title.padEnd(titleWidth)}  ${article.status.padEnd(4)}  ${String(
        article.segmentCount
      ).padStart(3)}  ${String(article.tokenCount).padStart(5)}  ${String(
        article.matchedCount
      ).padStart(5)}  ${String(article.unmissedCount).padStart(5)}  ${formatPercent(
        article.coverage
      ).padStart(7)}  ${String(article.segmentsNeedAi).padStart(7)}`
    );
  }
  lines.push("");
  lines.push("【命中 token 按词性细分】");
  const categoryEntries = Object.entries(report.categoryMatched).sort(
    (a, b) => b[1] - a[1]
  );
  for (const [category, count] of categoryEntries) {
    lines.push(`  ${category.padEnd(12)} ${String(count).padStart(5)}`);
  }
  lines.push("");
  lines.push("【未命中 TOP 30（surface → 次数，扩充方向）】");
  if (report.unmissedTop.length === 0) {
    lines.push("  （无未命中 token）");
  } else {
    const surfaceWidth = Math.max(
      ...report.unmissedTop.map((item) => item.surface.length),
      2
    );
    for (const item of report.unmissedTop) {
      lines.push(`  ${item.surface.padEnd(surfaceWidth)}  ${item.count}`);
    }
  }
  lines.push("");
  lines.push("============================================================");
  lines.push("结论：");
  lines.push(
    `  - 现固定库覆盖 ${formatPercent(totals.coverage)} 的 token，省下 ${
      totals.matched
    } 次 AI 解释调用`
  );
  lines.push(
    `  - 仍有 ${totals.unmissed} 个 token（${report.segmentsNeedAiTotal} 个段）需 AI 兜底`
  );
  lines.push(
    `  - 「仅词典分析」对未命中 token 段不写解释字段（段级全 null），保持解析卡可读`
  );
  lines.push("============================================================");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const dbPath = path.resolve(
    process.cwd(),
    process.env.NIHONGO_DATA_DIR ?? "./data",
    "nihongonote.db"
  );
  if (!fs.existsSync(dbPath)) {
    console.error(`数据库 ${dbPath} 不存在。`);
    process.exit(1);
  }
  const SQL = await initSqlJs();
  const fileBuffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(fileBuffer);
  let activeContentDict = "none";
  try {
    const documents = loadDocuments(db);
    if (documents.length === 0) {
      console.error(`数据库 ${dbPath} 中无 documents，请先创建文章。`);
      process.exit(1);
    }
    const holder = await createContentDictionaryHolder(process.env.CONTENT_DICT_ID);
    activeContentDict = holder.current.id;
    const report = await buildReport(documents, db, holder.current);
    console.log(renderReport(report, activeContentDict));
  } finally {
    db.close();
  }
}

await main();
