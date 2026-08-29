import { functionalEntries, particleEntries, sentenceEndingTemplates } from "./data.js";
import type { DictionaryHit, SentenceEndingTemplate } from "./types.js";
import { dictionaryVersion } from "./types.js";

/**
 * 固定用法库查表服务（设计文档 3.3，纯本地、零 token）。
 *
 * 职责：给定 token 表层形式或句末文本，查固定用法库与（未来的）
 * 用户确认回填缓存，命中返回 DictionaryHit，未命中返回 null——
 * 未命中绝不编造解释，由上层走 LLM 兜底。
 *
 * 注意：本服务只匹配「表层形式」。token 的 lemma/reading/partOfSpeech
 * 等事实字段由形态素分析层（kuromoji，步骤 2）填充，不在此处。
 */

/** 参与查表的条目集合（固定库起步；步骤 5 回填缓存并入）。 */
const lookupEntries: DictionaryHit[] = [
  ...particleEntries,
  ...functionalEntries
].map((entry) => ({ ...entry, source: "dictionary" as const }));

/** surface → 条目 索引（同类内无重复由 verify 断言保证）。 */
const indexBySurface = new Map<string, DictionaryHit>();
for (const entry of lookupEntries) {
  indexBySurface.set(entry.surface, entry);
}

/** 句末模板按长度降序，匹配时取最长命中。 */
const sortedEndingTemplates = [...sentenceEndingTemplates]
  .sort((a, b) => b.surface.length - a.surface.length);

/**
 * 查表：给定 token 表层形式，返回词典命中或 null。
 *
 * 用法：
 *   lookupToken("の")   → particle 命中（confidence=1.0, source=dictionary）
 *   lookupToken("ます") → functional 命中
 *   lookupToken("コンピュータ") → null（未命中，交 LLM）
 */
export function lookupToken(surface: string): DictionaryHit | null {
  return indexBySurface.get(surface) ?? null;
}

/**
 * 句末语气模板匹配（词典化兜底，设计文档 3.4）。
 *
 * 给定句段文本，从最长模板开始检查结尾，命中返回模板，未命中返回 null。
 * 供「仅词典分析」与简单句整段免 AI 使用。
 */
export function lookupSentenceEnding(text: string): SentenceEndingTemplate | null {
  for (const template of sortedEndingTemplates) {
    if (text.endsWith(template.surface)) {
      return template;
    }
  }
  return null;
}

/** 词典版本号（与 promptVersion 并列，保证结果可追溯）。 */
export function getDictionaryVersion(): string {
  return dictionaryVersion;
}

export interface DictionaryStats {
  particles: number;
  functional: number;
  endings: number;
  total: number;
}

/** 固定用法库规模统计（工具页预览「词典覆盖」与 verify 断言用）。 */
export function getDictionaryStats(): DictionaryStats {
  return {
    particles: particleEntries.length,
    functional: functionalEntries.length,
    endings: sentenceEndingTemplates.length,
    total: lookupEntries.length
  };
}
