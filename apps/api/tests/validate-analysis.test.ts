import { describe, expect, it } from "vitest";
import type { SegmentAnalysis, TokenAnalysis } from "@nihongonote/core";

import { mergeAnalysis, validateAnalysis } from "../src/services/analysis-service.js";
import type { TokenBoundary } from "../src/tokenization.js";

/*
 * QUAL-001（M1.7）边界对齐修复的单元测试：
 * 模型偶尔抄错 surface/offset 或漏答个别 token——修复策略是「以本地边界为准回填 +
 * 漏答补占位（仅补不丢）」，只有真正无法对齐的（重复/未知 ID）才让整段失败。
 */

const segment = { id: "doc:segment:0" };

const boundaries: TokenBoundary[] = [
  { tokenId: "doc:segment:0:token:0", startOffset: 0, endOffset: 2, surface: "これ" },
  { tokenId: "doc:segment:0:token:1", startOffset: 2, endOffset: 3, surface: "は" },
  { tokenId: "doc:segment:0:token:2", startOffset: 3, endOffset: 5, surface: "本" }
];

function llmToken(index: number, overrides: Partial<TokenAnalysis> = {}): TokenAnalysis {
  const boundary = boundaries[index]!;
  return {
    tokenId: boundary.tokenId,
    startOffset: boundary.startOffset,
    endOffset: boundary.endOffset,
    surface: boundary.surface,
    category: "word",
    gloss: "解释",
    confidence: 0.9,
    ...overrides
  };
}

function llmAnalysis(tokens: TokenAnalysis[]): SegmentAnalysis {
  return {
    segmentId: segment.id,
    translation: "这是书",
    grammarSummary: null,
    register: null,
    tone: null,
    politeness: null,
    impliedMeaning: null,
    replyReason: null,
    uncertaintyNote: null,
    tokens
  };
}

describe("validateAnalysis 边界对齐（QUAL-001）", () => {
  it("完全一致时原样通过", () => {
    const result = validateAnalysis(segment, llmAnalysis([llmToken(0), llmToken(1), llmToken(2)]), boundaries);
    expect(result.tokens).toHaveLength(3);
    expect(result.tokens[0]!.gloss).toBe("解释");
  });

  it("surface/offset 抄错时以本地边界回填", () => {
    const wrong = llmToken(1, { surface: "わ", startOffset: 9, endOffset: 99 });
    const result = validateAnalysis(segment, llmAnalysis([llmToken(0), wrong, llmToken(2)]), boundaries);
    expect(result.tokens[1]!.surface).toBe("は");
    expect(result.tokens[1]!.startOffset).toBe(2);
    expect(result.tokens[1]!.endOffset).toBe(3);
    // 解释字段保留（只是定位被修正）
    expect(result.tokens[1]!.gloss).toBe("解释");
  });

  it("漏答 token 时补「未提供」占位，其余保留", () => {
    const result = validateAnalysis(segment, llmAnalysis([llmToken(0), llmToken(2)]), boundaries);
    expect(result.tokens).toHaveLength(3);
    const placeholder = result.tokens.find((token) => token.tokenId.endsWith("token:1"))!;
    expect(placeholder.confidence).toBeNull();
    expect(placeholder.gloss).toBeUndefined();
    expect(placeholder.category).toBe("word");
    // 正常 token 不受影响
    expect(result.tokens[0]!.gloss).toBe("解释");
  });

  it("全部漏答时产出全占位（仍不失败）", () => {
    const result = validateAnalysis(segment, llmAnalysis([]), boundaries);
    expect(result.tokens).toHaveLength(3);
    expect(result.tokens.every((token) => token.confidence === null)).toBe(true);
  });

  it("重复 ID 与未知 ID 仍整段拒绝（无法对齐）", () => {
    expect(() =>
      validateAnalysis(segment, llmAnalysis([llmToken(0), llmToken(0)]), boundaries)
    ).toThrow(/duplicate/);
    expect(() =>
      validateAnalysis(segment, llmAnalysis([{ ...llmToken(0), tokenId: "doc:segment:0:token:99" }]), boundaries)
    ).toThrow(/unexpected token ID/);
  });

  it("segmentId 不符仍拒绝（定位依据不可降级）", () => {
    expect(() =>
      validateAnalysis(segment, { ...llmAnalysis([llmToken(0)]), segmentId: "doc:segment:9" }, boundaries)
    ).toThrow(/unexpected segment ID/);
  });
});

describe("mergeAnalysis 与占位 token 的配合", () => {
  it("漏答补占位后合并结果仍不重不漏", () => {
    const validated = validateAnalysis(segment, llmAnalysis([llmToken(0)]), boundaries);
    const merged = mergeAnalysis(segment, boundaries, [], validated);
    expect(merged.tokens).toHaveLength(3);
    expect(merged.dictionaryCoverage).toEqual({ matched: 0, total: 3 });
  });
});
