import type { Segment, TokenAnalysis } from "@nihongonote/core";

import { lookupToken } from "./dictionary/lookup.js";
import type { ContentDictionaryProvider } from "./dictionary/content/types.js";
import {
  contentDictionaryConfidence,
  joinGlosses,
  preferredGloss
} from "./dictionary/content/types.js";
import { alignMorphology, tokenizeWithMorphology } from "./morphology.js";
import type { TokenBoundary } from "./tokenization.js";

/**
 * 本地预处理层（固定用法库 + 形态素 + 可选内容词词典层，零 token）。
 *
 * 从 analysis-service 独立出来，供分析服务（processBatch 落库）与
 * 工具页预览（analysis-preview，纯本地统计）共用，避免循环依赖。
 *
 * 链路：①固定用法库 → ②形态素事实字段 → ③内容词词典层（可选）→ ④LLM。
 * ③ 未配置时（默认 none）完全不生效，行为与接入前一致。
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
  boundaries: TokenBoundary[],
  contentDictionary?: ContentDictionaryProvider | null
): Promise<PreparedSegmentTokens> {
  const morphology = await tokenizeWithMorphology(segment.text);
  const aligned = alignMorphology(boundaries, morphology);

  const localTokens: TokenAnalysis[] = [];
  const llmBoundaries: TokenBoundary[] = [];

  for (const boundary of boundaries) {
    const dictHit = lookupToken(boundary.surface);
    const morph = aligned.get(boundary.tokenId);

    if (!dictHit) {
      /*
       * 第③层：内容词词典层（可选）。surface 直击 → lemma 回退，
       * 两级都未命中才落 LLM。未配置数据源时 contentDictionary 为
       * undefined/null 或 ready()=false，此分支不生效。
       */
      const contentHit = contentDictionary?.ready()
        ? contentDictionary.lookup({
            surface: boundary.surface,
            lemma: morph?.lemma ?? null
          })
        : null;

      if (contentHit) {
        const gloss = preferredGloss(contentHit);
        localTokens.push({
          tokenId: boundary.tokenId,
          startOffset: boundary.startOffset,
          endOffset: boundary.endOffset,
          surface: boundary.surface,
          category: "word",
          lemma: morph?.lemma ?? contentHit.surface,
          reading: morph?.reading ?? contentHit.reading ?? null,
          partOfSpeech: morph?.partOfSpeech ?? contentHit.partsOfSpeech[0] ?? null,
          conjugation: morph?.conjugation ?? null,
          gloss: gloss?.text ?? null,
          explanation: gloss ? joinGlosses(contentHit, gloss.lang) : null,
          confidence: contentDictionaryConfidence,
          source: "dictionary"
        });
        continue;
      }

      llmBoundaries.push(boundary);
      continue;
    }
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
