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
import { createDatabase } from "../src/db/database.js";
import { escapeControlCharacters } from "../src/providers/openai-compatible.js";
import {
  hardMaxCompletionTokens,
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
