/**
 * 内容词词典层契约（设计文档 docs/jmdict-integration-design.md）。
 *
 * 与固定用法库（dictionary/data.ts）的分工：
 * - 固定用法库 = 日语语言知识（助词/功能词/寒暄），人工维护，中文教学式解释；
 * - 内容词层 = 词汇表（名词/动词/形容词），自动导入，量大、跨语料。
 *
 * 本文件只定义契约，不含任何具体数据源——数据源以适配器形式实现并注册，
 * 主链路（segment-preparation / analysis-service）不感知具体来源。
 */

/** 一条释义。同一条目可并存多语言（如 JMdict 英文 + 本地译中）。 */
export interface ContentGloss {
  /** BCP 47 语言标记：en / zh / ja */
  lang: string;
  text: string;
}

/** 词典层返回的内容词条目。 */
export interface ContentWordEntry {
  /** 实际命中的词形（surface 或 lemma） */
  surface: string;
  reading: string | null;
  /** 词性，各源格式不同，统一为字符串数组 */
  partsOfSpeech: string[];
  /** 至少一条；同一语言可多条 */
  glosses: ContentGloss[];
  /** 来源标识（如 "jmdict"），供未来 UI 徽标与统计使用 */
  source: string;
  /** 命中方式：surface 直击 / lemma 回退 */
  matchedBy: "surface" | "lemma";
}

export interface ContentDictionaryStats {
  entries: number;
  loaded: boolean;
  version: string | null;
  license: string | null;
}

export interface ContentLookupQuery {
  surface: string;
  /** kuromoji 原形；无形态素对齐结果时为 null */
  lemma?: string | null;
}

/**
 * 内容词词典层契约。
 *
 * 实现必须满足（verify 会断言）：
 * - lookup 未命中返回 null，**绝不编造释义**（与固定用法库同律）；
 * - initialize 幂等，可重复调用；
 * - 只读查询，无共享可变状态；
 * - initialize 抛错由工厂/调用方回落到空实现，不阻断分析。
 */
export interface ContentDictionaryProvider {
  readonly id: string;
  readonly label: string;
  ready(): boolean;
  initialize(): Promise<void>;
  lookup(query: ContentLookupQuery): ContentWordEntry | null;
  stats(): ContentDictionaryStats;
}

/**
 * 内容词层命中落到 TokenAnalysis 时的置信度。
 *
 * 低于固定用法库（1.0）——自动导入、单词级对译、可能有多义；
 * 高于 LLM 兜底——毕竟来自人工编纂的词典。
 */
export const contentDictionaryConfidence = 0.8;

/** 展示语言优先级：中文 > 日文 > 英文（本项目面向中文用户）。 */
const displayLanguageOrder = ["zh", "ja", "en"];

/** 挑首选展示释义：zh > ja > en，全无则返回 null。 */
export function preferredGloss(entry: ContentWordEntry): ContentGloss | null {
  for (const lang of displayLanguageOrder) {
    const hit = entry.glosses.find((gloss) => gloss.lang === lang);
    if (hit) {
      return hit;
    }
  }
  return null;
}

/** 把同一语言的全部释义拼成一行（多义项用全角分号分隔）。 */
export function joinGlosses(entry: ContentWordEntry, lang: string): string {
  return entry.glosses
    .filter((gloss) => gloss.lang === lang)
    .map((gloss) => gloss.text)
    .join("；");
}
