/**
 * 固定用法库差距分析（纯本地，零 LLM）。
 *
 *   pnpm --filter @nihongonote/api dictionary-gap
 *
 * 目的：给「扩充固定用法库」提供量化依据。把 coverage 脚本报出的全部
 * 未命中 token 分成两类——
 *
 *   A. 可入固定库候选：kuromoji 词性属助词/助动词/感动词/接头接尾等
 *      功能层，或分词 fragment 疑似固定表达（ありがとうござい…），
 *      扩充后永久省一次 AI 调用。
 *   C. 内容词：名词/专名/数词/动词/形容词/外来语。固定用法库
 *      （助词+功能词+句末模板）职责外，扩充救不了，只能靠主词典或 LLM。
 *
 * 每个候选附一条真实原文例句，供人工撰写释义时参考。
 * 不发 LLM 请求、不写数据库，退出码恒 0（统计脚本）。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { tokenizeJapanese } from "../src/tokenization.js";
import { prepareSegmentTokens } from "../src/segment-preparation.js";
import { tokenizeWithMorphology } from "../src/morphology.js";

import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";

interface SegmentRow {
  id: string;
  documentId: string;
  text: string;
}

interface SurfaceStat {
  surface: string;
  count: number;
  /** 第一处出现的原文段（截断），供撰写释义用 */
  example: string;
  /** 出现过的文档 id 集合——用于算文档频率 df（跨语料复用度） */
  documentIds: Set<string>;
}

interface CandidateGroup {
  /** 与固定库职能同层：助词/助动词/感动词等，明确可入 functional/particle */
  inScope: Map<string, SurfaceStat>;
  /** 分词 fragment：本地合并/截断产物，疑似固定表达，需人工逐条看 */
  fragment: Map<string, SurfaceStat>;
}

function loadSegments(db: SqlJsDatabase): SegmentRow[] {
  const result = db.exec(
    `SELECT s.id, s.document_id, s.text
       FROM segments s
       JOIN documents d ON d.id = s.document_id
      ORDER BY d.created_at, s.segment_index`
  );
  const first = result[0];
  if (!first) return [];
  return first.values.map((row) => ({
    id: String(row[0]),
    documentId: String(row[1]),
    text: String(row[2])
  }));
}

/** 内容词大类（固定库职责外）。其余词性走候选。 */
const contentPos = new Set([
  "名詞",
  "動詞",
  "形容詞",
  "形容動詞",
  "副詞",
  "その他"
]);

function bump(
  map: Map<string, SurfaceStat>,
  surface: string,
  exampleText: string,
  documentId: string
): void {
  const existing = map.get(surface);
  if (existing) {
    existing.count += 1;
    existing.documentIds.add(documentId);
  } else {
    map.set(surface, {
      surface,
      count: 1,
      example: exampleText,
      documentIds: new Set([documentId])
    });
  }
}

/** 数字/纯符号 → 内容词（不是固定用法）。 */
function looksNumeric(surface: string): boolean {
  return /^[0-9０-９一二三四五六七八九十百千万億]+$/u.test(surface);
}

