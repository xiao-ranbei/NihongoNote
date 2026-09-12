/**
 * 流水线验证脚本（零新增依赖，用 tsx 直接跑）。
 *
 *   pnpm --filter @nihongonote/api verify
 *
 * 覆盖七类回归：
 *   1. 分段 —— 说话人正则不得吞掉原文（A-2）
 *   2. 分词 —— 助词/活用尾不得被切成单字碎片（T-1）
 *   3. 落盘 —— 防抖写入不得丢数据，也不得留下临时文件（A-1）
 *   4. 响应解析 —— 模型输出裸控制字符时仍能解析（端到端实测发现）
 *   5. 装箱 —— 长句段不与其他句段同批，且装箱不重不漏（端到端实测发现）
 *   6. 契约容错 —— token 缺 confidence 时降级为 null 而非整段失败（端到端实测发现）
 *   7. 词典 —— 固定用法库查表命中/未命中降级/瘦身格式（实施步骤 1）
 * 任一项失败以退出码 1 结束，便于接到 CI 里。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { segmentAnalysisSchema, tokenAnalysisSchema } from "@nihongonote/core";

import {
  measureSourceCoverage,
  splitIntoSegments
} from "../src/segmentation.js";
import { tokenizeJapanese } from "../src/tokenization.js";
import {
  getDictionaryStats,
  getDictionaryVersion,
  lookupSentenceEnding,
  lookupToken
} from "../src/dictionary/lookup.js";
import { functionalEntries, particleEntries } from "../src/dictionary/data.js";
import {
  countSegmentTokens,
  estimateAnalysisTokens,
  estimateDurationSeconds,
  estimatePreviewCost,
  previewCoefficients,
  previewCoefficientsByProfile
} from "../src/analysis-preview.js";
import {
  alignMorphology,
  categoryForPos,
  tokenizeWithMorphology
} from "../src/morphology.js";
import {
  AnalysisService,
  mergeAnalysis
} from "../src/services/analysis-service.js";
import { prepareSegmentTokens } from "../src/segment-preparation.js";
import {
  contentDictionaryConfidence,
  createContentDictionary,
  createContentDictionaryHolder,
  FixtureContentDictionary,
  initializeContentDictionary,
  JmdictCommonProvider,
  joinGlosses,
  listContentDictionaryIds,
  NullContentDictionary,
  preferredGloss,
  resolveContentDictionaryId,
  type ContentDictionaryHolder
} from "../src/dictionary/content/index.js";
import {
  type GlossTranslator,
  NullGlossTranslator,
  OllamaGlossTranslator
} from "../src/dictionary/content/translator.js";
import {
  loadContentDictionarySettings,
  parseContentDictionarySettings,
  saveContentDictionarySettings
} from "../src/content-dictionary-settings.js";
import {
  loadGlossTranslationSettings,
  parseGlossTranslationSettings,
  saveGlossTranslationSettings
} from "../src/gloss-translation-settings.js";
import type {
  ContentDictionaryProvider,
  ContentLookupQuery
} from "../src/dictionary/content/types.js";
import { DocumentRepository } from "../src/repositories/document-repository.js";
import { OllamaProvider } from "../src/providers/ollama.js";
import {
  buildLlmProvider,
  createProviderRegistry,
  type LlmBuildConfig
} from "../src/providers/registry.js";
import { ProviderConfigurationError } from "../src/providers/types.js";
import type { LlmAnalysisResult, LlmProvider } from "../src/providers/types.js";
import {
  ensureLlmProfiles,
  maskApiKey,
  mergeLlmSettings,
  parseLlmSettings,
  resolveApiKey,
  resolveSettingsSave,
  type LlmProfile,
  type LlmSettings,
  type LlmSettingsInput
} from "../src/settings.js";
import type { AppConfig } from "../src/config.js";
import { createDatabase } from "../src/db/database.js";
import {
  escapeControlCharacters,
  parseJsonResponse,
  repairStrayQuotes
} from "../src/providers/openai-compatible.js";
import {
  deepseekOutputTokenModel,
  estimateCompletionTokens,
  hardMaxCompletionTokens,
  localOutputTokenModel,
  packingSafetyRatio,
  planBatches
} from "../src/llm-budget.js";
import {
  estimateCost,
  isPeakHour
} from "../src/llm-pricing.js";

/**
 * 子进程分支：写完不调 close() 就退出。
 * 这是防抖落盘最危险的时刻 —— 如果退出钩子没兜住，用户关掉应用就丢最后一批结果。
 * 由下面的 A-1 崩溃用例 fork 出来执行。
 */
if (process.env.NIHONGO_VERIFY_CHILD === "1") {
  const childTarget = process.env.NIHONGO_VERIFY_DB;
  if (!childTarget) {
    process.exit(2);
  }
  const childDatabase = await createDatabase(childTarget);
  childDatabase.run("CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  childDatabase.run("INSERT INTO note (body) VALUES (?)", ["written-without-close"]);
  process.exit(0);
}

interface CaseResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CaseResult[] = [];

function check(name: string, work: () => string): void {
  try {
    results.push({ name, passed: true, detail: work() });
  } catch (error) {
    results.push({
      name,
      passed: false,
      detail: error instanceof Error ? error.message : String(error)
    });
  }
}

const documentId = "doc-verify";

/** 说话人标签为合法场景，应被识别且不参与正文。 */
const dialogueCases: Array<{ name: string; text: string; speaker: string }> = [
  { name: "全角冒号标签", text: "田中：こんにちは。", speaker: "田中" },
  { name: "半角冒号标签", text: "佐藤: はい、そうです。", speaker: "佐藤" },
  { name: "带空格的标签", text: "店員 ： いらっしゃいませ。", speaker: "店員" },
  { name: "长标签仍在 20 字内", text: "受付の田中さん：お待たせしました。", speaker: "受付の田中さん" }
];

/** 曾经被原正则误吞的伪标签，必须整段保留在正文中。 */
const falsePositiveCases: Array<{ name: string; text: string; mustContain: string }> = [
  { name: "A-2 URL 行", text: "https://example.com", mustContain: "https://example.com" },
  { name: "A-2 http URL 行", text: "http://a.co.jp/x", mustContain: "http://a.co.jp/x" },
  { name: "A-2 时间开头", text: "10:30 から会議です。", mustContain: "10:30" },
  { name: "A-2 全角冒号协议名", text: "https：例です", mustContain: "https：例です" },
  { name: "A-2 路径含冒号", text: "C:\\notes\\a.txt を開く", mustContain: "C:" }
];

/**
 * 分词用例。
 * forbidden 是「不该出现的碎片」，required 是「必须保住的独立助词」——
 * 两者一起写，才能保证修碎片的同时不会把助词也一并吞掉。
 */
const tokenCases: Array<{
  name: string;
  text: string;
  forbidden: string[];
  required: string[];
}> = [
  {
    name: "T-1 敬语活用尾不得碎成单字",
    text: "ありがとうございます",
    forbidden: ["ご", "ざ", "い"],
    required: ["ます"]
  },
  {
    name: "T-1 动词连用形词尾不得单飞",
    text: "よろしくお願いします",
    forbidden: ["し"],
    required: ["ます"]
  },
  {
    name: "T-1 ください 不得被拦腰截断",
    text: "私はそれをください",
    forbidden: ["くだ", "さい"],
    required: ["は", "を", "ください"]
  },
  {
    name: "T-1 ています 归位到补助动词",
    text: "毎日日本語を勉強しています",
    forbidden: ["い"],
    required: ["て", "を"]
  },
  {
    name: "T-1 助词不被前词吞掉",
    text: "これは私の本です",
    forbidden: [],
    required: ["は", "の"]
  }
];

console.log("=== 分段：说话人标签识别 ===");
for (const testCase of dialogueCases) {
  check(testCase.name, () => {
    const segments = splitIntoSegments(testCase.text, documentId);
    assert.ok(segments.length > 0, "未产出任何 segment");
    assert.equal(segments[0]?.speaker, testCase.speaker, "说话人识别错误");
    assert.ok(
      !segments[0]?.text.includes(testCase.speaker),
      "说话人标签不应出现在正文中"
    );
    return `speaker=${segments[0]?.speaker ?? "-"} text=${segments[0]?.text ?? "-"}`;
  });
}

console.log("=== 分段：伪标签不得吞原文 ===");
for (const testCase of falsePositiveCases) {
  check(testCase.name, () => {
    const segments = splitIntoSegments(testCase.text, documentId);
    assert.ok(segments.length > 0, "未产出任何 segment");
    assert.equal(segments[0]?.speaker, null, "不应识别出说话人");
    const joined = segments.map((segment) => segment.text).join("");
    assert.ok(
      joined.includes(testCase.mustContain),
      `原文被吞，segment 内容为「${joined}」，应包含「${testCase.mustContain}」`
    );
    return `speaker=null text=${joined}`;
  });
}

console.log("=== 分词：碎片合并 ===");
for (const testCase of tokenCases) {
  check(testCase.name, () => {
    const tokens = tokenizeJapanese(testCase.text, "seg:0");
    const surfaces = tokens.map((token) => token.surface);

    const offenders = testCase.forbidden.filter((item) => surfaces.includes(item));
    assert.equal(
      offenders.length,
      0,
      `仍存在碎片 token：${offenders.join("/")}（切分结果 ${surfaces.join("|")}）`
    );

    const missing = testCase.required.filter((item) => !surfaces.includes(item));
    assert.equal(
      missing.length,
      0,
      `独立助词被误合并，缺少：${missing.join("/")}（切分结果 ${surfaces.join("|")}）`
    );

    // 合并只允许发生在原文相邻的位置，绝不能跨过标点或空格把两段粘在一起。
    for (let index = 1; index < tokens.length; index += 1) {
      const previous = tokens[index - 1]!;
      const current = tokens[index]!;
      assert.ok(
        current.startOffset >= previous.endOffset,
        `token 区间重叠：${previous.surface} 与 ${current.surface}`
      );
      assert.equal(
        testCase.text.slice(current.startOffset, current.endOffset),
        current.surface,
        `token ${current.surface} 的 offset 与原文不符`
      );
    }

    return surfaces.join("|");
  });
}

console.log("=== 覆盖率守卫 ===");
const coverageSource = "田中：こんにちは。\nhttps://example.com\n10:30 から会議です。";
check("覆盖率不低于 90%", () => {
  const segments = splitIntoSegments(coverageSource, documentId);
  const coverage = measureSourceCoverage(coverageSource, segments);
  assert.ok(
    coverage.coverageRatio >= 0.9,
    `覆盖率 ${(coverage.coverageRatio * 100).toFixed(1)}% 过低，丢失 ${coverage.missingNonWhitespace} 个非空白字符`
  );
  return `覆盖率 ${(coverage.coverageRatio * 100).toFixed(1)}%（丢失 ${coverage.missingNonWhitespace} 字）`;
});

console.log("=== 响应解析：裸控制字符容错 ===");
// 实测 deepseek 会在 explanation 里输出裸换行，导致整批 3 个 segment 一起失败
const dirtyJson = '{"segments":[{"translation":"甲\n乙","note":"a\tb"}]}';
check("字符串内的裸换行/制表符被转义后仍可解析", () => {
  assert.throws(() => JSON.parse(dirtyJson), "构造用例应该先证明原始 JSON 解析不了");
  const parsed = JSON.parse(escapeControlCharacters(dirtyJson)) as {
    segments: Array<{ translation: string; note: string }>;
  };
  assert.equal(parsed.segments[0]!.translation, "甲\n乙", "换行内容应被保留而不是丢弃");
  assert.equal(parsed.segments[0]!.note, "a\tb");
  return "裸控制字符转为转义序列，内容无损";
});
check("结构字符与已转义序列不被二次转义", () => {
  const clean = '{"a":"x\\ny","b":1,"c":[true,null]}';
  assert.equal(escapeControlCharacters(clean), clean, "合法 JSON 必须原样返回");
  return "合法 JSON 不受影响";
});
check("字符串外的控制字符（结构空白）保持原样", () => {
  const withStructuralNewlines = '{\n  "a": 1\n}';
  assert.equal(
    escapeControlCharacters(withStructuralNewlines),
    withStructuralNewlines,
    "结构空白不该被改成字面 \\n"
  );
  return "只处理字符串字面量内部的控制字符";
});

console.log("=== 响应解析：全角闭引号退化容错 ===");
/*
 * 2026-09-01 实测（qwen3.5:9b）：模型把全角闭引号 ” 写成 ASCII "，
 * 字符串被提前终止。同样输入两次运行出错位置几乎一致（均 line 38），
 * 是确定性触发，重试救不回来——必须在解析层修复。
 * 用例取自真实失败响应 apps/api/data/raw-capture-segment-9.txt 第 37-38 行。
 */
const degenerateQuotes = [
  "{",
  '  "analyses": [',
  "    {",
  '      "segmentId": "doc:0",',
  '      "tokens": [',
  "        {",
  '          "grammarPoint": "数量词，与“1"组成“1 つ”，表示单数或一个单位",',
  '          "explanation": "数字“二”，此处与“1"连用构成“1 つ”，表示“一件事”。",',
  '          "confidence": 0.95',
  "        }",
  "      ]",
  "    }",
  "  ]",
  "}"
].join("\n");

check("模型把全角闭引号写成 ASCII 双引号时仍可解析", () => {
  assert.throws(() => JSON.parse(degenerateQuotes), "构造用例应该先证明原始 JSON 解析不了");
  const parsed = parseJsonResponse(degenerateQuotes) as {
    analyses: Array<{ tokens: Array<{ grammarPoint: string; explanation: string }> }>;
  };
  const token = parsed.analyses[0]!.tokens[0]!;
  assert.ok(token.grammarPoint.includes("1 つ"), `内容不应被截断：${token.grammarPoint}`);
  assert.ok(token.explanation.includes("一件事"), `内容不应被截断：${token.explanation}`);
  return `修复后内容完整（${token.grammarPoint.length} 字符）`;
});
check("迷途引号被替换为全角闭引号而非丢弃", () => {
  const repaired = repairStrayQuotes('{"a": "与“1"组成"}');
  const parsed = JSON.parse(repaired) as { a: string };
  assert.equal(parsed.a, "与“1”组成", "应为全角闭引号，保留原文语义");
  return "ASCII 双引号 → ”";
});
check("结构闭合引号后的 , } ] : 均被正确识别", () => {
  const clean = '{"a":"x","b":[1,2],"c":{"d":null}}';
  assert.equal(repairStrayQuotes(clean), clean, "合法 JSON 必须原样返回");
  return "结构引号不受影响";
});
check("已转义的双引号不被误改", () => {
  const escaped = '{"a":"他说\\"你好\\""}';
  assert.equal(repairStrayQuotes(escaped), escaped, "\\\" 是合法转义，不能动");
  return "转义序列保持原样";
});
check("合法响应走原样解析，不进入修复链", () => {
  const valid = '{"analyses":[{"segmentId":"s1","tokens":[]}]}';
  const parsed = parseJsonResponse(valid) as { analyses: Array<{ segmentId: string }> };
  assert.equal(parsed.analyses[0]!.segmentId, "s1");
  assert.equal(repairStrayQuotes(valid), valid, "合法 JSON 零副作用");
  return "正常路径零开销、零改写";
});

console.log("=== 契约容错：token 缺 confidence ===");
// 实测模型在 reasoning 模式下会整段省略 confidence（`tokens.0.confidence: Required`），
// 契约层现在把它降级为 null，确保单个 token 的疏漏不会拖垮整段分析。
const minimalToken = {
  tokenId: "seg:0:token:0",
  startOffset: 0,
  endOffset: 1,
  surface: "あ",
  category: "word",
  lemma: null,
  reading: null,
  partOfSpeech: null,
  conjugation: null,
  gloss: null,
  particleFunction: null,
  grammarPoint: null,
  explanation: null
};
check("token 缺 confidence 时降级为 null 而不是整段失败", () => {
  const parsed = tokenAnalysisSchema.parse(minimalToken);
  assert.equal(parsed.confidence, null, "缺 confidence 应降级为 null");
  return "缺 confidence → null，不再报 Required";
});
check("confidence 数值/字符串/null 三种形态仍按原规则处理", () => {
  const asString = tokenAnalysisSchema.parse({ ...minimalToken, confidence: "0.9" });
  assert.equal(asString.confidence, 0.9, "数字字符串仍应还原为数字");
  const asNull = tokenAnalysisSchema.parse({ ...minimalToken, confidence: null });
  assert.equal(asNull.confidence, null, "显式 null 保持 null");
  const asNumber = tokenAnalysisSchema.parse({ ...minimalToken, confidence: 0.85 });
  assert.equal(asNumber.confidence, 0.85);
  return '"0.9" → 0.9，null → null，0.85 → 0.85';
});
check("confidence 越界数值仍被 schema 拒绝", () => {
  assert.throws(
    () => tokenAnalysisSchema.parse({ ...minimalToken, confidence: 1.5 }),
    /less than or equal/i,
    "大于 1 的 confidence 不该被放过"
  );
  assert.throws(
    () => tokenAnalysisSchema.parse({ ...minimalToken, confidence: -0.1 }),
    /greater than or equal/i,
    "负 confidence 不该被放过"
  );
  return "1.5 / -0.1 仍被拒绝";
});

console.log("=== 契约容错：analysis 缺顶层字段 ===");
// 与 token 缺 confidence 同类：模型在 reasoning 模式下会省略它认为"不重要"的顶层字段
// （实测 politeness: Required 让整段作废）。顶层字段统一降级为 null，UI 显示「未提供」。
const minimalAnalysis = {
  segmentId: "seg:0",
  tokens: [minimalToken]
};
check("analysis 缺 politeness/translation/tone 时降级为 null 而不是整段失败", () => {
  const parsed = segmentAnalysisSchema.parse(minimalAnalysis);
  assert.equal(parsed.politeness, null, "缺 politeness 应降级为 null");
  assert.equal(parsed.translation, null, "缺 translation 应降级为 null");
  assert.equal(parsed.tone, null, "缺 tone 应降级为 null");
  assert.equal(parsed.grammarSummary, null, "缺 grammarSummary 应降级为 null");
  return "顶层字段缺 → null，不再报 Required";
});
check("segmentId 缺失仍被拒绝（定位依据不可降级）", () => {
  assert.throws(
    () => segmentAnalysisSchema.parse({ tokens: [] }),
    /segmentId/,
    "segmentId 是定位依据，缺了不该被放过"
  );
  return "缺 segmentId 仍拒绝";
});
check("tokens 缺失仍被拒绝（分析核心不可降级）", () => {
  assert.throws(
    () => segmentAnalysisSchema.parse({ segmentId: "seg:0" }),
    /tokens/,
    "tokens 是分析核心，缺了不该被放过"
  );
  return "缺 tokens 仍拒绝";
});

console.log("=== 装箱：按估算成本而非固定段数 ===");
const packingBudget = Math.floor(hardMaxCompletionTokens * packingSafetyRatio);
const longSegment = { id: "long", text: "あ".repeat(92) };
const mediumSegment = { id: "mid", text: "い".repeat(20) };
const shortSegment = { id: "short", text: "う".repeat(10) };
const tinySegments = [1, 2, 3].map((index) => ({ id: `t${index}`, text: "え".repeat(12) }));

check("长句段不与其它段同批（旧方案会打满 30000 上限）", () => {
  const batches = planBatches([longSegment, mediumSegment, shortSegment], 3, packingBudget);
  assert.equal(batches.length, 2, `期望拆成 2 批，实际 ${batches.length} 批`);
  assert.deepEqual(batches[0]!.map((s) => s.id), ["long"], "92 字的长句段必须单独成批");
  return `92 字 + 20 字 + 10 字 → ${batches.map((b) => b.length).join("+")} 段`;
});
check("短句段仍会凑满 batchSize", () => {
  const batches = planBatches(tinySegments, 3, packingBudget);
  assert.equal(batches.length, 1, "短句段不该被拆开，否则白白多花一轮请求");
  assert.equal(batches[0]!.length, 3);
  return `3 × 12 字 → 1 批 3 段`;
});
check("装箱不重不漏", () => {
  const input = [...tinySegments, longSegment, mediumSegment, shortSegment];
  const flattened = planBatches(input, 3, packingBudget).flatMap((batch) => batch.map((s) => s.id));
  assert.deepEqual(
    [...flattened].sort(),
    input.map((s) => s.id).sort(),
    "装箱后句段集合必须与输入一致"
  );
  assert.equal(flattened.length, new Set(flattened).size, "句段不得重复出现在多个批次");
  return "6 个句段全部归入且仅归入一个批次";
});
check("单段超预算也单独成批（不死循环）", () => {
  const huge = { id: "huge", text: "お".repeat(500) };
  const batches = planBatches([huge, ...tinySegments], 3, packingBudget);
  assert.equal(batches[0]!.map((s) => s.id)[0], "huge", "超预算句段必须自己占一批");
  assert.equal(batches.flat().length, 4, "超预算句段不得导致后续句段被丢弃");
  return "估算 118500 token 的句段单独成批，后续句段正常排队";
});

console.log("=== 装箱：最小块保护（防小尾巴）===");
/*
 * 长度按估算式（3500 + 230 × 字符数）反推，保证用例在当前预算下成立：
 * 11 字 → 6030（占预算 24.5%），12 字 → 6260（25.4%），20 字 → 8100（32.9%）。
 * 阈值是短尾上限 30%，落在 6260 与 8100 之间，因此 11/12 字的尾批触发判定、
 * 20 字的不触发。
 */
const tailSegments = (charCount: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `tail${index}`,
    text: "か".repeat(charCount)
  }));

