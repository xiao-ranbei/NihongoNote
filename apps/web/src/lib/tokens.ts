import type { TokenAnalysis, TokenCategory } from "@nihongonote/core";

/**
 * token 展示层的派生逻辑（S0 拆分自 App.tsx）。
 *
 * 这里只决定「画成什么类别」，不持有状态、不发请求。
 * P1 增强的范围标注（docs/p1-enhancement-design.md §五）会在此基础上
 * 追加「按 token 标记范围归属」的纯函数，届时也放这里。
 */

export function getTokenCategory(token: TokenAnalysis): TokenCategory {
  if (token.category !== "word") {
    return token.category;
  }

  const partOfSpeech = token.partOfSpeech?.toLowerCase() ?? "";
  if (token.particleFunction) {
    return "particle";
  }
  if (
    partOfSpeech.includes("助動詞")
    || partOfSpeech.includes("助动词")
    || partOfSpeech.includes("auxiliary")
  ) {
    return "functional";
  }
  if (partOfSpeech.includes("副词") || partOfSpeech.includes("adverb")) {
    return "adverb";
  }
  if (token.grammarPoint) {
    return "grammar";
  }
  return token.category;
}

/**
 * 只有「偏移合法且切片与 surface 完全一致」的 token 才能渲染。
 * 模型偶发给出越界或错位偏移，直接渲染会把原文切乱。
 */
export function isRenderableToken(token: TokenAnalysis, text: string): boolean {
  return token.startOffset >= 0
    && token.endOffset > token.startOffset
    && token.endOffset <= text.length
    && text.slice(token.startOffset, token.endOffset) === token.surface;
}