async function buildGap(segments: SegmentRow[]): Promise<{
  content: Map<string, SurfaceStat>;
  candidates: CandidateGroup;
  totalUnmissed: number;
  /** 语料 token 总数（含已命中），用于把「补 N 条」换算成覆盖率 pp */
  totalTokens: number;
  /** 语料文档数，df 的分母 */
  docCount: number;
}> {
  const content = new Map<string, SurfaceStat>();
  const candidates: CandidateGroup = { inScope: new Map(), fragment: new Map() };
  const documentIds = new Set<string>();
  let totalUnmissed = 0;
  let totalTokens = 0;

  for (const segment of segments) {
    documentIds.add(segment.documentId);
    const boundaries = tokenizeJapanese(segment.text, segment.id);
    const { localTokens, llmBoundaries } = await prepareSegmentTokens(
      {
        id: segment.id,
        documentId: segment.documentId,
        text: segment.text,
        index: 0,
        startOffset: 0,
        endOffset: 0,
        speaker: null,
        errorMessage: null,
        status: "draft"
      } as never,
      boundaries
    );
    totalTokens += localTokens.length + llmBoundaries.length;
    if (llmBoundaries.length === 0) {
      continue;
    }
    // 例句取该段前 60 字符（utf16 安全截断由 slice 处理）
    const example = segment.text.length > 60
      ? `${segment.text.slice(0, 60)}…`
      : segment.text;

    for (const boundary of llmBoundaries) {
      const surface = boundary.surface;
      totalUnmissed += 1;

      if (looksNumeric(surface)) {
        bump(content, surface, example, segment.documentId);
        continue;
      }

      const morphology = await tokenizeWithMorphology(surface);
      const firstMorph = morphology[0];
      const wholeWord =
        morphology.length === 1 && firstMorph !== undefined && firstMorph.surface === surface
          ? firstMorph
          : null;

      if (wholeWord) {
        // partOfSpeech 形如「名詞-普通名詞」「助詞-格助詞」，取大类判定
        const posMain = wholeWord.partOfSpeech.split("-")[0] as string;
        if (contentPos.has(posMain)) {
          bump(content, surface, example, segment.documentId);
        } else {
          bump(candidates.inScope, surface, example, segment.documentId);
        }
      } else {
        bump(candidates.fragment, surface, example, segment.documentId);
      }
    }
  }

  return { content, candidates, totalUnmissed, totalTokens, docCount: documentIds.size };
}