check("尾批过短时并入前一批（4 × 11 字）", () => {
  const batches = planBatches(tailSegments(11, 4), 3, packingBudget);
  assert.equal(batches.length, 1, `期望合并为 1 批，实际 ${batches.length} 批`);
  assert.equal(batches[0]!.length, 4, "尾批应并入前一批，允许比 batchSize 多 1 段");
  assert.deepEqual(
    batches.flat().map((s) => s.id),
    ["tail0", "tail1", "tail2", "tail3"],
    "合并不得改变句段顺序，也不得丢段"
  );
  return "3 段 + 1 段尾批（6030 / 24640 = 24.5%）→ 合并为 1 批 4 段";
});
check("并入后会超预算时保持小尾批（4 × 12 字）", () => {
  const batches = planBatches(tailSegments(12, 4), 3, packingBudget);
  assert.equal(batches.length, 2, "合并会越过 token 上限，越界被截断才是真浪费");
  assert.equal(batches[1]!.length, 1, "尾批应保持原样，不得为了合并而越界");
  return "3 段 + 1 段尾批；合并后 25040 > 预算 24640 → 不合并";
});
check("尾批不算短时不做调整（4 × 20 字）", () => {
  const batches = planBatches(tailSegments(20, 4), 3, packingBudget);
  assert.equal(batches.length, 2, "尾批占预算 32.9%，不属于小尾巴，不该被动");
  return "尾批 8100 / 24640 = 32.9% ≥ 30% 阈值 → 保持 2 批";
});
check("batchSize=1 为严格单段模式，不触发合并", () => {
  const batches = planBatches(tailSegments(11, 3), 1, packingBudget);
  assert.equal(batches.length, 3, "用户显式要求每批 1 段时必须尊重该意图");
  return "maxItems < 2 → 最小块保护不生效，3 段仍是 3 批";
});
check("分批结果确定：同输入必得同输出", () => {
  const input = tailSegments(11, 4);
  const first = planBatches(input, 3, packingBudget).map((batch) => batch.map((s) => s.id));
  const second = planBatches(input, 3, packingBudget).map((batch) => batch.map((s) => s.id));
  assert.deepEqual(first, second, "装箱不得依赖运行时状态（成本预估可信的前提）");
  return "两次调用得到完全相同的分批结果";
});

console.log("=== 输出估算模型：provider 自声明（M1.10）===");
/*
 * 句子固定 20 字符便于手算：
 *   云端系数 3500 + 20 × 230 = 8100；本地系数 0 + 20 × 107.1 = 2142（取整 6426 / 3 段）。
 * 本地预算模拟 Ollama：min(12000, 8192) × 0.77 = 6308。
 */
const estimateSegments = (count: number, charCount: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `est${index}`,
    text: "あ".repeat(charCount)
  }));

check("云端与本地估算相差数倍（用错模型必然失真）", () => {
  const sample = estimateSegments(3, 20);
  const cloud = estimateCompletionTokens(sample, deepseekOutputTokenModel);
  const local = estimateCompletionTokens(sample, localOutputTokenModel);
  assert.equal(cloud, 24_300, "3 × (3500 + 20 × 230)");
  assert.equal(Math.round(local), 6_426, "3 × (0 + 20 × 107.1)");
  assert.ok(cloud / local > 3, `高估应超过 3 倍，实际 ${(cloud / local).toFixed(2)}`);
  return `3 段 × 20 字：云端 24300 vs 本地 6426（${(cloud / local).toFixed(2)} 倍）`;
});
check("本地预算下：本地模型能合并，沿用云端模型则只能单段", () => {
  const sample = estimateSegments(3, 20);
  const localBudget = Math.floor(Math.min(12_000, 8_192) * packingSafetyRatio);
  const withLocal = planBatches(sample, 3, localBudget, localOutputTokenModel);
  const withCloud = planBatches(sample, 3, localBudget, deepseekOutputTokenModel);
  assert.deepEqual(
    withLocal.map((batch) => batch.length),
    [2, 1],
    "本地系数下两段共 4284 ≤ 6308，应能同批"
  );
  assert.deepEqual(
    withCloud.map((batch) => batch.length),
    [1, 1, 1],
    "沿用云端系数时单段 8100 已超预算，只能一段一批"
  );
  return `预算 ${localBudget}：本地 → 2+1 段；云端 → 1+1+1 段`;
});

console.log("=== 落盘：防抖写入 ===");
const persistDirectory = path.resolve(process.cwd(), "data", "_verify");
const persistFile = path.join(persistDirectory, "persist-check.db");
const idleDelayMs = 2_000;

fs.rmSync(persistDirectory, { recursive: true, force: true });
const database = await createDatabase(persistFile);
database.run("CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");

