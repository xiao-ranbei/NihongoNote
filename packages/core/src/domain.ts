import { z } from "zod";

export const targetLevelSchema = z.enum(["auto", "n5", "n4", "n3", "n2", "n1"]);
export type TargetLevel = z.infer<typeof targetLevelSchema>;

export const documentStatusSchema = z.enum(["draft", "analyzing", "ready", "failed"]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const contentTypeSchema = z.enum([
  "lesson",
  "article",
  "dialogue",
  "news_expository",
  "note",
  "other"
]);
export type ContentType = z.infer<typeof contentTypeSchema>;

export const contentTypeSourceSchema = z.enum(["default", "user"]);
export type ContentTypeSource = z.infer<typeof contentTypeSourceSchema>;

export const contentTypeSuggestionSchema = z.object({
  contentType: contentTypeSchema,
  confidence: z.number().min(0).max(1).nullable(),
  reason: z.string().min(1).nullable(),
  source: z.enum(["heuristic", "ai"])
});
export type ContentTypeSuggestion = z.infer<typeof contentTypeSuggestionSchema>;

export const contentBlockSchema = z.object({
  id: z.string().min(1),
  index: z.number().int().nonnegative(),
  kind: z.enum(["title", "body", "dialogue", "example", "note", "other"]),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  analysisEnabled: z.boolean(),
  detectedType: contentTypeSchema.nullable(),
  selectedType: contentTypeSchema.nullable()
});
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const segmentStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);
export type SegmentStatus = z.infer<typeof segmentStatusSchema>;

/**
 * 五类对应界面上五种下划线线型（见 requirements.md 的线型规则）：
 * 实线 word / 双线 particle / 虚线 functional / 点线 adverb / 波浪线 grammar。
 * 「functional」指助动词、补助形容词这类承担语法功能但不算助词的功能词；
 * 缺了它，模型只能把助动词塞进 word，界面上就永远画不出虚线。
 */
export const tokenCategorySchema = z.enum([
  "word",
  "particle",
  "functional",
  "adverb",
  "grammar"
]);
export type TokenCategory = z.infer<typeof tokenCategorySchema>;

export const documentSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  targetLevel: targetLevelSchema,
  contentType: contentTypeSchema,
  contentTypeSource: contentTypeSourceSchema,
  contentTypeSuggestion: contentTypeSuggestionSchema.nullable(),
  status: documentStatusSchema,
  segmentCount: z.number().int().nonnegative(),
  completedSegmentCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const createDocumentInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  sourceText: z.string().min(1).max(2_000_000),
  targetLevel: targetLevelSchema.default("auto"),
  contentType: contentTypeSchema.optional()
}).strict();
export type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>;

export const updateDocumentInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  targetLevel: targetLevelSchema.optional(),
  contentType: contentTypeSchema.optional()
}).strict().refine((value) =>
  value.title !== undefined || value.targetLevel !== undefined || value.contentType !== undefined, {
  message: "At least one document field must be provided"
});
export type UpdateDocumentInput = z.infer<typeof updateDocumentInputSchema>;

export const updateSegmentInputSchema = z.object({
  speaker: z.string().trim().min(1).max(100).nullable().optional()
}).strict().refine((value) => value.speaker !== undefined, {
  message: "At least one segment field must be provided"
});
export type UpdateSegmentInput = z.infer<typeof updateSegmentInputSchema>;

/**
 * 置信度。
 *
 * 模型时不时把数字写成字符串（"0.9"），按原样严格要求会让整段分析结果作废。
 * 这里只做「数字字符串 → 数字」的还原，不猜 high/medium/low 这类词的语义：
 * 猜错了比直接报错更危险，那种情况宁可让调用方看到明确的 schema 错误。
 */
export const confidenceSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}, z.number().min(0).max(1).nullable());

