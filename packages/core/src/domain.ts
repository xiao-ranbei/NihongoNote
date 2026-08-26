import { z } from "zod";

export const targetLevelSchema = z.enum(["auto", "n5", "n4", "n3", "n2", "n1"]);
export type TargetLevel = z.infer<typeof targetLevelSchema>;

export const documentStatusSchema = z.enum(["draft", "analyzing", "ready", "failed"]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const segmentStatusSchema = z.enum(["queued", "processing", "completed", "failed"]);
export type SegmentStatus = z.infer<typeof segmentStatusSchema>;

export const documentSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  targetLevel: targetLevelSchema,
  status: documentStatusSchema,
  segmentCount: z.number().int().nonnegative(),
  completedSegmentCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type DocumentSummary = z.infer<typeof documentSummarySchema>;

export const segmentSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  index: z.number().int().nonnegative(),
  text: z.string().min(1),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  speaker: z.string().min(1).nullable(),
  status: segmentStatusSchema
});
export type Segment = z.infer<typeof segmentSchema>;

export const documentDetailSchema = documentSummarySchema.extend({
  sourceText: z.string(),
  segments: z.array(segmentSchema)
});
export type DocumentDetail = z.infer<typeof documentDetailSchema>;

export const createDocumentInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  sourceText: z.string().min(1).max(2_000_000),
  targetLevel: targetLevelSchema.default("auto")
});
export type CreateDocumentInput = z.infer<typeof createDocumentInputSchema>;

export const updateDocumentInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  targetLevel: targetLevelSchema.optional()
}).refine((value) => value.title !== undefined || value.targetLevel !== undefined, {
  message: "At least one document field must be provided"
});
export type UpdateDocumentInput = z.infer<typeof updateDocumentInputSchema>;

export const tokenAnalysisSchema = z.object({
  tokenId: z.string().min(1),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
  surface: z.string().min(1),
  lemma: z.string().min(1).nullable(),
  reading: z.string().min(1).nullable(),
  partOfSpeech: z.string().min(1).nullable(),
  conjugation: z.string().min(1).nullable(),
  gloss: z.string().min(1).nullable(),
  particleFunction: z.string().min(1).nullable(),
  grammarPoint: z.string().min(1).nullable(),
  explanation: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1).nullable()
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