const rowCount = 200;
const writeStartedAt = Date.now();
for (let index = 0; index < rowCount; index += 1) {
  database.run("INSERT INTO note (body) VALUES (?)", [`row-${index}`]);
}
const writeElapsedMs = Date.now() - writeStartedAt;

// 防抖窗口内文件应停留在初始状态，说明写入确实被攒住了。
const sizeBeforeIdle = fs.readFileSync(persistFile).length;
const sizeDuringIdleWindow = ((): number => {
  const now = Date.now();
  while (Date.now() - now < 200) {
    // 空转 200ms，给同步落盘留出暴露机会
  }
  return fs.readFileSync(persistFile).length;
})();

await new Promise((resolve) => setTimeout(resolve, idleDelayMs + 500));

const sizeAfterIdle = fs.readFileSync(persistFile).length;
const tempFileLeftover = fs.existsSync(`${persistFile}.tmp`);

const reopened = await createDatabase(persistFile);
const persistedRows = reopened.get<{ total: number }>("SELECT COUNT(*) AS total FROM note");
reopened.close();
database.close();
fs.rmSync(persistDirectory, { recursive: true, force: true });

check("A-1 防抖窗口内不落盘", () => {
  assert.equal(
    sizeDuringIdleWindow,
    sizeBeforeIdle,
    "写入没有被攒住，仍在每次 run() 后同步落盘"
  );
  return `${rowCount} 次写入期间文件大小保持 ${sizeBeforeIdle} 字节`;
});

check("A-1 空闲后一次性落盘", () => {
  assert.ok(
    sizeAfterIdle > sizeBeforeIdle,
    "空闲窗口结束后文件没有变化，数据可能根本没写盘"
  );
  return `落盘后 ${sizeAfterIdle} 字节，单次写入平均 ${(writeElapsedMs / rowCount).toFixed(3)}ms`;
});

check("A-1 落盘后数据不丢", () => {
  assert.equal(persistedRows?.total, rowCount, "重开数据库后行数不符");
  return `重开后读到 ${persistedRows?.total}/${rowCount} 行`;
});

check("A-1 原子替换不残留临时文件", () => {
  assert.equal(tempFileLeftover, false, `${persistFile}.tmp 未被 rename 掉`);
  return "无 .tmp 残留";
});

// 崩溃路径：子进程写完不调 close() 就 process.exit(0)，看退出钩子能不能补写。
const crashFile = path.join(persistDirectory, "crash-check.db");
fs.mkdirSync(persistDirectory, { recursive: true });
const child = spawnSync(
  process.execPath,
  ["--import", "tsx", fileURLToPath(import.meta.url)],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      NIHONGO_VERIFY_CHILD: "1",
      NIHONGO_VERIFY_DB: crashFile
    }
  }
);

let crashRows = -1;
if (fs.existsSync(crashFile)) {
  const crashDatabase = await createDatabase(crashFile);
  crashRows = crashDatabase.get<{ total: number }>("SELECT COUNT(*) AS total FROM note")?.total ?? -1;
  crashDatabase.close();
}
fs.rmSync(persistDirectory, { recursive: true, force: true });

check("A-1 进程直接退出时补写", () => {
  assert.equal(
    child.status,
    0,
    `子进程异常退出（status=${child.status}）：${child.stderr ?? ""}`
  );
  assert.equal(
    crashRows,
    1,
    `写入未被补写，子进程退出前的数据丢了（读到 ${crashRows} 行）`
  );
  return "未调用 close() 的写入在 exit 钩子里补写成功";
});

console.log("=== 词典：固定用法库查表 ===");
// 实施步骤 1 的回归守卫：查表命中、未命中降级、瘦身格式、数据完整性。
// 词典是纯本地零 token 服务，命中结果不得编造，未命中必须返回 null 交 LLM 兜底。
check("词典：规模满足设计下限（助词≥40、功能词≥30、句末模板≥10）", () => {
  const stats = getDictionaryStats();
  assert.ok(stats.particles >= 40, `助词条目 ${stats.particles} < 40`);
  assert.ok(stats.functional >= 30, `功能词条目 ${stats.functional} < 30`);
  assert.ok(stats.endings >= 10, `句末模板 ${stats.endings} < 10`);
  return `助词 ${stats.particles} / 功能词 ${stats.functional} / 句末模板 ${stats.endings}`;
});
check("词典：同类内无重复 surface", () => {
  const assertUnique = (label: string, entries: Array<{ surface: string }>): void => {
    const duplicates = entries
      .map((entry) => entry.surface)
      .filter((surface, index, all) => all.indexOf(surface) !== index);
    assert.equal(duplicates.length, 0, `${label} 存在重复条目：${[...new Set(duplicates)].join("/")}`);
  };
  assertUnique("助词", particleEntries);
  assertUnique("功能词", functionalEntries);
  return `助词 ${particleEntries.length} 条 / 功能词 ${functionalEntries.length} 条，无重复`;
});
check("词典：助词の命中，confidence=1.0 且 source=dictionary", () => {
  const hit = lookupToken("の");
  assert.ok(hit, "「の」应在固定用法库中");
  assert.equal(hit!.category, "particle");
  assert.equal(hit!.confidence, 1, "固定用法库置信度必须为 1.0");
  assert.equal(hit!.source, "dictionary", "命中结果必须标记 source=dictionary");
  assert.ok(hit!.explanation.length > 0, "解释不得为空");
  return `の → particle / conf=1.0 / ${hit!.gloss}`;
});
check("词典：功能词ます命中为 functional", () => {
  const hit = lookupToken("ます");
  assert.ok(hit, "「ます」应在固定用法库中");
  assert.equal(hit!.category, "functional");
  return `ます → functional / ${hit!.gloss}`;
});
check("词典：未命中返回 null（不编造解释）", () => {
  assert.equal(lookupToken("コンピュータ"), null, "未收录词不得编造词典解释");
  assert.equal(lookupToken("勉強"), null, "普通动词不得被误当成固定用法");
  return "未收录 → null，交 LLM 兜底";
});
check("词典：命中结果不含定位字段（瘦身存储）", () => {
  const hit = lookupToken("を");
  assert.ok(hit, "「を」应在固定用法库中");
  for (const field of ["tokenId", "startOffset", "endOffset"]) {
    assert.ok(!(field in hit!), `命中结果不应携带定位字段 ${field}`);
  }
  return "命中仅含 surface/category/reading/gloss/explanation/confidence/source";
});
check("词典：句末模板从最长开始匹配", () => {
  const hit = lookupSentenceEnding("私は学生ですよ");
  assert.ok(hit, "「ですよ」应命中句末模板");
  assert.equal(hit!.surface, "ですよ");
  const longer = lookupSentenceEnding("明日は晴れるでしょう");
  assert.equal(longer?.surface, "でしょう", "应命中更长模板而非「しょう」之类的子串");
  return `「ですよ」→ ${hit!.tone}；「でしょう」→ ${longer?.tone}`;
});
check("词典：句末模板未命中返回 null", () => {
  assert.equal(lookupSentenceEnding("ありがとう"), null);
  assert.equal(lookupSentenceEnding("今日は"), null, "不以模板结尾时不得命中");
  return "未命中 → null";
});
check("词典：版本号可追溯", () => {
  assert.equal(getDictionaryVersion(), "1.0.0", "词典版本应与 types.ts 一致");
  return `dictionaryVersion=${getDictionaryVersion()}`;
});

console.log("=== 形态素分析：kuromoji 事实字段与边界决策 ===");
// 实施步骤 2：kuromoji 提供 lemma/reading/partOfSpeech/conjugation 四个事实字段。
// 实测对比（2026-08-29）：kuromoji 对动词连用形/复合助动词系统性单飞
// （勉強|し|て|い|ます、でしょ|う），不能单独承担 token 边界；
// 决策为「并存」——边界保留现有合并后处理，kuromoji 只做字段。
const morphText = "毎日日本語を勉強しています。";
const morphTokens = await tokenizeWithMorphology(morphText);
const morphBySurface = new Map(morphTokens.map((token) => [token.surface, token]));

// 边界决策对照数据（提前计算，check 回调内只做同步断言）
const decisionText = "毎日日本語を勉強しています";
const decisionMorphSurfaces = (await tokenizeWithMorphology(decisionText))
  .map((token) => token.surface);
const decisionCurrentSurfaces = tokenizeJapanese(decisionText, "seg")
  .map((token) => token.surface);

// 对齐用例数据
const alignBoundaries = tokenizeJapanese(decisionText, "seg");
const alignMorph = await tokenizeWithMorphology(decisionText);
const alignedByToken = alignMorphology(alignBoundaries, alignMorph);

// 前缀约束用例：「でしょう」本地切 で|しょう，kuromoji 切 でしょ|う
const prefixText = "明日は雨が降るでしょう。";
const prefixBoundaries = tokenizeJapanese(prefixText, "seg");
const prefixAligned = alignMorphology(
  prefixBoundaries,
  await tokenizeWithMorphology(prefixText)
);

check("形态素：汉字词产出读音/原形/词性", () => {
  const token = morphBySurface.get("勉強");
  assert.ok(token, "「勉強」应被形态素分析覆盖");
  assert.equal(token!.partOfSpeech, "名詞-サ変接続");
  assert.equal(token!.reading, "ベンキョウ");
  assert.equal(token!.lemma, "勉強");
  return "勉強 → 名詞-サ変接続 / ベンキョウ / lemma=勉強";
});
check("形态素：助词产出词性与原形", () => {
  const token = morphBySurface.get("を");
  assert.ok(token, "「を」应被形态素分析覆盖");
  assert.equal(token!.partOfSpeech, "助詞-格助詞");
  assert.equal(token!.lemma, "を");
  return "を → 助詞-格助詞 / lemma=を";
});
check("形态素：动词产出活用形与原形", () => {
  const token = morphBySurface.get("し");
  assert.ok(token, "「し」应被形态素分析覆盖");
  assert.equal(token!.lemma, "する");
  assert.equal(token!.conjugation, "連用形");
  return "し → lemma=する / 連用形";
});
check("形态素：记号（句点）被过滤", () => {
  assert.ok(!morphTokens.some((token) => token.surface === "。"), "句点不应进入形态素结果");
  return "「。」被过滤（与 isWordLike=false 对齐）";
});
check("形态素：偏移与原文一致", () => {
  for (const token of morphTokens) {
    assert.equal(
      morphText.slice(token.startOffset, token.endOffset),
      token.surface,
      `token ${token.surface} 的偏移与原文不符`
    );
  }
  return `${morphTokens.length} 个 token 偏移全部与原文一致`;
});
check("形态素：pos 大类 → TokenCategory 映射", () => {
  assert.equal(categoryForPos("助詞"), "particle");
  assert.equal(categoryForPos("助動詞"), "functional");
  assert.equal(categoryForPos("副詞"), "adverb");
  assert.equal(categoryForPos("名詞"), "word");
  assert.equal(categoryForPos("接頭詞"), "functional");
  return "助詞→particle / 助動詞→functional / 副詞→adverb / 名詞→word";
});
check("边界决策：kuromoji 单飞连用形，不能单独承担边界（并存依据）", () => {
  assert.ok(decisionMorphSurfaces.includes("し"), "kuromoji 会把 し 单飞（实证）");
  assert.ok(decisionMorphSurfaces.includes("い"), "kuromoji 会把 い 单飞（实证）");
  // 对照：现有合并后处理把它们并回动词/补助动词（T-1 已修复）
  assert.ok(!decisionCurrentSurfaces.includes("い"), "现有切分不应有 い 单飞");
  assert.ok(!decisionCurrentSurfaces.includes("し"), "现有切分不应有 し 单飞");
  return "kuromoji（…|勉強|し|て|い|ます）vs 现有（…|勉強し|て|います）→ 边界保留现有，kuromoji 只做字段";
});
check("形态素：alignMorphology 按偏移为现有 token 提供字段", () => {
  const merged = alignBoundaries.find((token) => token.surface === "勉強し");
  const hit = merged ? alignedByToken.get(merged.tokenId) : undefined;
  assert.ok(hit, "「勉強し」应对齐到形态素（代表=勉強）");
  assert.equal(hit!.reading, "ベンキョウ");
  assert.equal(hit!.lemma, "勉強");
  return `「勉強し」→ lemma=${hit!.lemma} / reading=${hit!.reading}`;
});
check("形态素：对齐前缀约束——边界不一致时不填错字段", () => {
  // 「でしょう」本地切 で|しょう，kuromoji 切 でしょ|う：
  // 「で」的重叠代表是 でしょ，不是「で」的前缀 → 不填充，交 LLM 兜底
  const particle = prefixBoundaries.find((token) => token.surface === "で");
  assert.ok(particle, "「で」应存在于本地切分中");
  assert.ok(!prefixAligned.has(particle!.tokenId), "「で」不应拿到 でしょ 的字段（防止 lemma 错填为 です）");
  return "边界不一致 → 不填充，LLM 兜底";
});

