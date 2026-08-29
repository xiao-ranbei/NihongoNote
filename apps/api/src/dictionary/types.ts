import type { TokenCategory } from "@nihongonote/core";

/**
 * 词典条目的来源。
 *
 * - fixed：固定用法库（人工维护，confidence=1.0）
 * - user-confirmed：用户确认回填（步骤 5 启用，confidence=0.9）
 *
 * 两者对外都标记为 source=dictionary（与 TokenAnalysis.source 对齐，
 * 见设计文档 3.7），区别只体现在数据内部的可追溯性。
 */
export type DictionaryOrigin = "fixed" | "user-confirmed";

/**
 * 一条固定用法库条目。
 *
 * 与 `TokenAnalysis` 对齐（surface/category/reading/gloss/explanation），
 * 但刻意不含 tokenId/startOffset/endOffset 等定位字段——
 * 定位信息由 token 边界提供，词典只管「解释层」（设计文档 3.7 瘦身存储）。
 */
export interface DictionaryEntry {
  /** 查表键：表层形式。助词/功能词一个 surface 一条 */
  surface: string;
  category: TokenCategory;
  /** 读音；助词等读音即表层的可置 null，由形态素层填充 */
  reading: string | null;
  /** 简短中文对译（UI 悬浮卡片用） */
  gloss: string | null;
  /** 面向学习者的解释（含主要用法与简短例句） */
  explanation: string;
  /** 固定用法库 1.0；用户回填 0.9 */
  confidence: number;
  origin: DictionaryOrigin;
}

/** 查表命中结果 = 条目本体 + 对外统一的来源标记。 */
export type DictionaryHit = DictionaryEntry & { source: "dictionary" };

/**
 * 句末语气模板（词典化兜底，设计文档 3.4）。
 *
 * 命中时可为简单句提供参考语气/礼貌度，覆盖有限的场景
 * （～ますね/～でしょう…），从而省去整段对简单句的 AI 调用。
 * 独立于 TokenAnalysis：它匹配的是「句末连续串」，不是单个 token。
 */
export interface SentenceEndingTemplate {
  /** 匹配键：句末连续串，如「ますね」「でしょう」 */
  surface: string;
  politeness: "formal" | "casual";
  /** 语气描述，如「确认/征求同意」「推测」「提议」 */
  tone: string;
  explanation: string;
}

/**
 * 词典版本。与 promptVersion 并列，保证结果可追溯（设计文档 3.3）。
 * 固定用法库内容更新时递增。
 */
export const dictionaryVersion = "1.0.0";