export const tokenAnalysisSchema = z.object({
  tokenId: z.string().min(1),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  surface: z.string().min(1),
  category: tokenCategorySchema.default("word"),
  // 事实/解释字段：LLM 全量路径必需；词典/形态素命中路径可省略
  // （瘦身存储，设计文档 3.7——省略的键不落库，不存恒定 null 的宽表）。
  // 旧数据（全部字段为 null 或字符串）依然通过，向后兼容。
  lemma: z.string().min(1).nullable().optional(),
  reading: z.string().min(1).nullable().optional(),
  partOfSpeech: z.string().min(1).nullable().optional(),
  conjugation: z.string().min(1).nullable().optional(),
  gloss: z.string().min(1).nullable().optional(),
  particleFunction: z.string().min(1).nullable().optional(),
  grammarPoint: z.string().min(1).nullable().optional(),
  explanation: z.string().min(1).nullable().optional(),
  // 模型偶发整段省略 confidence（实测 `tokens.0.confidence: Required`，finish_reason=stop，
  // 不是截断而是输出完整性问题）。default(null) 让缺字段降级为「无置信度」而非整段失败。
  confidence: confidenceSchema.default(null),
  /**
   * 分析来源（设计文档 3.7）：
   * - "dictionary"：本地固定用法库/用户回填命中（瘦身存储）
   * - "llm"：LLM 分析
   * 旧数据无此字段（向后兼容）。
   */
  source: z.enum(["dictionary", "llm"]).optional()
});
export type TokenAnalysis = z.infer<typeof tokenAnalysisSchema>;

export const segmentAnalysisSchema = z.object({
  segmentId: z.string().min(1),
  // 模型偶发省略顶层字段（实测 politeness: Required，与 token 的 confidence 同类问题）。
  // 单字段缺失降级为 null（UI 显示「未提供」），不让整段 29 个正确字段一起作废。
  // 注意：segmentId 与 tokens 保持 Required —— 缺了它们本段分析没有定位依据。
  translation: z.string().min(1).nullable().default(null),
  grammarSummary: z.string().min(1).nullable().default(null),
  tone: z.string().min(1).nullable().default(null),
  politeness: z.string().min(1).nullable().default(null),
  impliedMeaning: z.string().min(1).nullable().default(null),
  replyReason: z.string().min(1).nullable().default(null),
  uncertaintyNote: z.string().min(1).nullable().default(null),
  tokens: z.array(tokenAnalysisSchema),
  /**
   * result_json 自身版本号（issues I-7）：迁移/校验不必依赖外部列。
   * 旧数据无此字段（向后兼容）。
   */
  schemaVersion: z.number().int().positive().optional(),
  /**
   * 词典覆盖率（设计文档 3.7）：matched=本地命中的 token 数 / total=全部 token 数。
   * 预览与结果都可展示覆盖率；旧数据无此字段。
   */
  dictionaryCoverage: z.object({
    matched: z.number().int().nonnegative(),
    total: z.number().int().positive()
  }).optional()
});
export type SegmentAnalysis = z.infer<typeof segmentAnalysisSchema>;

const nullableOverrideStringSchema = z.string().trim().min(1).nullable();
const tokenAnalysisOverrideSchema = z.object({
  tokenId: z.string().min(1),
  category: tokenCategorySchema.optional(),
  lemma: nullableOverrideStringSchema.optional(),
  reading: nullableOverrideStringSchema.optional(),
  partOfSpeech: nullableOverrideStringSchema.optional(),
  conjugation: nullableOverrideStringSchema.optional(),
  gloss: nullableOverrideStringSchema.optional(),
  particleFunction: nullableOverrideStringSchema.optional(),
  grammarPoint: nullableOverrideStringSchema.optional(),
  explanation: nullableOverrideStringSchema.optional(),
  confidence: confidenceSchema.optional()
}).strict().refine((value) => Object.keys(value).some((key) => key !== "tokenId"), {
  message: "At least one token analysis field must be provided"
});
export type TokenAnalysisOverride = z.infer<typeof tokenAnalysisOverrideSchema>;