console.log("=== 三层链路：本地预处理与合并 ===");
// 实施步骤 3：词典命中 token 不进入 LLM（零 token），未命中才走 AI；
// 命中 token 瘦身存储（省略恒定 null 字段），段级字段与 coverage 落库。
const threeLayerText = "これは私の本です。";
const threeLayerBoundaries = tokenizeJapanese(threeLayerText, "seg:three");
const threeLayerPrepared = await prepareSegmentTokens(
  { id: "seg:three", documentId: "doc", index: 0, text: threeLayerText,
    startOffset: 0, endOffset: threeLayerText.length, speaker: null,
    status: "queued" as const, errorMessage: null },
  threeLayerBoundaries
);

check("三层：词典命中 token 不进 LLM 候选", () => {
  const hitSurfaces = threeLayerPrepared.localTokens.map((token) => token.surface);
  const llmSurfaces = threeLayerPrepared.llmBoundaries.map((boundary) => boundary.surface);
  assert.deepEqual(hitSurfaces, ["は", "の", "です"], "は/の/です 应词典命中");
  assert.deepEqual(llmSurfaces, ["これ", "私", "本"], "これ/私/本 未命中应进 LLM");
  return `命中 ${hitSurfaces.join("/")} | LLM 只处理 ${llmSurfaces.join("/")}`;
});
check("三层：词典命中 token 瘦身存储（source/字段省略）", () => {
  const token = threeLayerPrepared.localTokens.find((item) => item.surface === "の");
  assert.ok(token, "「の」应本地命中");
  assert.equal(token!.source, "dictionary");
  assert.equal(token!.confidence, 1);
  assert.ok((token!.explanation?.length ?? 0) > 0, "词典解释不得为空");
  // 瘦身：省略恒定 null 的字段，不落宽表（设计文档 3.7）
  const serialized = JSON.stringify(token);
  assert.ok(!serialized.includes("particleFunction"), "瘦身 token 不应包含 particleFunction");
  assert.ok(!serialized.includes("grammarPoint"), "瘦身 token 不应包含 grammarPoint");
  // 事实字段由形态素填充
  assert.equal(token!.lemma, "の");
  return `の → source=dictionary / conf=1 / lemma=の / 无 particleFunction/grammarPoint 键`;
});
check("三层：合并后顺序稳定、不重不漏、带 coverage 与 schemaVersion", () => {
  const llmAnalysis = {
    segmentId: "seg:three",
    translation: "mock翻译",
    grammarSummary: "mock概括",
    register: null,
    tone: "mock语气",
    politeness: "formal",
    impliedMeaning: null,
    replyReason: null,
    uncertaintyNote: null,
    tokens: threeLayerPrepared.llmBoundaries.map((boundary, index) => ({
      tokenId: boundary.tokenId,
      startOffset: boundary.startOffset,
      endOffset: boundary.endOffset,
      surface: boundary.surface,
      category: "word" as const,
      lemma: "mock",
      reading: "MOCK",
      partOfSpeech: "名詞",
      conjugation: null,
      gloss: "mock",
      particleFunction: null,
      grammarPoint: null,
      explanation: "mock",
      confidence: 0.9,
      source: "llm" as const
    }))
  };
  const segment = { id: "seg:three", documentId: "doc", index: 0, text: threeLayerText,
    startOffset: 0, endOffset: threeLayerText.length, speaker: null,
    status: "queued" as const, errorMessage: null };
  const merged = mergeAnalysis(segment, threeLayerBoundaries, threeLayerPrepared.localTokens, llmAnalysis);
  assert.equal(merged.tokens.length, 6, "合并后应覆盖全部 6 个 token");
  assert.deepEqual(
    merged.tokens.map((token) => token.surface),
    ["これ", "は", "私", "の", "本", "です"],
    "合并顺序必须与本地边界一致"
  );
  assert.equal(merged.schemaVersion, 1, "result_json 应内嵌 schemaVersion");
  assert.deepEqual(merged.dictionaryCoverage, { matched: 3, total: 6 });
  return "6/6 token 顺序稳定 / schemaVersion=1 / coverage 3/6";
});

console.log("=== 三层链路：mock provider 端到端（LLM 只收到未命中 token）===");
const receivedBoundaries: Array<Array<{ segmentId: string; tokens: string[] }>> = [];
const mockProvider: LlmProvider = {
  name: "mock",
  protocol: "openai",
  model: "mock-model",
  configured: true,
  completionTokenBudget: 100_000,
  outputTokenModel: deepseekOutputTokenModel,
  async analyze(request): Promise<LlmAnalysisResult> {
    receivedBoundaries.push(request.tokenBoundaries.map((group) => ({
      segmentId: group.segmentId,
      tokens: group.tokens.map((token) => token.surface)
    })));
    return {
      analyses: request.segments.map((segment) => {
        const group = request.tokenBoundaries.find((item) => item.segmentId === segment.id)!;
        return {
          segmentId: segment.id,
          translation: "mock翻译",
          grammarSummary: "mock概括",
          register: null,
          tone: "mock语气",
          politeness: "formal",
          impliedMeaning: null,
          replyReason: null,
          uncertaintyNote: null,
          tokens: group.tokens.map((boundary) => ({
            tokenId: boundary.tokenId,
            startOffset: boundary.startOffset,
            endOffset: boundary.endOffset,
            surface: boundary.surface,
            category: "word" as const,
            lemma: "mock",
            reading: "MOCK",
            partOfSpeech: "名詞",
            conjugation: null,
            gloss: "mock",
            particleFunction: null,
            grammarPoint: null,
            explanation: "mock explanation",
            confidence: 0.9,
            source: "llm" as const
          }))
        };
      }),
      failures: [],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, cachedInputTokens: 0 }
    };
  },
  async fetchBalance(): Promise<null> {
    return null;
  }
};

// 注入 AnalysisService 用的空内容词典容器（verify 不启用真实数据源）
const noContentDict: ContentDictionaryHolder = { current: new NullContentDictionary(), replace: () => {} };

const threeLayerDir = path.resolve(process.cwd(), "data", "_verify");
const threeLayerFile = path.join(threeLayerDir, "three-layer.db");
fs.rmSync(threeLayerDir, { recursive: true, force: true });
const threeLayerDb = await createDatabase(threeLayerFile);
const threeLayerRepo = new DocumentRepository(threeLayerDb);
const threeLayerDoc = threeLayerRepo.create({
  title: "三层链路验证",
  sourceText: "これは私の本です。",
  targetLevel: "auto"
});
const threeLayerService = new AnalysisService(threeLayerRepo, { current: mockProvider }, noContentDict, new NullGlossTranslator(), "v-test");
threeLayerService.start(threeLayerDoc.id);