function renderStat(map: Map<string, SurfaceStat>): string {
  const entries = [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  if (entries.length === 0) {
    return "  （无）\n";
  }
  const lines: string[] = [];
  const width = Math.max(...entries.map(([, stat]) => stat.surface.length), 4);
  for (const [surface, stat] of entries) {
    lines.push(
      `  ${surface.padEnd(width)}  ${String(stat.count).padStart(4)}  例：${stat.example}`
    );
  }
  return `${lines.join("\n")}\n`;
}

function summarize(
  map: Map<string, SurfaceStat>,
  label: string,
  totalUnmissed: number
): string {
  const count = [...map.values()].reduce((sum, stat) => sum + stat.count, 0);
  const pct = totalUnmissed === 0 ? 0 : (count / totalUnmissed) * 100;
  return `  ${label}：${map.size} surface / ${count} token（占未命中 ${pct.toFixed(1)}%）`;
}

/**
 * 内容词复用度分析（回答「内容词该不该进固定库」）。
 *
 * 真正的分界线不是「意思是否固定」——名词的意思同样固定——而是：
 * - df（出现在几篇文档）：高 = 跨语料稳定的通用词；df=1 = 单篇专有，
 *   换一篇就失效，补了只对本语料有效；
 * - 词表规模 → 覆盖率曲线：手工补 N 条能拿多少 pp，边际收益一眼可见。
 */
function renderContentReuse(
  content: Map<string, SurfaceStat>,
  totalTokens: number,
  docCount: number
): string {
  const stats = [...content.values()].sort((a, b) => b.count - a.count);
  const lines: string[] = [];
  lines.push("------------------------------------------------------------");
  lines.push(`C1. 内容词跨文档复用度（df = 出现在几篇文档；语料共 ${docCount} 篇）`);
  lines.push("------------------------------------------------------------");
  for (let df = docCount; df >= 1; df -= 1) {
    const group = stats.filter((stat) => stat.documentIds.size === df);
    if (group.length === 0) {
      continue;
    }
    const token = group.reduce((sum, stat) => sum + stat.count, 0);
    const note = df === docCount
      ? " ← 跨篇稳定，通用词候选"
      : df === 1
        ? " ← 单篇专有，换语料即失效"
        : "";
    lines.push(
      `  df=${df}：${String(group.length).padStart(3)} surface / ${String(token).padStart(3)} token${note}`
    );
  }

  lines.push("\n  【词表规模 → 覆盖率收益】（按频次降序取 top N，手工补条目）");
  const checkpoints = [10, 20, 50, 100, stats.length].filter(
    (n, index, arr) => n <= stats.length && arr.indexOf(n) === index
  );
  for (const n of checkpoints) {
    const covered = stats.slice(0, n).reduce((sum, stat) => sum + stat.count, 0);
    const pp = totalTokens === 0 ? 0 : (covered / totalTokens) * 100;
    lines.push(
      `  top ${String(n).padStart(3)} 条：+${pp.toFixed(1)} pp（${covered} token）` +
      (n === stats.length ? "  ← 全部补完的天花板" : "")
    );
  }

  const general = stats.filter((stat) => stat.documentIds.size >= 3);
  lines.push(`\n  【df≥3 通用候选（${general.length} 条）】`);
  if (general.length === 0) {
    lines.push("  （无）");
  } else {
    const width = Math.max(...general.map((stat) => stat.surface.length), 4);
    for (const stat of general) {
      lines.push(
        `  ${stat.surface.padEnd(width)}  ${String(stat.count).padStart(3)} 次  ${stat.documentIds.size}/${docCount} 篇`
      );
    }
  }
  lines.push("");
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
  try {
    const segments = loadSegments(db);
    if (segments.length === 0) {
      console.error(`数据库 ${dbPath} 中无 segments。`);
      process.exit(1);
    }
    const gap = await buildGap(segments);

    const inScopeCount = [...gap.candidates.inScope.values()].reduce(
      (s, stat) => s + stat.count,
      0
    );
    const fragmentCount = [...gap.candidates.fragment.values()].reduce(
      (s, stat) => s + stat.count,
      0
    );
    const contentCount = [...gap.content.values()].reduce(
      (s, stat) => s + stat.count,
      0
    );

    const lines: string[] = [];
    lines.push("============================================================");
    lines.push("固定用法库差距分析（纯本地，零 LLM）");
    lines.push("============================================================");
    lines.push(`未命中 token 总数：${gap.totalUnmissed}\n`);
    lines.push("【分类汇总】");
    lines.push(summarize(gap.candidates.inScope, "A. 可入固定库（词性同层：助词/助动词/感动词等）", gap.totalUnmissed));
    lines.push(summarize(gap.candidates.fragment, "B. 分词 fragment（疑似固定表达，需人工逐条看）", gap.totalUnmissed));
    lines.push(summarize(gap.content, "C. 内容词（名词/专名/数词/动词等，固定库职责外）", gap.totalUnmissed));
    const hopeful = inScopeCount + fragmentCount;
    lines.push(
      `\n  若 A+B 全部入固定库：可再省 ${hopeful} 次 AI 调用` +
      `（占未命中 ${gap.totalUnmissed === 0 ? 0 : ((hopeful / gap.totalUnmissed) * 100).toFixed(1)}%）`
    );

    lines.push("\n------------------------------------------------------------");
    lines.push("A. 可入固定库候选（surface | 次数 | 原文例句）");
    lines.push("------------------------------------------------------------");
    lines.push(renderStat(gap.candidates.inScope));

    lines.push("------------------------------------------------------------");
    lines.push("B. 分词 fragment（疑似固定表达，需人工复核后入句末模板/功能词）");
    lines.push("------------------------------------------------------------");
    lines.push(renderStat(gap.candidates.fragment));

    lines.push(renderContentReuse(gap.content, gap.totalTokens, gap.docCount));

    lines.push("------------------------------------------------------------");
    lines.push("C. 内容词 TOP 40（固定库职责外，仅供了解语料构成）");
    lines.push("------------------------------------------------------------");
    const contentEntries = [...gap.content.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 40);
    lines.push(
      contentEntries.length === 0
        ? "  （无）"
        : contentEntries
            .map(([, stat]) => `  ${stat.surface}  ${stat.count}`)
            .join("\n")
    );
    lines.push("\n============================================================");
    console.log(lines.join("\n"));
  } finally {
    db.close();
  }
}

await main();
