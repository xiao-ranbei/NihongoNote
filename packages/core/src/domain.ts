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
  lemma: z.string().min(1).nullable(),
  reading: z.string().min(1).nullable(),
  partOfSpeech: z.string().min(1).nullable(),
  conjugation: z.string().min(1).nullable(),
  gloss: z.string().min(1).nullable(),
  particleFunction: z.string().min(1).nullable(),
  grammarPoint: z.string().min(1).nullable(),
  explanation: z.string().min(1).nullable(),
  // 模型偶发整段省略 confidence（实测 `tokens.0.confidence: Required`，finish_reason=stop，
  // 不是截断而是输出完整性问题）。default(null) 让缺字段降级为「无置信度」而非整段失败。
  confidence: confidenceSchema.default(null)
});
export type TokenAnalysis = z.infer<typeof tokenAnalysisSchema>;

export const segmentAnalysisSchema = z.object({
  segmentId: z.string().min(1),
  translation: z.string().min(1),
  grammarSummary: z.string().min(1),
  tone: z.string().min(1),
  politeness: z.string().min(1),
  impliedMeaning: z.string().min(1).nullable(),
  replyReason: z.string().min(1).nullable(),
  uncertaintyNote: z.string().min(1).nullable(),
  tokens: z.array(tokenAnalysisSchema)
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
  failedSegments: z.number().int().nonnegative()
});
export type AnalysisProgress = z.infer<typeof analysisProgressSchema>;

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