let threeLayerProgress;
for (let attempt = 0; attempt < 200; attempt += 1) {
  threeLayerProgress = threeLayerService.getProgress(threeLayerDoc.id);
  if (threeLayerProgress && threeLayerProgress.completedSegments === threeLayerProgress.totalSegments) {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
await threeLayerService.close();

const storedRows = threeLayerDb.all<{ result_json: string }>(
  "SELECT result_json FROM segment_analyses"
);
const storedAnalysis = storedRows.length > 0
  ? JSON.parse(storedRows[0]!.result_json) as {
      tokens: Array<{ surface: string; source?: string; particleFunction?: unknown; grammarPoint?: unknown; explanation?: string }>;
      schemaVersion?: number;
      dictionaryCoverage?: { matched: number; total: number };
    }
  : null;
threeLayerDb.close();
fs.rmSync(threeLayerDir, { recursive: true, force: true });

check("三层：LLM 请求只携带未命中 token", () => {
  assert.ok(receivedBoundaries.length > 0, "mock provider 应收到至少一次分析请求");
  const first = receivedBoundaries[0]?.[0];
  assert.ok(first, "请求中应包含第一个 segment 的边界");
  assert.deepEqual(first!.tokens, ["これ", "私", "本"], "LLM 只应收到未命中 token");
  return `LLM 收到的 token：${first!.tokens.join("/")}`;
});
check("三层：端到端落库含 dictionary 来源与覆盖率", () => {
  assert.ok(storedAnalysis, "应已落库 segment_analyses");
  assert.equal(storedAnalysis!.schemaVersion, 1);
  assert.deepEqual(storedAnalysis!.dictionaryCoverage, { matched: 3, total: 6 });
  const dictionaryTokens = storedAnalysis!.tokens.filter((token) => token.source === "dictionary");
  const llmTokens = storedAnalysis!.tokens.filter((token) => token.source === "llm");
  assert.equal(dictionaryTokens.length, 3, "应有 3 个 dictionary token");
  assert.equal(llmTokens.length, 3, "应有 3 个 llm token");
  // 瘦身存储：dictionary token 无恒定 null 字段
  for (const token of dictionaryTokens) {
    assert.ok(!("particleFunction" in token), "dictionary token 不应含 particleFunction");
    assert.ok(!("grammarPoint" in token), "dictionary token 不应含 grammarPoint");
  }
  return `落库 6 token：dictionary ${dictionaryTokens.length} / llm ${llmTokens.length} / coverage 3/6`;
});

console.log("=== 费用估算：高峰时段与单价 ===");
// 2026-08-31 是周一、2026-09-05 是周六、2026-09-04 是周五（以 2026-08-28 周五为锚点推算）。
// isPeakHour 用「本地时间 + 8h 再读 UTC 分量」得到北京时间，测试用 UTC 时刻直接构造。
const monday = (beijingHour: number, minute = 0): Date =>
  new Date(`2026-08-31T${String(beijingHour - 8).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
const weekday = (date: string): Date => new Date(date);

check("高峰时段：周一 9:00 含端点，12:00 不含", () => {
  assert.equal(isPeakHour(monday(9)), true, "9:00 属于高峰（含左端点）");
  assert.equal(isPeakHour(monday(12)), false, "12:00 不属于高峰（不含右端点）");
  return "9:00→高峰，12:00→闲时";
});
check("高峰时段：周五 18:00 不含，周二 15:00 含", () => {
  assert.equal(isPeakHour(weekday("2026-09-04T10:00:00Z")), false, "周五 18:00 北京应是闲时");
  assert.equal(isPeakHour(weekday("2026-09-01T07:00:00Z")), true, "周二 15:00 北京应是高峰");
  return "18:00 后→闲时，15:00→高峰";
});
check("高峰时段：周末全天闲时", () => {
  assert.equal(isPeakHour(weekday("2026-08-30T02:00:00Z")), false, "周日 10:00 北京应是闲时");
  assert.equal(isPeakHour(weekday("2026-09-05T02:00:00Z")), false, "周六 10:00 北京应是闲时");
  return "周六/周日 → 闲时";
});
check("费用：闲时输入未命中 1.5 元/百万、输出 4.5 元/百万", () => {
  const cost = estimateCost("deepseek-v4-flash", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
    cachedInputTokens: 0
  }, monday(8));
  assert.ok(cost, "内置模型应能估算费用");
  assert.equal(cost!.tier, "off-peak");
  assert.ok(Math.abs(cost!.inputCost - 1.5) < 1e-9, `输入费用 ${cost!.inputCost} 应为 1.5`);
  assert.ok(Math.abs(cost!.outputCost - 4.5) < 1e-9, `输出费用 ${cost!.outputCost} 应为 4.5`);
  assert.ok(Math.abs(cost!.totalCost - 6.0) < 1e-9, `合计费用 ${cost!.totalCost} 应为 6.0`);
  return `输入 ¥${cost!.inputCost.toFixed(4)} + 输出 ¥${cost!.outputCost.toFixed(4)} = ¥${cost!.totalCost.toFixed(4)}`;
});
check("费用：缓存命中输入走 0.05 元/百万（闲时），高峰翻倍", () => {
  const offPeak = estimateCost("deepseek-v4-flash", {
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
    cachedInputTokens: 1_000_000
  }, monday(8));
  assert.ok(Math.abs(offPeak!.inputCost - 0.05) < 1e-9, "缓存命中闲时应为 0.05 元/百万");
  const peak = estimateCost("deepseek-v4-flash", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
    cachedInputTokens: 1_000_000
  }, monday(10));
  assert.equal(peak!.tier, "peak");
  assert.ok(Math.abs(peak!.inputCost - 0.10) < 1e-9, "缓存命中高峰应为 0.10 元/百万");
  assert.ok(Math.abs(peak!.outputCost - 9.0) < 1e-9, "输出高峰应为 9.0 元/百万");
  return `缓存命中闲时 ¥0.05/百万，高峰 ¥0.10/百万；输出高峰 ¥9.0/百万`;
});
check("费用：未知模型与空用量返回 null，不编数", () => {
  assert.equal(estimateCost("gpt-4o", {
    inputTokens: 100,
    outputTokens: 100,
    totalTokens: 200,
    cachedInputTokens: 0
  }, new Date()), null, "未内置价格的模型应返回 null");
  assert.equal(estimateCost("deepseek-v4-flash", null, new Date()), null, "空用量应返回 null");
  return "未知模型/空用量 → null";
});

console.log("=== 工具页：预览统计与费用估算（步骤 4）===");
// 实施步骤 4：纯本地统计（零 LLM 调用），词典覆盖 / 估算 token / 闲时与高峰费用 / 时长。
// 预览数据全部提前计算（check 回调内只做同步断言）。
const previewText = "これは私の本です。毎日日本語を勉強しています。";
const previewSegments = splitIntoSegments(previewText, "doc:preview");
const previewStats = await countSegmentTokens(previewSegments);
const previewEstimate = estimateAnalysisTokens(previewSegments.length, previewStats.unmissedTokens, "full");

check("工具页：预览统计不重不漏、助词命中/普通词未命中", () => {
  assert.ok(previewStats.totalTokens > 0, "应有 token");
  assert.equal(
    previewStats.matchedTokens + previewStats.unmissedTokens,
    previewStats.totalTokens,
    "命中 + 未命中必须等于总数"
  );
  assert.ok(previewStats.matchedTokens >= 3, "は/の/です 至少 3 个应命中");
  assert.ok(previewStats.unmissedTokens > 0, "普通词（これ/私/本/勉強）应未命中交 LLM");
  return `total ${previewStats.totalTokens} = 命中 ${previewStats.matchedTokens} + 未命中 ${previewStats.unmissedTokens}`;
});
check("工具页：token 估算 = 段级开销 + 未命中 token 开销", () => {
  const expectedOutput = previewSegments.length * previewCoefficients.outputTokensPerSegmentOverhead
    + previewStats.unmissedTokens * previewCoefficients.outputTokensPerUnmissedToken;
  assert.equal(previewEstimate.outputTokens, expectedOutput, "输出估算应精确等于系数公式");
  const expectedInput = previewSegments.length * previewCoefficients.inputTokensPerSegment
    + previewStats.unmissedTokens * previewCoefficients.inputTokensPerUnmissedToken;
  assert.equal(previewEstimate.inputTokens, expectedInput, "输入估算应精确等于系数公式");
  assert.equal(
    previewEstimate.totalTokens,
    previewEstimate.inputTokens + previewEstimate.outputTokens,
    "总 token = 输入 + 输出"
  );
  return `输入 ${previewEstimate.inputTokens} / 输出 ${previewEstimate.outputTokens} / 总 ${previewEstimate.totalTokens}`;
});
check("工具页：段级字段档位系数 full > standard > minimal（设计文档 3.8）", () => {
  const standard = estimateAnalysisTokens(previewSegments.length, previewStats.unmissedTokens, "standard");
  const minimal = estimateAnalysisTokens(previewSegments.length, previewStats.unmissedTokens, "minimal");
  assert.equal(
    previewCoefficientsByProfile.full.outputTokensPerSegmentOverhead,
    3500,
    "full 段级开销保持历史标定 3500"
  );
  assert.equal(
    previewCoefficientsByProfile.standard.outputTokensPerSegmentOverhead,
    2200,
    "standard 段级开销 2200（字段合并 + 键级省略）"
  );
  assert.equal(
    previewCoefficientsByProfile.minimal.outputTokensPerSegmentOverhead,
    1500,
    "minimal 段级开销 1500（仅翻译 + 语法）"
  );
  assert.ok(standard.outputTokens < previewEstimate.outputTokens, "standard 输出应少于 full");
  assert.ok(minimal.outputTokens < standard.outputTokens, "minimal 输出应少于 standard");
  assert.ok(standard.totalTokens < previewEstimate.totalTokens, "standard 总 token 应少于 full");
  return `full ${previewEstimate.outputTokens} → standard ${standard.outputTokens} → minimal ${minimal.outputTokens} 输出 tokens`;
});
check("工具页：费用两档估算（闲时 ≤ 高峰）", () => {
  const cost = estimatePreviewCost("deepseek-v4-flash", previewEstimate);
  assert.ok(cost, "内置模型应有价格表");
  assert.ok(cost!.offPeak !== null && cost!.peak !== null, "两档都应可估算");
  assert.ok(cost!.offPeak! <= cost!.peak!, "闲时单价应不高于高峰");
  return `闲时 ¥${cost!.offPeak!.toFixed(4)} / 高峰 ¥${cost!.peak!.toFixed(4)}`;
});
check("工具页：未知模型费用返回 null（不编数）", () => {
  assert.equal(estimatePreviewCost("gpt-4o", previewEstimate), null);
  return "未知模型 → null，前端显示「价格未知」";
});
check("工具页：时长估算随输出 token 单调", () => {
  const short = estimateDurationSeconds(100);
  const long = estimateDurationSeconds(10_000);
  assert.ok(long > short, "输出越多时长越长");
  assert.equal(short, 3, "ceil(100/40)=3 秒");
  return `${short} 秒 → ${long} 秒`;
});

console.log("=== 工具页：仅词典分析与批量预览（端到端）===");
// startDictionaryOnly：零 LLM 调用，只落库词典命中的瘦身 token，段级字段全 null；
// previewAnalysis：结构、汇总与 provider 信息。
const toolsDir = path.resolve(process.cwd(), "data", "_verify");
const toolsFile = path.join(toolsDir, "tools.db");
fs.rmSync(toolsDir, { recursive: true, force: true });
const toolsDb = await createDatabase(toolsFile);
const toolsRepo = new DocumentRepository(toolsDb);
const toolsDoc = toolsRepo.create({
  title: "工具页验证",
  sourceText: "これは私の本です。",
  targetLevel: "auto"
});
const toolsService = new AnalysisService(toolsRepo, { current: mockProvider }, noContentDict, new NullGlossTranslator(), "v-test");
const dictOnlyProgress = await toolsService.startDictionaryOnly(toolsDoc.id);
const dictOnlyRows = toolsDb.all<{ result_json: string; usage_json: string | null; provider: string; model: string }>(
  "SELECT result_json, usage_json, provider, model FROM segment_analyses"
);
const dictOnlyAnalysis = dictOnlyRows.length > 0
  ? JSON.parse(dictOnlyRows[0]!.result_json) as {
      translation: string | null;
      tone: string | null;
      schemaVersion?: number;
      dictionaryCoverage?: { matched: number; total: number };
      tokens: Array<{ surface: string; source?: string; particleFunction?: unknown }>;
    }
  : null;
const toolsPreview = await toolsService.previewAnalysis([toolsDoc.id, "doc:missing"]);
toolsDb.close();
fs.rmSync(toolsDir, { recursive: true, force: true });

check("仅词典：全部段落库、token 全 dictionary 来源且瘦身", () => {
  assert.ok(dictOnlyProgress, "仅词典分析应返回进度");
  assert.equal(dictOnlyProgress!.status, "ready", "零 LLM 调用应直接完成");
  assert.equal(dictOnlyProgress!.completedSegments, dictOnlyProgress!.totalSegments);
  assert.ok(dictOnlyAnalysis, "应落库 segment_analyses");
  assert.equal(dictOnlyAnalysis!.tokens.length, 3, "は/の/です 三个命中");
  assert.deepEqual(
    dictOnlyAnalysis!.tokens.map((token) => token.surface),
    ["は", "の", "です"]
  );
  for (const token of dictOnlyAnalysis!.tokens) {
    assert.equal(token.source, "dictionary");
    assert.ok(!("particleFunction" in token), "瘦身 token 不应含恒定 null 键");
  }
  assert.deepEqual(dictOnlyAnalysis!.dictionaryCoverage, { matched: 3, total: 6 });
  return `落库 3 个 dictionary token / coverage 3/6 / status=ready`;
});
check("仅词典：段级字段 null、零用量、来源标记 dictionary", () => {
  assert.equal(dictOnlyAnalysis!.translation, null, "段级语义字段应为 null（不编造）");
  assert.equal(dictOnlyAnalysis!.tone, null);
  assert.equal(dictOnlyAnalysis!.schemaVersion, 1);
  assert.equal(dictOnlyRows[0]!.usage_json, "null", "零 LLM 调用应无用量记录");
  assert.equal(dictOnlyRows[0]!.provider, "dictionary");
  assert.equal(dictOnlyRows[0]!.model, "local");
  return "provider=dictionary / model=local / usage=null";
});
check("工具页：previewAnalysis 汇总、provider 信息与跳过缺失文章", () => {
  assert.equal(toolsPreview.documents.length, 1, "不存在的文章应被跳过");
  const doc = toolsPreview.documents[0]!;
  assert.equal(doc.documentId, toolsDoc.id);
  assert.equal(doc.matchedTokens + doc.unmissedTokens, doc.totalTokens, "命中+未命中=总数");
  assert.equal(doc.matchedTokens, 3);
  assert.ok(doc.estimatedTotalTokens > 0);
  assert.equal(doc.estimatedCost, null, "mock-model 不在价格表 → 不编数");
  assert.equal(toolsPreview.provider.configured, true);
  assert.equal(toolsPreview.provider.model, "mock-model");
  assert.equal(toolsPreview.dictionaryVersion, getDictionaryVersion());
  assert.deepEqual(toolsPreview.totals.matchedTokens, doc.matchedTokens, "totals 应等于单篇汇总");
  assert.deepEqual(toolsPreview.totals.estimatedTotalTokens, doc.estimatedTotalTokens);
  return `coverage ${Math.round(doc.dictionaryCoverage * 100)}% / 预计 ${doc.estimatedTotalTokens} tokens / 缺失文章已跳过`;
});

console.log("=== OllamaProvider：离线断言（零网络请求）===");
// 设计文档 3.9：本地 provider 不依赖 key/余额，输出预算被压缩到 8K 上限
// （min(LLM_MAX_TOKENS, 8192)），配合 num_ctx=预算+4096 保护 16GB VRAM 不 OOM。
// 此处只构造实例验证公开契约，不发起任何网络调用（离线可跑）。
const ollamaProvider = new OllamaProvider({
  providerName: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "qwen3.5:9b",
  temperature: 0.2,
  maxTokens: 12_000,
  timeoutMs: 300_000,
  debugLogging: false,
  debugLogFile: ""
});
check("Ollama：configured 恒 true（localhost 免鉴权，无 key 概念）", () => {
  assert.equal(ollamaProvider.configured, true, "本地 provider 不应要求 API key");
  assert.equal(ollamaProvider.protocol, "openai", "协议面保持 openai 以复用调用路径");
  assert.equal(ollamaProvider.model, "qwen3.5:9b");
  return "configured=true / protocol=openai / model=qwen3.5:9b";
});
check("provider 声明各自的输出估算模型（云端与本地不可混用）", () => {
  const cloudProvider = buildLlmProvider({
    llmProvider: "deepseek",
    llmProtocol: "openai",
    llmBaseUrl: "https://api.deepseek.com",
    llmApiKey: "sk-verify-only",
    llmModel: "deepseek-v4-flash",
    llmTemperature: 0.2,
    llmMaxTokens: 12_000,
    llmTimeoutMs: 300_000,
    llmThinkingType: "enabled",
    llmReasoningEffort: "minimal",
    llmDebugLogging: false,
    llmDebugLogFile: ""
  });
  assert.deepEqual(
    cloudProvider.outputTokenModel,
    deepseekOutputTokenModel,
    "OpenAI 兼容 provider 用云端标定系数"
  );
  assert.deepEqual(
    ollamaProvider.outputTokenModel,
    localOutputTokenModel,
    "Ollama provider 用本地标定系数（think 关闭，无固定推理开销）"
  );
  return `deepseek → ${deepseekOutputTokenModel.tokensPerCharacter}/字符；`
    + `ollama → ${localOutputTokenModel.tokensPerCharacter}/字符`;
});
check("Ollama：输出预算压到 8K 上限（内存保护）", () => {
  assert.equal(ollamaProvider.completionTokenBudget, 8_192, "maxTokens=12000 应被压到 8192");
  const smallBudget = new OllamaProvider({
    providerName: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3.5:9b",
    temperature: 0.2,
    maxTokens: 5_000,
    timeoutMs: 300_000,
    debugLogging: false,
    debugLogFile: ""
  });
  assert.equal(smallBudget.completionTokenBudget, 5_000, "低于 8K 的配置应保持原值");
  return "min(12000, 8192)=8192；min(5000, 8192)=5000";
});
const ollamaBalance = await ollamaProvider.fetchBalance();
check("Ollama：fetchBalance 返回 null（无余额端点，前端显示不可用）", () => {
  assert.equal(ollamaBalance, null, "本地 provider 不应编造余额");
  return "balance=null";
});
check("Ollama：配置上限再高也不超过 8192（防 OOM 兜底）", () => {
  const huge = new OllamaProvider({
    providerName: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3.5:9b",
    temperature: 0.2,
    maxTokens: 100_000,
    timeoutMs: 300_000,
    debugLogging: false,
    debugLogFile: ""
  });
  assert.equal(huge.completionTokenBudget, 8_192, "100K 配置也必须压到 8K");
  return "min(100000, 8192)=8192";
});
/*
 * 2026-09-01 新增（调查报告根因 3）：configured 恒 true 使服务未启动时
 * provider 仍判定可用，每个句段各跑满 timeout 才失败（当时 60s × N 段）。
 * 现在 analyze() 前先探活 /api/tags，把配置问题一次性暴露成可操作错误。
 * 端口 1 是特权端口，本机必然无服务 → 连接被立即拒绝，不产生网络出站。
 */
const probeText = "こんにちは。";
const probeBoundaries = tokenizeJapanese(probeText, "probe:0");
const unreachableProvider = new OllamaProvider({
  providerName: "ollama",
  baseUrl: "http://127.0.0.1:1",
  model: "qwen3.5:9b",
  temperature: 0.2,
  maxTokens: 8_192,
  timeoutMs: 300_000,
  debugLogging: false,
  debugLogFile: ""
});
const probeOutcome = await unreachableProvider.analyze({
  segments: [{
    status: "queued",
    id: "probe:0",
    index: 0,
    startOffset: 0,
    endOffset: probeText.length,
    speaker: null,
    documentId: "doc-probe",
    text: probeText,
    errorMessage: null
  }],
  tokenBoundaries: [{ segmentId: "probe:0", tokens: probeBoundaries }],
  surroundingContext: [{ segmentId: "probe:0", context: [] }],
  contentType: "dialogue",
  targetLevel: "auto",
  promptVersion: "verify",
  segmentFields: "standard",
  signal: new AbortController().signal
}).then(
  () => null,
  (error: unknown) => error
);
check("Ollama：服务未启动时快速失败并给出可操作提示", () => {
  assert.ok(probeOutcome !== null, "连不上服务时不该返回成功");
  assert.ok(
    probeOutcome instanceof ProviderConfigurationError,
    `应为配置错误（而非超时）后快速失败，实际：${String(probeOutcome)}`
  );
  assert.match(probeOutcome.message, /未启动|无法连接/u, "错误信息要能指导用户去启动 Ollama");
  return `ProviderConfigurationError：${probeOutcome.message.slice(0, 48)}…`;
});

console.log("=== LLM 设置：合并 / 脱敏 / 热切换（零网络请求）===");
// 设计文档 llm-settings-design.md：db 覆盖 .env、apiKey 脱敏回传与保留、
// holder 热切换（保存即生效、无需重启）。AnalysisService 经 holder 读 provider
// 的路径由上方 threeLayer/tools 断言覆盖（构造参数已改为 { current: mockProvider }）。
const settingsDefaults: LlmSettings = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  apiKey: "sk-env-secret",
  model: "deepseek-chat",
  temperature: 0.2,
  maxTokens: 12_000,
  segmentFields: "standard",
  thinkingType: "enabled",
  reasoningEffort: "minimal"
};

check("设置：merge 时 db 覆盖 env，未覆盖字段保持 env", () => {
  const merged = mergeLlmSettings(settingsDefaults, {
    provider: "ollama",
    model: "qwen3.5:9b"
  });
  assert.equal(merged.provider, "ollama", "db 的 provider 应覆盖 env");
  assert.equal(merged.model, "qwen3.5:9b", "db 的 model 应覆盖 env");
  assert.equal(merged.baseUrl, "https://api.deepseek.com", "未覆盖字段应保持 env 值");
  assert.equal(merged.apiKey, "sk-env-secret", "apiKey 未覆盖时应保持 env 值");
  assert.equal(merged.segmentFields, "standard", "档位未覆盖时应保持 env 值");
  return "provider/model 来自 db；baseUrl/apiKey/档位来自 env";
});

check("设置：apiKey 脱敏为「前 6 位…后 4 位」格式", () => {
  assert.equal(maskApiKey("sk-49af12345678be98"), "sk-49a…be98");
  assert.equal(maskApiKey("short"), "short", "过短 key 应原样返回（不暴露位数差异）");
  assert.equal(maskApiKey(null), null);
  assert.equal(maskApiKey(""), "", "空串原样返回，保持「空 = 无 key」语义");
  return "sk-49a…be98 / 短 key 原样 / 空与 null 保持";
});

check("设置：apiKey 空 / masked 值视为未修改，保留库中原值", () => {
  const stored: Partial<LlmSettings> = { apiKey: "sk-49af12345678be98" };
  const keptByEmpty = resolveApiKey({ apiKey: "" } as LlmSettingsInput, stored);
  assert.equal(keptByEmpty, "sk-49af12345678be98", "空值应保留原 key");
  const keptByMasked = resolveApiKey({ apiKey: "sk-49a…be98" } as LlmSettingsInput, stored);
  assert.equal(keptByMasked, "sk-49af12345678be98", "回传 masked 值应保留原 key");
  const replaced = resolveApiKey({ apiKey: "sk-new-key" } as LlmSettingsInput, stored);
  assert.equal(replaced, "sk-new-key", "新 key 应直接采用");
  return "空 → 保留；masked → 保留；新值 → 替换";
});

check("设置：parse 校验口径与 config 一致（temperature/maxTokens 边界）", () => {
  const valid = parseLlmSettings({
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3.5:9b",
    temperature: 0.2,
    maxTokens: 12_000,
    segmentFields: "standard"
  });
  assert.equal(valid.provider, "ollama", "合法输入应通过（thinkingType 等可省略）");
  assert.equal(valid.segmentFields, "standard", "缺省档位应为 standard");
  assert.throws(
    () => parseLlmSettings({ ...valid, temperature: 3 }),
    "temperature 超过 2 应被拒绝"
  );
  assert.throws(
    () => parseLlmSettings({ ...valid, maxTokens: 0 }),
    "maxTokens 小于 1 应被拒绝"
  );
  return "合法输入通过；越界值被拒绝";
});

// 热切换：走真实的 createProviderRegistry holder，replace 后 current 立即变化。
const registryConfig = {
  llmProvider: "deepseek",
  llmProtocol: "openai",
  llmBaseUrl: "https://api.deepseek.com",
  llmApiKey: "sk-test",
  llmModel: "deepseek-chat",
  llmTemperature: 0.2,
  llmMaxTokens: 12_000,
  llmTimeoutMs: 300_000,
  llmThinkingType: "enabled",
  llmReasoningEffort: "minimal",
  llmDebugLogging: false,
  llmDebugLogFile: "",
  ttsProvider: "disabled"
} as unknown as AppConfig;
const settingsRegistry = createProviderRegistry(registryConfig);

check("设置：holder 热切换后 current 立即指向新 provider", () => {
  const before = settingsRegistry.llm.current;
  assert.equal(before.name, "deepseek", "初始 provider 应来自构造配置");
  settingsRegistry.llm.replace(buildLlmProvider({
    llmProvider: "ollama",
    llmProtocol: "openai",
    llmBaseUrl: "http://127.0.0.1:11434",
    llmApiKey: undefined,
    llmModel: "qwen3.5:9b",
    llmTemperature: 0.2,
    llmMaxTokens: 12_000,
    llmTimeoutMs: 300_000,
    llmThinkingType: undefined,
    llmReasoningEffort: "minimal",
    llmDebugLogging: false,
    llmDebugLogFile: ""
  }));
  const after = settingsRegistry.llm.current;
  assert.equal(after.name, "ollama", "replace 后 current 应指向新实例");
  assert.notEqual(after, before, "current 必须是新对象，旧引用不受影响");
  assert.equal(before.configured, true, "旧引用仍可继续使用（进行中的请求不受打断）");
  return "deepseek → ollama；旧引用存活";
});

check("设置：buildLlmProvider 分支（disabled / 未知 provider）", () => {
  const disabled = buildLlmProvider({
    ...(registryConfig as LlmBuildConfig),
    llmProvider: "disabled",
    llmApiKey: undefined
  });
  assert.equal(disabled.configured, false, "disabled 应构造为未配置实例");
  assert.equal(disabled.name, "disabled");
  assert.throws(
    () => buildLlmProvider({
      ...(registryConfig as LlmBuildConfig),
      llmProvider: "weird" as never
    }),
    /Unsupported LLM provider/,
    "未知 provider 必须抛错，防止静默 fallback"
  );
  return "disabled → configured=false；weird → 抛错";
});

console.log("=== 多配置管理（profiles）：迁移 / 预设 / 保留 / 切换语义（零网络请求）===");

check("多配置：旧数据（无 profiles）迁移为内置双配置并激活匹配项", () => {
  // 老用户：db 只有单组 ollama 设置
  const migrated = ensureLlmProfiles({
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "qwen3.5:9b",
    apiKey: "sk-old-key"
  });
  assert.equal(migrated.profiles.length, 2, "应生成内置双配置");
  assert.equal(migrated.profiles[0]!.name, "DeepSeek 云端", "第一个应为 DeepSeek 云端");
  assert.equal(migrated.profiles[1]!.name, "本地 Ollama", "第二个应为本地 Ollama");
  assert.equal(migrated.profiles[1]!.model, "qwen3.5:9b", "Ollama 预设模型应为 qwen3.5:9b");
  assert.equal(migrated.profiles[1]!.apiKey, "sk-old-key", "db 中已有 apiKey 应迁移到匹配的内置配置");
  assert.equal(migrated.activeProfileId, "profile-ollama", "应激活与当前 provider 匹配的内置配置");
  return "双配置（DeepSeek + Ollama qwen3.5:9b）；激活 ollama；apiKey 迁移";
});

check("多配置：全新用户无 db 设置时默认激活 DeepSeek；自定义端点保留为自定义配置", () => {
  const fresh = ensureLlmProfiles({});
  assert.equal(fresh.profiles.length, 2, "无设置也应有内置双配置");
  assert.equal(fresh.activeProfileId, "profile-deepseek", "无设置时默认激活 DeepSeek");

  const custom = ensureLlmProfiles({
    provider: "openai-compatible",
    baseUrl: "https://x.example.com/v1",
    model: "my-model"
  });
  assert.equal(custom.profiles.length, 3, "自定义连接参数 → 自定义配置 + 内置双配置");
  assert.equal(custom.activeProfileId, "profile-current", "自定义配置应激活");
  assert.equal(custom.profiles[0]!.name, "自定义配置");
  assert.equal(custom.profiles[0]!.model, "my-model");
  return "fresh → 激活 deepseek；custom → 3 配置且激活自定义";
});

check("多配置：已有 profiles 时原样保留，无效 activeProfileId 回退到第一个", () => {
  const profiles: LlmProfile[] = [
    { id: "a", name: "A", provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: null, model: "deepseek-chat", temperature: 0.2, maxTokens: 12_000, segmentFields: "standard", thinkingType: null, reasoningEffort: null },
    { id: "b", name: "B", provider: "ollama", baseUrl: "http://127.0.0.1:11434", apiKey: null, model: "qwen3.5:9b", temperature: 0.2, maxTokens: 12_000, segmentFields: "standard", thinkingType: null, reasoningEffort: null }
  ];
  const kept = ensureLlmProfiles({ profiles, activeProfileId: "nonexistent" });
  assert.equal(kept.profiles.length, 2, "profiles 应原样保留（不重建）");
  assert.equal(kept.activeProfileId, "a", "无效 activeProfileId 应回退到第一个");
  const valid = ensureLlmProfiles({ profiles, activeProfileId: "b" });
  assert.equal(valid.activeProfileId, "b", "有效 activeProfileId 应保留");
  return "已有 profiles 不重建；无效 id 回退首项";
});

check("多配置：parse 接受 profiles/activeProfileId，顶层字段以激活配置为准", () => {
  const parsed = parseLlmSettings({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-top",
    model: "deepseek-chat",
    temperature: 0.2,
    maxTokens: 12_000,
    segmentFields: "standard",
    profiles: [
      { id: "p1", name: "云端", provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-1", model: "deepseek-chat", temperature: 0.2, maxTokens: 12_000, segmentFields: "standard" },
      { id: "p2", name: "本地", provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:9b", temperature: 0.2, maxTokens: 12_000, segmentFields: "standard" }
    ],
    activeProfileId: "p2"
  });
  assert.equal(parsed.profiles?.length, 2, "profiles 应被解析");
  assert.equal(parsed.activeProfileId, "p2", "activeProfileId 应被解析");
  assert.equal(parsed.profiles?.[1]?.apiKey, undefined, "profile 级 apiKey 未提供时为 undefined（zod nullish 语义）");
  return "profiles/activeProfileId 进 schema；apiKey nullish 可省";
});

check("多配置：PUT 归一化——新请求激活切换，逐 profile apiKey 保留", () => {
  const stored: Partial<LlmSettings> = {
    profiles: [
      { id: "p1", name: "DeepSeek 云端", provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-49af12345678be98", model: "deepseek-chat", temperature: 0.2, maxTokens: 12_000, segmentFields: "standard", thinkingType: null, reasoningEffort: null },
      { id: "p2", name: "本地 Ollama", provider: "ollama", baseUrl: "http://127.0.0.1:11434", apiKey: null, model: "qwen3.5:9b", temperature: 0.2, maxTokens: 12_000, segmentFields: "standard", thinkingType: null, reasoningEffort: null }
    ],
    activeProfileId: "p1"
  };
  // 前端保存：切换到 p2；p1 的 apiKey 回传 masked 值（视为未修改，应保留库中原 key）
  const parsed = parseLlmSettings({
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    apiKey: null,
    model: "qwen3.5:9b",
    temperature: 0.2,
    maxTokens: 12_000,
    segmentFields: "standard",
    profiles: [
      { id: "p1", name: "DeepSeek 云端", provider: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "sk-49a…be98", model: "deepseek-chat", temperature: 0.2, maxTokens: 12_000, segmentFields: "standard" },
      { id: "p2", name: "本地 Ollama", provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3.5:9b", temperature: 0.2, maxTokens: 12_000, segmentFields: "standard" }
    ],
    activeProfileId: "p2"
  });
  const resolved = resolveSettingsSave(parsed, stored);
  assert.equal(resolved.activeProfileId, "p2", "激活 id 应切换为 p2");
  assert.equal(resolved.settings.provider, "ollama", "顶层生效字段应以激活配置为准");
  assert.equal(resolved.settings.apiKey, null, "Ollama 激活时无 key");
  assert.equal(resolved.profiles[0]!.apiKey, "sk-49af12345678be98", "p1 回传 masked key 应保留库中原值");
  assert.equal(resolved.settings.profiles?.length, 2, "settings 应携带全部 profiles");
  return "激活切换 → 顶层跟随；p1 masked key 保留库中原值";
});

check("多配置：PUT 归一化——旧单组请求兼容（无 profiles 字段）", () => {
  const resolved = resolveSettingsSave(parseLlmSettings({
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    apiKey: "sk-new",
    model: "qwen3.5:9b",
    temperature: 0.2,
    maxTokens: 12_000,
    segmentFields: "standard"
  }), {});
  assert.equal(resolved.profiles.length, 2, "旧请求也应以双配置为底");
  assert.equal(resolved.settings.provider, "ollama", "旧请求展开字段应生效");
  assert.equal(resolved.settings.apiKey, "sk-new", "新 key 应直接采用");
  assert.equal(resolved.activeProfileId, resolved.profiles[0]!.id, "旧请求应激活第一个配置");
  return "无 profiles → 双配置底 + 展开字段写回 + 新 key 采用";
});

console.log("=== 内容词词典层：可插拔接口与降级（AC-01..AC-08）===");
// 设计文档 docs/jmdict-integration-design.md 接口层验证。数据源未定时默认 none，
// 行为与接入前完全一致；任何数据源只需实现接口即可接入，主链路零改动。
const contentSegment = (id: string, text: string) => ({
  id,
  documentId: "doc-content",
  index: 0,
  text,
  startOffset: 0,
  endOffset: text.length,
  speaker: null,
  status: "queued" as const,
  errorMessage: null
});

const fixtureDict = new FixtureContentDictionary();
await fixtureDict.initialize();
const noneDict = new NullContentDictionary();

// 自定义 provider：对「の」也返回命中，用于验证固定库优先于内容层
const onoProvider: ContentDictionaryProvider = {
  id: "test-ono",
  label: "t",
  ready: () => true,
  async initialize() {},
  lookup: (query: ContentLookupQuery) =>
    query.surface === "の"
      ? {
          surface: "の",
          reading: "ノ",
          partsOfSpeech: ["助詞"],
          glosses: [{ lang: "zh", text: "之（应被固定库覆盖）" }],
          source: "test",
          matchedBy: "surface" as const
        }
      : null,
  stats: () => ({ entries: 1, loaded: true, version: "t", license: "none" })
};

// 自定义 provider：对「本」返回命中，用于验证可扩展性（不走注册表）
const bookProvider: ContentDictionaryProvider = {
  id: "test-book",
  label: "t",
  ready: () => true,
  async initialize() {},
  lookup: (query: ContentLookupQuery) =>
    query.surface === "本"
      ? {
          surface: "本",
          reading: "ホン",
          partsOfSpeech: ["名詞"],
          glosses: [{ lang: "en", text: "book" }],
          source: "test",
          matchedBy: "surface" as const
        }
      : null,
  stats: () => ({ entries: 1, loaded: true, version: "t", license: "none" })
};

// 会初始化抛错的数据源，用于验证静默降级
const failingProvider: ContentDictionaryProvider = {
  id: "failing",
  label: "f",
  ready: () => false,
  async initialize() {
    throw new Error("datasource corrupt");
  },
  lookup: () => null,
  stats: () => ({ entries: 0, loaded: false, version: null, license: null })
};

const cText1 = "これは私の本です。";
const cSeg1 = contentSegment("c:1", cText1);
const cBound1 = tokenizeJapanese(cText1, "c:1");
const prepFixtureTime = await prepareSegmentTokens(
  contentSegment("c:time", "時間です。"),
  tokenizeJapanese("時間です。", "c:time"),
  fixtureDict
);
const prepFixtureBook = await prepareSegmentTokens(
  contentSegment("c:book", "本です。"),
  tokenizeJapanese("本です。", "c:book"),
  fixtureDict
);
const prepOno = await prepareSegmentTokens(cSeg1, cBound1, onoProvider);
const prepBook = await prepareSegmentTokens(
  contentSegment("c:book", "本です。"),
  tokenizeJapanese("本です。", "c:book"),
  bookProvider
);
const prepNone = await prepareSegmentTokens(cSeg1, cBound1, noneDict);
const prepUndef = await prepareSegmentTokens(cSeg1, cBound1, undefined);
const safeProvider = await initializeContentDictionary(failingProvider);

check("内容词典：默认 none 实现始终返回 null 且 ready=false", () => {
  assert.equal(noneDict.lookup({ surface: "時間" }), null, "none 不得编造任何释义");
  assert.equal(noneDict.ready(), false, "none 不应进入就绪状态");
  assert.equal(noneDict.stats().entries, 0);
  return "none → null / ready=false / entries=0";
});
check("内容词典：createContentDictionary 默认回 none，未知 id 回落 none", () => {
  assert.ok(createContentDictionary() instanceof NullContentDictionary, "无参应回 none");
  assert.ok(
    createContentDictionary("fixture") instanceof FixtureContentDictionary,
    "fixture 应回样例实现"
  );
  assert.ok(
    createContentDictionary("unknown-id") instanceof NullContentDictionary,
    "未知 id 静默回落 none"
  );
  return `list=${listContentDictionaryIds().join(",")}`;
});
check("内容词典：resolveContentDictionaryId 优先级 db → env → 默认 none", () => {
  assert.equal(resolveContentDictionaryId("fixture", "jmdict"), "fixture", "db 覆盖 env");
  assert.equal(resolveContentDictionaryId(undefined, "jmdict"), "jmdict", "无 db 取 env");
  assert.equal(resolveContentDictionaryId(), "none", "全缺省 none");
  return "db > env > none";
});
check("内容词典：fixture 表面直击 + 多语言优先级 zh>ja>en", () => {
  const hit = fixtureDict.lookup({ surface: "時間" });
  assert.ok(hit, "時間应被 fixture 命中");
  assert.equal(hit!.surface, "時間");
  assert.equal(hit!.matchedBy, "surface");
  assert.deepEqual(hit!.partsOfSpeech, ["名詞"]);
  const gloss = preferredGloss(hit!);
  assert.equal(gloss!.lang, "zh", "展示语言应优先中文");
  assert.equal(gloss!.text, "时间");
  assert.equal(joinGlosses(hit!, "en"), "time；hours", "同语言多义用全角分号拼接");
  return "時間 → zh「时间」优先；en 含 time/hours";
});
check("内容词典：原形回退 surface→lemma（AC-04）", () => {
  const hit = fixtureDict.lookup({ surface: "かかって", lemma: "かかる" });
  assert.ok(hit, "かかって 无 surface 命中，应回退 lemma かかる");
  assert.equal(hit!.surface, "かかる", "命中词形应替换为 lemma");
  assert.equal(hit!.matchedBy, "lemma", "应标记 lemma 回退");
  return "かかって → かかる（matchedBy=lemma）";
});
check("内容词典：未命中返回 null 不编造（AC-02）", () => {
  assert.equal(fixtureDict.lookup({ surface: "存在しない語" }), null, "未收录词不得编造释义");
  return "未命中 → null，交 LLM";
});
check("内容词典：内容层命中走 localTokens，不进 LLM（AC-06 零费用前置）", () => {
  const timeHit = prepFixtureTime.localTokens.find((token) => token.surface === "時間");
  assert.ok(timeHit, "時間应被内容层本地命中");
  assert.equal(timeHit!.category, "word", "内容词类别为 word");
  assert.equal(timeHit!.confidence, 0.8, "内容层置信度 0.8（低于固定库 1.0）");
  assert.equal(timeHit!.source, "dictionary");
  assert.equal(prepFixtureTime.llmBoundaries.length, 0, "全部命中，无 LLM 候选");
  return `時間 → word/conf=${timeHit!.confidence}/${timeHit!.gloss}；llm=0`;
});
check("内容词典：未命中内容词仍落 LLM（不误吞）", () => {
  const bookLlm = prepFixtureBook.llmBoundaries.find((boundary) => boundary.surface === "本");
  assert.ok(bookLlm, "本不在 fixture 中应进 LLM 候选");
  return "本 → llm 候选（不误判为命中）";
});
check("内容词典：固定用法库优先于内容层（AC-03）", () => {
  const noToken = prepOno.localTokens.find((token) => token.surface === "の");
  assert.ok(noToken, "の应被固定库命中");
  assert.equal(noToken!.category, "particle", "固定库类别粒子，不被内容层 word 覆盖");
  assert.equal(noToken!.confidence, 1, "固定库置信度 1.0，内容层 0.8 未篡位");
  return "の → particle/conf=1（内容层 0.8 未覆盖）";
});
check("内容词典：自定义 provider 直传即生效，无需注册（AC-07 可扩展性）", () => {
  const bookToken = prepBook.localTokens.find((token) => token.surface === "本");
  assert.ok(bookToken, "本应被自定义 provider 本地命中");
  assert.equal(bookToken!.category, "word");
  assert.equal(bookToken!.confidence, contentDictionaryConfidence);
  return "自定义 provider 不经注册即接入主链路";
});
check("内容词典：默认 none 与不传参行为完全一致（AC-01/AC-08 回归基线）", () => {
  const surf = (arr: Array<{ surface: string }>): string => arr.map((item) => item.surface).sort().join(",");
  assert.equal(
    surf(prepNone.localTokens),
    surf(prepUndef.localTokens),
    "none 与不传参：localTokens 一致"
  );
  assert.equal(
    surf(prepNone.llmBoundaries),
    surf(prepUndef.llmBoundaries),
    "none 与不传参：llmBoundaries 一致"
  );
  assert.deepEqual(
    prepNone.localTokens.map((token) => token.surface).sort(),
    ["です", "は", "の"].sort()
  );
  assert.deepEqual(
    prepNone.llmBoundaries.map((boundary) => boundary.surface).sort(),
    ["これ", "私", "本"].sort()
  );
  return "none ≡ undefined；命中 は/の/です，LLM これ/私/本";
});
check("内容词典：初始化抛错静默降级到 none（AC-05）", () => {
  assert.ok(safeProvider instanceof NullContentDictionary, "应回落 NullContentDictionary");
  assert.equal(safeProvider.ready(), false);
  assert.equal(safeProvider.lookup({ surface: "時間" }), null, "降级后无释义");
  return "抛错 → NullContentDictionary，分析不中断";
});
check("内容词典：固定库规模未变（AC-08 回归基线不退化）", () => {
  const stats = getDictionaryStats();
  assert.ok(
    stats.particles >= 40 && stats.functional >= 30 && stats.endings >= 10,
    "固定库下限维持"
  );
  return `助词 ${stats.particles} / 功能词 ${stats.functional} / 句末 ${stats.endings}`;
});

console.log("=== 内容词典：jmdedict-common 真实数据源适配器（AC-07 端到端）===");
// 验证「新增数据源 = 实现接口 + 注册表加一行，主链路零改动」这条路径真实可用。
// 不依赖 9MB 真实索引做断言（保持 verify 自包含），用临时精简索引验证同一代码路径。
const tmpJmdict = path.join(os.tmpdir(), `jmdict-test-${Date.now()}.json`);
fs.writeFileSync(
  tmpJmdict,
  JSON.stringify({
    version: "test-1",
    source: "jmdict",
    license: "CC BY-SA 3.0 (EDRDG)",
    entries: {
      時間: { r: "じかん", p: ["名詞"], g: [{ l: "en", t: "time" }, { l: "en", t: "hours" }] },
      かかる: { r: "かかる", p: ["動詞"], g: [{ l: "en", t: "to take (time)" }] }
    }
  })
);
const jmdictTest = new JmdictCommonProvider({ indexPath: tmpJmdict });
await jmdictTest.initialize();

const prepJmd = await prepareSegmentTokens(
  contentSegment("c:jmd", "時間です。"),
  tokenizeJapanese("時間です。", "c:jmd"),
  jmdictTest
);
const safeJmd = await initializeContentDictionary(
  new JmdictCommonProvider({ indexPath: "/no/such/jmdict-index.json" })
);

check("内容词典：jmdedict-common surface 直击 + 英文释义", () => {
  const hit = jmdictTest.lookup({ surface: "時間" });
  assert.ok(hit, "時間应命中");
  assert.equal(hit!.matchedBy, "surface");
  assert.equal(hit!.reading, "じかん");
  assert.deepEqual(hit!.partsOfSpeech, ["名詞"]);
  const gloss = preferredGloss(hit!);
  assert.ok(gloss, "应有首选释义");
  assert.equal(gloss!.lang, "en", "当前仅英文释义（JMdict 官方多语不含中文）");
  assert.equal(gloss!.text, "time");
  return "時間 → じかん / 名詞 / time（en）";
});
check("内容词典：jmdedict-common 接入第四层后内容词走本地（端到端）", () => {
  const timeHit = prepJmd.localTokens.find((token) => token.surface === "時間");
  assert.ok(timeHit, "時間应被内容层本地命中");
  assert.equal(timeHit!.category, "word");
  assert.equal(timeHit!.confidence, 0.8);
  assert.equal(prepJmd.llmBoundaries.length, 0, "全部命中，无 LLM 候选");
  return "時間 → word/0.8；llm=0（验证第四层真实可用）";
});
check("内容词典：jmdedict-common 索引缺失静默降级（AC-05，真实数据源路径）", () => {
  assert.ok(safeJmd instanceof NullContentDictionary, "缺失应回落 Null");
  return "缺索引 → Null，分析不中断";
});

// 真实索引若已构建（data/jmdict-common-index.json，gitignore），做一次抽样核对
const realJmdictPath = fileURLToPath(new URL("../data/jmdict-common-index.json", import.meta.url));
if (fs.existsSync(realJmdictPath)) {
  const realJmdict = new JmdictCommonProvider();
  await realJmdict.initialize();
  check("内容词典：jmdedict-common 真实索引抽样（data/ 索引已构建）", () => {
    assert.ok(realJmdict.ready(), "真实索引应就绪");
    const t = realJmdict.lookup({ surface: "時間" });
    assert.ok(t && t.surface === "時間" && t.glosses.some((g) => g.text === "time"), "時間→time");
    const e = realJmdict.lookup({ surface: "営業" });
    assert.ok(e && e.glosses.some((g) => /business/i.test(g.text)), "営業→business");
    const b = realJmdict.lookup({ surface: "本" });
    assert.ok(b, "本应被收录");
    const k = realJmdict.lookup({ surface: "かかって", lemma: "かかる" });
    assert.ok(k && k.matchedBy === "lemma" && k.surface === "かかる", "かかって→かかる(lemma)");
    return `真实索引就绪：${realJmdict.stats().entries} 表面键 / v${realJmdict.stats().version}`;
  });
}
fs.unlinkSync(tmpJmdict);

console.log("=== 内容词典：激活容器（CONTENT_DICT_ID 驱动，主链路接入）===");
// 验证「数据源经 env 解析 + 安全初始化，注入 AnalysisService」这条激活路径：
// 默认 none ⇒ 不加载索引、行为不变（AC-01）；设 jmdedict-common ⇒ 加载真实索引。
const holderDefault = await createContentDictionaryHolder(undefined);
const holderJmd = await createContentDictionaryHolder("jmdict-common");

check("内容词典：激活容器默认 none（CONTENT_DICT_ID 未设 → 不加载，AC-01）", () => {
  assert.ok(
    holderDefault.current instanceof NullContentDictionary,
    "未设 CONTENT_DICT_ID 应为 none，不加载任何索引"
  );
  return "默认 → none，行为与接入前完全一致";
});
check("内容词典：激活容器按 env 加载 jmdedict-common（端到端激活）", () => {
  if (fs.existsSync(realJmdictPath)) {
    assert.ok(holderJmd.current.ready(), "索引存在时应就绪");
    const hit = holderJmd.current.lookup({ surface: "時間" });
    assert.ok(hit && hit.glosses.some((g) => g.text === "time"), "時間→time");
    return "CONTENT_DICT_ID=jmdict-common → 真实索引加载就绪，可注入主链路";
  }
  assert.ok(
    holderJmd.current instanceof NullContentDictionary,
    "索引缺失时静默回落 none（AC-05）"
  );
  return "索引缺失 → 静默回落 none（AC-05）";
});

console.log("");
console.log("=== 内容词典：设置页后端（零 LLM，§6.5 阶段 A）===");
// 解析校验：只接受注册表中的真实源（fixture 测试专用不暴露）
check("内容词典：设置解析只接受已注册真实源", () => {
  assert.doesNotThrow(() => parseContentDictionarySettings({ id: "none" }), "none 合法");
  assert.doesNotThrow(() => parseContentDictionarySettings({ id: "jmdict-common" }), "jmdict-common 合法");
  assert.throws(() => parseContentDictionarySettings({ id: "fixture" }), "fixture 不暴露给设置页");
  assert.throws(() => parseContentDictionarySettings({ id: "bogus" }), "未知 id 拒绝");
  return "none/jmdict-common 通过；fixture/bogus 拒绝";
});

// db 值优先于 env（热切换前置）：createContentDictionaryHolder(dbValue, envValue)
const holderDbWins = await createContentDictionaryHolder("jmdict-common", "none");
const holderEnvFallback = await createContentDictionaryHolder(null, "jmdict-common");
check("内容词典：设置页 db 值优先于 env（热切换前置）", () => {
  assert.equal(holderDbWins.current.id, "jmdict-common", "db=jmdict-common 应覆盖 env=none");
  assert.equal(holderEnvFallback.current.id, "jmdict-common", "db 空时回退 env");
  return "db 优先于 env，env 为空回退 none";
});

// 热切换：replace() 改变 current（mirror LlmProviderHolder）
const swapHolder: ContentDictionaryHolder = {
  current: new NullContentDictionary(),
  replace(next: ContentDictionaryProvider): void { swapHolder.current = next; }
};
check("内容词典：holder.replace() 热切换改变 current", () => {
  const before = swapHolder.current.id;
  swapHolder.replace(createContentDictionary("jmdict-common"));
  assert.notEqual(swapHolder.current.id, before, "替换后应指向新 provider");
  assert.equal(swapHolder.current.id, "jmdict-common");
  return "replace() 生效，进行中批次下一循环自然读到新源";
});

// 设置存储往返：写库 → 读库
const cdSettingsDir = path.resolve(process.cwd(), "data", "_verify_cd");
const cdSettingsFile = path.join(cdSettingsDir, "cd.db");
fs.rmSync(cdSettingsDir, { recursive: true, force: true });
const cdSettingsDb = await createDatabase(cdSettingsFile);
check("内容词典：设置写库/读库往返一致", () => {
  saveContentDictionarySettings(cdSettingsDb, { id: "jmdict-common" });
  const loaded = loadContentDictionarySettings(cdSettingsDb);
  assert.ok(loaded && loaded.id === "jmdict-common", "读回应与写入一致");
  saveContentDictionarySettings(cdSettingsDb, { id: "none" });
  const loadedNone = loadContentDictionarySettings(cdSettingsDb);
  assert.ok(loadedNone && loadedNone.id === "none", "可切回 none");
  return "写库/读库往返一致（key=contentDictionary）";
});
cdSettingsDb.close();
fs.rmSync(cdSettingsDir, { recursive: true, force: true });

console.log("");
console.log("=== 内容词典：译中（Ollama 中文释义，§6.5 阶段 B）===");
// 译中器接口 + 译中注入 prepareSegmentTokens 的两条关键路径：
// (a) 启用且成功 → 英文释义被替换为中文；
// (b) 禁用 / 抛错 → 回退英文原文，不阻断分析。
function makeFakeTranslator(result: string, shouldThrow = false): GlossTranslator {
  return {
    isEnabled: () => true,
    setEnabled: () => {},
    isAvailable: async () => true,
    translate: async () => {
      if (shouldThrow) {
        throw new Error("译中失败（模拟）");
      }
      return result;
    }
  };
}

const transFixture = new FixtureContentDictionary();
await transFixture.initialize();
const prepTranslated = await prepareSegmentTokens(
  { id: "t:1", text: "営業です。" } as never,
  tokenizeJapanese("営業です。", "t:1"),
  transFixture,
  makeFakeTranslator("商务")
);
const prepThrowing = await prepareSegmentTokens(
  { id: "t:2", text: "営業です。" } as never,
  tokenizeJapanese("営業です。", "t:2"),
  transFixture,
  makeFakeTranslator("商务", true)
);
const prepDisabled = await prepareSegmentTokens(
  { id: "t:3", text: "営業です。" } as never,
  tokenizeJapanese("営業です。", "t:3"),
  transFixture,
  new NullGlossTranslator()
);

check("译中：启用译中器时内容词英文释义被替换为中文", () => {
  const tok = prepTranslated.localTokens.find((t) => t.surface === "営業");
  assert.ok(tok, "営業 应被内容词典命中");
  assert.equal(tok.gloss, "商务", "gloss 应为译中结果首义项");
  assert.equal(tok.explanation, "商务", "explanation 应为译中结果");
  return "営業→business→商务（译中生效，source=dictionary）";
});
check("译中：译中器抛错时回退英文原文，不阻断分析", () => {
  const tok = prepThrowing.localTokens.find((t) => t.surface === "営業");
  assert.ok(tok, "営業 仍应被内容词典命中");
  assert.equal(tok.gloss, "business", "回退：gloss 保留英文");
  assert.equal(tok.explanation, "business", "回退：explanation 保留英文");
  return "译中失败 → 回退英文原文（分析不中断）";
});
check("译中：译中器禁用（NullGlossTranslator）时显示英文原文", () => {
  const tok = prepDisabled.localTokens.find((t) => t.surface === "営業");
  assert.ok(tok, "営業 仍应被内容词典命中");
  assert.equal(tok.explanation, "business", "禁用译中 → 英文原文");
  return "禁用译中 → 内容词显示英文（与接入前一致）";
});

// OllamaGlossTranslator 缓存往返：种子 vocabulary_cache 后无需联网即可命中，
// 且 isAvailable() 在 Ollama 未启动时不抛错（返回 false）。
const gtDir = path.resolve(process.cwd(), "data", "_verify_gt");
const gtFile = path.join(gtDir, "gt.db");
fs.rmSync(gtDir, { recursive: true, force: true });
const gtDb = await createDatabase(gtFile);
const gtTranslator = new OllamaGlossTranslator({
  database: gtDb,
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen3.5:9b",
  enabled: true
});
// 直接种子缓存避免真实联网；在 check 前 await 完毕（check 不支持异步工作体）
gtDb.run(
  "INSERT OR REPLACE INTO vocabulary_cache (term, translation, lang, created_at) VALUES (?, ?, 'zh', ?)",
  ["business", "商务", new Date().toISOString()]
);
const gtCacheResult = {
  out: await gtTranslator.translate("business"),
  enabled: gtTranslator.isEnabled(),
  avail: await gtTranslator.isAvailable()
};
check("译中：OllamaGlossTranslator 缓存命中零推理、可用探活不抛错", () => {
  // 直接种子缓存，避免真实联网；结果已在 check 前 await 完毕
  assert.equal(gtCacheResult.out, "商务", "命中缓存应直接返回已存中文，无需联网");
  assert.equal(gtCacheResult.enabled, true, "默认启用");
  // 探活契约只保证「返回布尔且不抛错」——Ollama 是否在运行取决于本机环境，
  // 不能把「未启动」硬编码为期望值（否则本机跑着 Ollama 时断言会假失败）。
  assert.equal(
    typeof gtCacheResult.avail,
    "boolean",
    `isAvailable() 应返回布尔且不抛错（当前 ${String(gtCacheResult.avail)}）`
  );
  return `缓存命中→商务；isAvailable 返回 ${String(gtCacheResult.avail)}（布尔、未抛错）`;
});

console.log("");
console.log("=== 内容词典：译中设置后端（零 LLM，§6.5 阶段 B）===");
check("译中：设置解析只接受布尔 enabled", () => {
  assert.doesNotThrow(() => parseGlossTranslationSettings({ enabled: true }), "true 合法");
  assert.doesNotThrow(() => parseGlossTranslationSettings({ enabled: false }), "false 合法");
  assert.throws(() => parseGlossTranslationSettings({ enabled: "yes" }), "非布尔拒绝");
  assert.throws(() => parseGlossTranslationSettings({}), "缺 enabled 拒绝");
  return "true/false 通过；非布尔/缺字段拒绝";
});
const gtSettingsDir = path.resolve(process.cwd(), "data", "_verify_gts");
const gtSettingsFile = path.join(gtSettingsDir, "gts.db");
fs.rmSync(gtSettingsDir, { recursive: true, force: true });
const gtSettingsDb = await createDatabase(gtSettingsFile);
check("译中：设置写库/读库往返一致（key=glossTranslation）", () => {
  saveGlossTranslationSettings(gtSettingsDb, { enabled: false });
  const loaded = loadGlossTranslationSettings(gtSettingsDb);
  assert.ok(loaded && loaded.enabled === false, "读回应与写入一致");
  saveGlossTranslationSettings(gtSettingsDb, { enabled: true });
  const loadedOn = loadGlossTranslationSettings(gtSettingsDb);
  assert.ok(loadedOn && loadedOn.enabled === true, "可切回 true");
  return "写库/读库往返一致（key=glossTranslation）";
});
gtSettingsDb.close();
fs.rmSync(gtSettingsDir, { recursive: true, force: true });
gtDb.close();
fs.rmSync(gtDir, { recursive: true, force: true });

console.log("");
let failed = 0;
for (const result of results) {
  const mark = result.passed ? "PASS" : "FAIL";
  if (!result.passed) {
    failed += 1;
  }
  console.log(`[${mark}] ${result.name}`);
  console.log(`       ${result.detail}`);
}

console.log("");
console.log(`${results.length - failed}/${results.length} 通过`);
if (failed > 0) {
  process.exit(1);
}
