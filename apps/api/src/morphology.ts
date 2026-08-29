import { createRequire } from "node:module";
import path from "node:path";

import type { TokenCategory } from "@nihongonote/core";
import kuromoji, { type IpadicFeatures } from "kuromoji";

const require = createRequire(import.meta.url);
const kuromojiRoot = path.dirname(require.resolve("kuromoji/package.json"));
const dicPath = path.join(kuromojiRoot, "dict");

/**
 * 形态素分析层（设计文档 3.2，决策 1：kuromoji.js）。
 *
 * 职责：确定性产出 token 的「纯语言学事实」字段——
 *   lemma（原形）/ reading（读音）/ partOfSpeech（词性）/ conjugation（活用形）。
 * 这四个字段是本地可确定的，不需要 LLM 参与，从而砍掉约 30% 的 AI 输出字段。
 *
 * 边界决策（2026-08-29 实测对比，见 docs/analysis-tools-design.md §六-2）：
 * kuromoji 对动词连用形/复合助动词系统性地单飞（勉強|し|て|い|ます、でしょ|う），
 * 且 IPADIC 仍把「かって」「お」等拆开——它不能单独满足 T-1 分词期望。
 * 因此 **token 边界继续使用 tokenization.ts 的合并后处理**，
 * 本模块只负责按偏移区间为 token 提供事实字段（步骤 3 接入三层链路）。
 */

export interface MorphologyToken {
  surface: string;
  /** UTF-16 0-based 偏移，与现有 token 定位协议一致 */
  startOffset: number;
  endOffset: number;
  /** 原形（basic_form）；未登录词退化为 surface */
  lemma: string;
  /** 读音（kuromoji 输出片假名）；无读音时为 null */
  reading: string | null;
  /** 词性，格式「助詞-格助詞」「名詞-一般」；无细分时只有大类 */
  partOfSpeech: string;
  /** 活用形（如 連用形/未然形）；无活用时为 null */
  conjugation: string | null;
}

let tokenizerPromise: Promise<kuromoji.Tokenizer<IpadicFeatures>> | null = null;

function getTokenizer(): Promise<kuromoji.Tokenizer<IpadicFeatures>> {
  if (tokenizerPromise === null) {
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath }).build((error, tokenizer) => {
        if (error) {
          reject(error);
        } else {
          resolve(tokenizer);
        }
      });
    });
  }
  return tokenizerPromise;
}

/**
 * 对整段文本做形态素分析（不含标点等记号 token）。
 *
 * 注意：本函数返回的是 kuromoji 的「细粒度」切分，不是最终 token 边界。
 * 上层应按偏移区间与本地的 tokenBoundary 对齐后取字段（见 alignMorphology）。
 */
export async function tokenizeWithMorphology(text: string): Promise<MorphologyToken[]> {
  const tokenizer = await getTokenizer();
  const tokens: MorphologyToken[] = [];

  for (const feature of tokenizer.tokenize(text)) {
    // 记号（句点/読点/括弧…）与 Intl.Segmenter 的 isWordLike=false 对齐，跳过
    if (feature.pos === "記号") {
      continue;
    }
    const startOffset = (feature.word_position ?? 1) - 1;
    tokens.push({
      surface: feature.surface_form,
      startOffset,
      endOffset: startOffset + feature.surface_form.length,
      lemma: feature.basic_form || feature.surface_form,
      reading:
        feature.reading && feature.reading !== feature.surface_form
          ? feature.reading
          : null,
      partOfSpeech:
        feature.pos_detail_1 && feature.pos_detail_1 !== "*"
          ? `${feature.pos}-${feature.pos_detail_1}`
          : feature.pos,
      conjugation:
        feature.conjugated_form && feature.conjugated_form !== "*"
          ? feature.conjugated_form
          : null
    });
  }

  return tokens;
}

/**
 * pos 大类 → TokenCategory 映射（用于步骤 3 填 category）。
 *
 * 规则：
 * - 助詞 → particle（双线）
 * - 助動詞/接続詞/連体詞/感動詞/接頭詞/接尾詞 → functional（虚线）
 * - 副詞 → adverb（点线）
 * - 其余（名詞/動詞/形容詞/その他）→ word（实线）
 */
export function categoryForPos(pos: string): TokenCategory {
  switch (pos) {
    case "助詞":
      return "particle";
    case "助動詞":
    case "接続詞":
    case "連体詞":
    case "感動詞":
    case "接頭詞":
    case "接尾詞":
      return "functional";
    case "副詞":
      return "adverb";
    default:
      return "word";
  }
}

/**
 * 把 kuromoji 的细粒度 token 与本地 token 边界对齐（步骤 3 使用）。
 *
 * 对齐规则：对每个本地 token（按偏移区间），收集与其区间有交叠的
 * 形态素 token，取「第一个非助词/助动词 token」的事实字段作为代表；
 * 全部是助词/助动词时取第一个 token。
 *
 * 安全约束：代表 token 的 surface 必须是本地 token surface 的前缀
 * （或相等），否则不填充——例如「でしょう」被本地切成 で|しょう，
 * 而 kuromoji 切 でしょ|う，「で」的重叠代表是 でしょ（不是前缀），
 * 说明本地边界与形态素边界不一致，宁可不填交 LLM 兜底，也不填错。
 *
 * 返回 Map<tokenId, MorphologyToken>，未命中/不自信的 tokenId
 * 不存在于 Map 中（由 LLM 兜底）。
 */
export function alignMorphology(
  boundaries: Array<{ tokenId: string; startOffset: number; endOffset: number; surface: string }>,
  morphology: MorphologyToken[]
): Map<string, MorphologyToken> {
  const aligned = new Map<string, MorphologyToken>();

  for (const boundary of boundaries) {
    // 与当前边界区间有交叠的形态素 token
    const overlapping = morphology.filter(
      (token) =>
        token.startOffset < boundary.endOffset
        && token.endOffset > boundary.startOffset
    );
    if (overlapping.length === 0) {
      continue;
    }

    const representative =
      overlapping.find((token) => token.partOfSpeech !== "助詞" && token.partOfSpeech !== "助動詞")
      ?? overlapping[0]!;

    // 前缀安全约束：形态素切分应落在本地 token 的词干上
    if (!boundary.surface.startsWith(representative.surface)) {
      continue;
    }

    aligned.set(boundary.tokenId, representative);
  }

  return aligned;
}
