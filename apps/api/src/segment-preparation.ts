import type { Segment, TokenAnalysis } from "@nihongonote/core";

import { lookupToken } from "./dictionary/lookup.js";
import { alignMorphology, tokenizeWithMorphology } from "./morphology.js";
import type { TokenBoundary } from "./tokenization.js";

/**
 * 三层链路的本地预处理层（设计文档 3.1 的 ①② 层，零 token）。
 *
 * 从 analysis-service 独立出来，供分析服务（processBatch 落库）与
 * 工具页预览（analysis-preview，纯本地统计）共用，避免循环依赖。
 */

export interface PreparedSegmentTokens {
  /** 词典/形态素命中的 token（本地确定，不进 LLM） */
  localTokens: TokenAnalysis[];
  /** 未命中的 token 边界（LLM 只处理这些） */
  llmBoundaries: TokenBoundary[];
}

/**
 * 形态素对齐填充事实字段 + 固定用法库查表命中解释层。
 *
 * 命中规则：
 * - 词典命中 → 构造瘦身 TokenAnalysis（source=dictionary，省略恒定 null 字段）；
 *   事实字段（lemma/reading/partOfSpeech/conjugation）优先取形态素对齐结果；
 * - 未命中 → 该 token 进入 LLM 候选（llmBoundaries）。
 */
export async function prepareSegmentTokens(
  segment: Segment,
  boundaries: TokenBoundary[]
): Promise<PreparedSegmentTokens> {
  const morphology = await tokenizeWithMorphology(segment.text);
  const aligned = alignMorphology(boundaries, morphology);

  const localTokens: TokenAnalysis[] = [];
  const llmBoundaries: TokenBoundary[] = [];

  for (const boundary of boundaries) {
    const dictHit = lookupToken(boundary.surface);
    if (!dictHit) {
      llmBoundaries.push(boundary);
      continue;
    }
    const morph = aligned.get(boundary.tokenId);
    localTokens.push({
      tokenId: boundary.tokenId,
      startOffset: boundary.startOffset,
      endOffset: boundary.endOffset,
      surface: boundary.surface,
      category: dictHit.category,
      lemma: morph?.lemma ?? null,
      reading: morph?.reading ?? dictHit.reading ?? null,
      partOfSpeech: morph?.partOfSpeech ?? null,
      conjugation: morph?.conjugation ?? null,
      gloss: dictHit.gloss,
      explanation: dictHit.explanation,
      confidence: dictHit.confidence,
      source: "dictionary"
    });
  }

  return { localTokens, llmBoundaries };
}