export const segmentAnalysisOverrideSchema = z.object({
  translation: z.string().trim().min(1).optional(),
  grammarSummary: z.string().trim().min(1).optional(),
  tone: z.string().trim().min(1).optional(),
  politeness: z.string().trim().min(1).optional(),
  impliedMeaning: nullableOverrideStringSchema.optional(),
  replyReason: nullableOverrideStringSchema.optional(),
  uncertaintyNote: nullableOverrideStringSchema.optional(),
  tokens: z.array(tokenAnalysisOverrideSchema).max(10_000).optional()
}).strict().superRefine((value, context) => {
  const hasTopLevelOverride = Object.entries(value).some(([key, field]) =>
    key !== "tokens" && field !== undefined
  );
  if (!hasTopLevelOverride && (!value.tokens || value.tokens.length === 0)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one analysis override must be provided"
    });
  }
  if (value.tokens && new Set(value.tokens.map((token) => token.tokenId)).size !== value.tokens.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tokens"],
      message: "Token overrides must have unique tokenId values"
    });
  }
});
export type SegmentAnalysisOverride = z.infer<typeof segmentAnalysisOverrideSchema>;

export const analysisRevisionSchema = z.object({
  revision: z.number().int().positive(),
  override: segmentAnalysisOverrideSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type AnalysisRevision = z.infer<typeof analysisRevisionSchema>;

export const segmentSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  index: z.number().int().nonnegative(),
  text: z.string().min(1),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  speaker: z.string().min(1).nullable(),
  status: segmentStatusSchema,
  errorMessage: z.string().min(1).nullable()
});
export type Segment = z.infer<typeof segmentSchema>;

export const segmentViewSchema = segmentSchema.extend({
  analysis: segmentAnalysisSchema.nullable(),
  originalAnalysis: segmentAnalysisSchema.nullable(),
  userRevision: analysisRevisionSchema.nullable()
});
export type SegmentView = z.infer<typeof segmentViewSchema>;

export const documentDetailSchema = documentSummarySchema.extend({
  sourceText: z.string(),
  contentBlocks: z.array(contentBlockSchema),
  segments: z.array(segmentViewSchema)
});
export type DocumentDetail = z.infer<typeof documentDetailSchema>;

export const analysisProgressSchema = z.object({
  documentId: z.string().min(1),
  status: documentStatusSchema,
  totalSegments: z.number().int().nonnegative(),
  queuedSegments: z.number().int().nonnegative(),
  processingSegments: z.number().int().nonnegative(),
  completedSegments: z.number().int().nonnegative(),
  failedSegments: z.number().int().nonnegative(),
  /**
   * 本篇文章历次分析请求的 token 用量聚合（同批次只计一次）。
   * 尚无任何分析记录时（status=draft）为 null。
   */
  usage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable()
  }).nullable(),
  /**
   * 按模型内置单价与当前高峰/闲时估算出的累计费用（元）。
   * 模型不在内置价格表内，或没有用量数据时为 null。
   */
  cost: z.object({
    model: z.string().min(1),
    currency: z.literal("CNY"),
    tier: z.enum(["peak", "off-peak"]),
    cachedInputTokens: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    inputCost: z.number().nonnegative(),
    outputCost: z.number().nonnegative(),
    totalCost: z.number().nonnegative()
  }).nullable()
});
export type AnalysisProgress = z.infer<typeof analysisProgressSchema>;

export const llmBalanceEntrySchema = z.object({
  currency: z.string().min(1),
  totalBalance: z.string().min(1),
  grantedBalance: z.string().nullable(),
  toppedUpBalance: z.string().nullable()
});
export type LlmBalanceEntry = z.infer<typeof llmBalanceEntrySchema>;

/**
 * 服务端代理 DeepSeek /user/balance 后的响应。
 * apiKeyMasked 只含脱敏 key（sk-49af…be98），完整 key 不出服务端。
 */
export const llmBalanceSchema = z.object({
  isAvailable: z.boolean(),
  apiKeyMasked: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().url(),
  entries: z.array(llmBalanceEntrySchema).min(1)
});
export type LlmBalance = z.infer<typeof llmBalanceSchema>;

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("api"),
  database: z.literal("ok"),
  timestamp: z.string().datetime()
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional()
});
export type ApiError = z.infer<typeof apiErrorSchema>;
