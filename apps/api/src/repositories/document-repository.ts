import { randomUUID } from "node:crypto";

import {
  analysisRevisionSchema,
  analysisProgressSchema,
  contentBlockSchema,
  contentTypeSchema,
  contentTypeSourceSchema,
  contentTypeSuggestionSchema,
  documentDetailSchema,
  documentStatusSchema,
  documentSummarySchema,
  segmentAnalysisSchema,
  segmentAnalysisOverrideSchema,
  segmentStatusSchema,
  type AnalysisRevision,
  type AnalysisProgress,
  type ContentBlock,
  type ContentTypeSuggestion,
  type CreateDocumentInput,
  type DocumentDetail,
  type DocumentStatus,
  type DocumentSummary,
  type Segment,
  type SegmentAnalysis,
  type SegmentAnalysisOverride,
  type SegmentView,
  type UpdateDocumentInput,
  type UpdateSegmentInput
} from "@nihongonote/core";

import type { AppDatabase } from "../db/database.js";
import { splitIntoSegments } from "../segmentation.js";
import type { LlmUsage } from "../providers/types.js";

interface DocumentRow {
  id: string;
  title: string;
  source_text: string;
  target_level: string;
  content_type: string;
  content_type_source: string;
  content_type_suggestion_json: string;
  content_blocks_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface DocumentSummaryRow {
  id: string;
  title: string;
  target_level: string;
  content_type: string;
  content_type_source: string;
  content_type_suggestion_json: string;
  status: string;
  segment_count: number;
  completed_segment_count: number;
  created_at: string;
  updated_at: string;
}

interface SegmentRow {
  id: string;
  document_id: string;
  segment_index: number;
  text: string;
  start_offset: number;
  end_offset: number;
  speaker: string | null;
  status: string;
  error_message: string | null;
}

interface SegmentAnalysisRow {
  segment_id: string;
  provider: string;
  model: string;
  prompt_version: string;
  result_json: string;
  usage_json: string;
}

interface AnalysisRevisionRow {
  segment_id: string;
  revision: number;
  override_json: string;
  created_at: string;
  updated_at: string;
}

interface ProgressRow {
  document_id: string;
  status: string;
  total_segments: number;
  queued_segments: number;
  processing_segments: number;
  completed_segments: number;
  failed_segments: number;
}

function defaultTitle(sourceText: string): string {
  const firstLine = sourceText.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
  return firstLine?.slice(0, 80) || "未命名文章";
}

function suggestContentType(sourceText: string): ContentTypeSuggestion | null {
  const nonEmptyLines = sourceText.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const dialogueLines = nonEmptyLines.filter((line) => /^\s*[^：:\r\n]{1,40}[：:]/u.test(line));
  if (dialogueLines.length >= 2 && dialogueLines.length / nonEmptyLines.length >= 0.5) {
    return {
      contentType: "dialogue",
      confidence: 0.85,
      reason: "多行内容使用了稳定的角色名前缀",
      source: "heuristic"
    };
  }
  const noteLines = nonEmptyLines.filter((line) => /^\s*(?:[-*・]|[0-9０-９]+[.)、])/u.test(line));
  if (noteLines.length >= 2 && noteLines.length / nonEmptyLines.length >= 0.5) {
    return {
      contentType: "note",
      confidence: 0.7,
      reason: "多数行使用了项目符号或编号",
      source: "heuristic"
    };
  }
  return null;
}

function parseStoredAnalysis(row: SegmentAnalysisRow): SegmentAnalysis {
  let payload: unknown;
  try {
    payload = JSON.parse(row.result_json) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown JSON parse error";
    throw new Error(`Stored analysis for ${row.segment_id} is invalid JSON: ${detail}`);
  }
  return segmentAnalysisSchema.parse(payload);
}

function parseStoredJson<T>(
  value: string,
  label: string,
  parse: (payload: unknown) => T
): T {
  let payload: unknown;
  try {
    payload = JSON.parse(value) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown JSON parse error";
    throw new Error(`Stored ${label} is invalid JSON: ${detail}`);
  }
  return parse(payload);
}

function parseRevision(row: AnalysisRevisionRow): AnalysisRevision {
  return analysisRevisionSchema.parse({
    revision: Number(row.revision),
    override: parseStoredJson(
      row.override_json,
      `analysis revision for ${row.segment_id}`,
      (payload) => segmentAnalysisOverrideSchema.parse(payload)
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function applyOverride(
  original: SegmentAnalysis,
  override: SegmentAnalysisOverride
): SegmentAnalysis {
  const tokenOverrides = new Map((override.tokens ?? []).map((token) => [token.tokenId, token]));
  const {
    tokens: _tokens,
    ...analysisFields
  } = override;
  return segmentAnalysisSchema.parse({
    ...original,
    ...analysisFields,
    tokens: original.tokens.map((token) => {
      const tokenOverride = tokenOverrides.get(token.tokenId);
      if (!tokenOverride) {
        return token;
      }
      const { tokenId: _tokenId, ...fields } = tokenOverride;
      return { ...token, ...fields };
    })
  });
}

function toSegment(
  row: SegmentRow,
  originalAnalysis: SegmentAnalysis | null,
  userRevision: AnalysisRevision | null
): SegmentView {
  return {
    id: row.id,
    documentId: row.document_id,
    index: row.segment_index,
    text: row.text,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    speaker: row.speaker,
    status: segmentStatusSchema.parse(row.status),
    errorMessage: row.error_message,
    analysis: originalAnalysis && userRevision
      ? applyOverride(originalAnalysis, userRevision.override)
      : originalAnalysis,
    originalAnalysis,
    userRevision
  };
}

function toProgress(row: ProgressRow): AnalysisProgress {
  return analysisProgressSchema.parse({
    documentId: row.document_id,
    status: documentStatusSchema.parse(row.status),
    totalSegments: Number(row.total_segments),
    queuedSegments: Number(row.queued_segments),
    processingSegments: Number(row.processing_segments),
    completedSegments: Number(row.completed_segments),
    failedSegments: Number(row.failed_segments)
  });
}

export class DocumentRepository {
  public constructor(private readonly database: AppDatabase) {}

  public list(search?: string, status?: DocumentStatus): DocumentSummary[] {
    const normalizedSearch = search?.trim();
    const conditions: string[] = [];
    const params: string[] = [];
    if (normalizedSearch) {
      conditions.push("(d.title LIKE ? OR d.source_text LIKE ?)");
      params.push(`%${normalizedSearch}%`, `%${normalizedSearch}%`);
    }
    if (status) {
      conditions.push("d.status = ?");
      params.push(status);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.database.all<DocumentSummaryRow>(`
      SELECT
        d.id,
        d.title,
        d.target_level,
        d.content_type,
        d.content_type_source,
        d.content_type_suggestion_json,
        d.status,
        COUNT(s.id) AS segment_count,
        COALESCE(SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_segment_count,
        d.created_at,
        d.updated_at
      FROM documents d
      LEFT JOIN segments s ON s.document_id = d.id
      ${where}
      GROUP BY d.id
      ORDER BY d.updated_at DESC
    `, params);

    return rows.map((row) => documentSummarySchema.parse({
      id: row.id,
      title: row.title,
      targetLevel: row.target_level,
      contentType: contentTypeSchema.parse(row.content_type),
      contentTypeSource: contentTypeSourceSchema.parse(row.content_type_source),
      contentTypeSuggestion: parseStoredJson<ContentTypeSuggestion | null>(
        row.content_type_suggestion_json,
        `content type suggestion for ${row.id}`,
        (payload) => contentTypeSuggestionSchema.nullable().parse(payload)
      ),
      status: documentStatusSchema.parse(row.status),
      segmentCount: Number(row.segment_count),
      completedSegmentCount: Number(row.completed_segment_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public getById(documentId: string): DocumentDetail | undefined {
    const row = this.database.get<DocumentRow>(`
      SELECT
        id, title, source_text, target_level, content_type, content_type_source,
        content_type_suggestion_json, content_blocks_json, status, created_at, updated_at
      FROM documents
      WHERE id = ?
    `, [documentId]);

    if (!row) {
      return undefined;
    }

    const segmentRows = this.database.all<SegmentRow>(`
      SELECT id, document_id, segment_index, text, start_offset, end_offset, speaker, status, error_message
      FROM segments
      WHERE document_id = ?
      ORDER BY segment_index ASC
    `, [documentId]);
    const analysisRows = this.database.all<SegmentAnalysisRow>(`
      SELECT sa.segment_id, sa.provider, sa.model, sa.prompt_version, sa.result_json, sa.usage_json
      FROM segment_analyses sa
      INNER JOIN segments s ON s.id = sa.segment_id
      WHERE s.document_id = ?
    `, [documentId]);
    const analyses = new Map(analysisRows.map((analysisRow) => [
      analysisRow.segment_id,
      parseStoredAnalysis(analysisRow)
    ]));
    const revisionRows = this.database.all<AnalysisRevisionRow>(`
      SELECT ar.segment_id, ar.revision, ar.override_json, ar.created_at, ar.updated_at
      FROM analysis_revisions ar
      INNER JOIN segments s ON s.id = ar.segment_id
      WHERE s.document_id = ?
    `, [documentId]);
    const revisions = new Map(revisionRows.map((revisionRow) => [
      revisionRow.segment_id,
      parseRevision(revisionRow)
    ]));
    const contentTypeSuggestion = parseStoredJson<ContentTypeSuggestion | null>(
      row.content_type_suggestion_json,
      `content type suggestion for ${documentId}`,
      (payload) => contentTypeSuggestionSchema.nullable().parse(payload)
    );
    const contentBlocks = parseStoredJson<ContentBlock[]>(
      row.content_blocks_json,
      `content blocks for ${documentId}`,
      (payload) => contentBlockSchema.array().parse(payload)
    );

    return documentDetailSchema.parse({
      id: row.id,
      title: row.title,
      sourceText: row.source_text,
      targetLevel: row.target_level,
      contentType: contentTypeSchema.parse(row.content_type),
      contentTypeSource: contentTypeSourceSchema.parse(row.content_type_source),
      contentTypeSuggestion,
      contentBlocks,
      status: documentStatusSchema.parse(row.status),
      segmentCount: segmentRows.length,
      completedSegmentCount: segmentRows.filter((segment) => segment.status === "completed").length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      segments: segmentRows.map((segment) => toSegment(
        segment,
        analyses.get(segment.id) ?? null,
        revisions.get(segment.id) ?? null
      ))
    });
  }

  public getAnalysisProgress(documentId: string): AnalysisProgress | undefined {
    const row = this.database.get<ProgressRow>(`
      SELECT
        d.id AS document_id,
        d.status,
        COUNT(s.id) AS total_segments,
        COUNT(CASE WHEN s.status = 'queued' THEN 1 END) AS queued_segments,
        COUNT(CASE WHEN s.status = 'processing' THEN 1 END) AS processing_segments,
        COUNT(CASE WHEN s.status = 'completed' THEN 1 END) AS completed_segments,
        COUNT(CASE WHEN s.status = 'failed' THEN 1 END) AS failed_segments
      FROM documents d
      LEFT JOIN segments s ON s.document_id = d.id
      WHERE d.id = ?
      GROUP BY d.id
    `, [documentId]);

    return row ? toProgress(row) : undefined;
  }

  public getSegmentsForAnalysis(documentId: string): Segment[] {
    const document = this.getById(documentId);
    if (!document) {
      return [];
    }
    return document.segments.map(({
      analysis: _analysis,
      originalAnalysis: _originalAnalysis,
      userRevision: _userRevision,
      ...segment
    }) => segment);
  }

  public getSegment(segmentId: string): SegmentView | undefined {
    const row = this.database.get<SegmentRow>(`
      SELECT id, document_id, segment_index, text, start_offset, end_offset, speaker, status, error_message
      FROM segments
      WHERE id = ?
    `, [segmentId]);
    if (!row) {
      return undefined;
    }
    const analysisRow = this.database.get<SegmentAnalysisRow>(`
      SELECT segment_id, provider, model, prompt_version, result_json, usage_json
      FROM segment_analyses
      WHERE segment_id = ?
    `, [segmentId]);
    const revisionRow = this.database.get<AnalysisRevisionRow>(`
      SELECT segment_id, revision, override_json, created_at, updated_at
      FROM analysis_revisions
      WHERE segment_id = ?
    `, [segmentId]);
    return toSegment(
      row,
      analysisRow ? parseStoredAnalysis(analysisRow) : null,
      revisionRow ? parseRevision(revisionRow) : null
    );
  }

  public create(input: CreateDocumentInput): DocumentDetail {
    const documentId = randomUUID();
    const now = new Date().toISOString();
    const title = input.title ?? defaultTitle(input.sourceText);
    const segments = splitIntoSegments(input.sourceText, documentId);
    const contentTypeSuggestion = suggestContentType(input.sourceText);
    const contentBlocks: ContentBlock[] = [{
      id: `${documentId}:block:0`,
      index: 0,
      kind: contentTypeSuggestion?.contentType === "dialogue" ? "dialogue" : "body",
      startOffset: 0,
      endOffset: input.sourceText.length,
      analysisEnabled: true,
      detectedType: contentTypeSuggestion?.contentType ?? null,
      selectedType: null
    }];

    this.database.transaction(() => {
      this.database.run(`
        INSERT INTO documents (
          id, title, source_text, target_level, content_type, content_type_source,
          content_type_suggestion_json, content_blocks_json, status, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
      `, [
        documentId,
        title,
        input.sourceText,
        input.targetLevel,
        input.contentType ?? "article",
        input.contentType === undefined ? "default" : "user",
        JSON.stringify(contentTypeSuggestion),
        JSON.stringify(contentBlocks),
        now,
        now
      ]);

      for (const segment of segments) {
        this.database.run(`
          INSERT INTO segments (
            id, document_id, segment_index, text, start_offset, end_offset, speaker, status, error_message, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          segment.id,
          segment.documentId,
          segment.index,
          segment.text,
          segment.startOffset,
          segment.endOffset,
          segment.speaker,
          segment.status,
          segment.errorMessage,
          now,
          now
        ]);
      }
    });

    const document = this.getById(documentId);
    if (!document) {
      throw new Error(`Document was created but could not be loaded: ${documentId}`);
    }
    return document;
  }

  public update(documentId: string, input: UpdateDocumentInput): DocumentDetail | undefined {
    const existing = this.getById(documentId);
    if (!existing) {
      return undefined;
    }

    const now = new Date().toISOString();
    const title = input.title ?? existing.title;
    const targetLevel = input.targetLevel ?? existing.targetLevel;
    const contentType = input.contentType ?? existing.contentType;
    const contentTypeSource = input.contentType === undefined ? existing.contentTypeSource : "user";

    this.database.run(`
      UPDATE documents
      SET title = ?, target_level = ?, content_type = ?, content_type_source = ?, updated_at = ?
      WHERE id = ?
    `, [title, targetLevel, contentType, contentTypeSource, now, documentId]);

    return this.getById(documentId);
  }

  public updateSegment(segmentId: string, input: UpdateSegmentInput): SegmentView | undefined {
    const segment = this.getSegment(segmentId);
    if (!segment) {
      return undefined;
    }
    const speaker = input.speaker === undefined ? segment.speaker : input.speaker;
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(`
        UPDATE segments
        SET speaker = ?, updated_at = ?
        WHERE id = ?
      `, [speaker, now, segmentId]);
      this.database.run(`
        UPDATE documents SET updated_at = ? WHERE id = ?
      `, [now, segment.documentId]);
    });
    return this.getSegment(segmentId);
  }

  public saveAnalysisOverride(
    segmentId: string,
    input: SegmentAnalysisOverride
  ): SegmentView | undefined {
    const segment = this.getSegment(segmentId);
    if (!segment) {
      return undefined;
    }
    if (!segment.originalAnalysis) {
      throw new Error("ANALYSIS_NOT_FOUND");
    }

    const validTokenIds = new Set(segment.originalAnalysis.tokens.map((token) => token.tokenId));
    for (const token of input.tokens ?? []) {
      if (!validTokenIds.has(token.tokenId)) {
        throw new Error(`UNKNOWN_TOKEN_ID:${token.tokenId}`);
      }
    }

    const existingOverride = segment.userRevision?.override;
    const tokenOverrides = new Map(
      (existingOverride?.tokens ?? []).map((token) => [token.tokenId, token])
    );
    for (const token of input.tokens ?? []) {
      tokenOverrides.set(token.tokenId, {
        ...tokenOverrides.get(token.tokenId),
        ...token
      });
    }
    const mergedOverride = segmentAnalysisOverrideSchema.parse({
      ...existingOverride,
      ...input,
      tokens: tokenOverrides.size > 0 ? [...tokenOverrides.values()] : undefined
    });
    applyOverride(segment.originalAnalysis, mergedOverride);

    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(`
        INSERT INTO analysis_revisions (
          segment_id, revision, override_json, created_at, updated_at
        )
        VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(segment_id) DO UPDATE SET
          revision = analysis_revisions.revision + 1,
          override_json = excluded.override_json,
          updated_at = excluded.updated_at
      `, [segmentId, JSON.stringify(mergedOverride), now, now]);
      this.database.run(`
        UPDATE documents SET updated_at = ? WHERE id = ?
      `, [now, segment.documentId]);
    });
    return this.getSegment(segmentId);
  }

  public markDocumentAnalyzing(documentId: string): boolean {
    return this.database.run(`
      UPDATE documents
      SET status = 'analyzing', updated_at = ?
      WHERE id = ?
    `, [new Date().toISOString(), documentId]) > 0;
  }

  public markDocumentAnalysisCancelled(documentId: string): AnalysisProgress | undefined {
    if (!this.getAnalysisProgress(documentId)) {
      return undefined;
    }
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(`
        UPDATE segments
        SET status = 'queued', error_message = NULL, updated_at = ?
        WHERE document_id = ? AND status = 'processing'
      `, [now, documentId]);
      this.database.run(`
        UPDATE documents
        SET status = 'draft', updated_at = ?
        WHERE id = ?
      `, [now, documentId]);
    });
    return this.getAnalysisProgress(documentId);
  }

  public recoverInterruptedAnalyses(): void {
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(`
        UPDATE segments
        SET status = 'queued', error_message = NULL, updated_at = ?
        WHERE status = 'processing'
      `, [now]);
      this.database.run(`
        UPDATE documents
        SET status = 'failed', updated_at = ?
        WHERE status = 'analyzing'
          AND EXISTS (
            SELECT 1
            FROM segments
            WHERE segments.document_id = documents.id
              AND segments.status = 'queued'
          )
      `, [now]);
    });
  }

  public markSegmentProcessing(segmentId: string): boolean {
    return this.database.run(`
      UPDATE segments
      SET status = 'processing', error_message = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `, [new Date().toISOString(), segmentId]) > 0;
  }

  public markSegmentsProcessing(segmentIds: string[]): string[] {
    const claimed: string[] = [];
    const now = new Date().toISOString();
    this.database.transaction(() => {
      for (const segmentId of segmentIds) {
        const changed = this.database.run(`
          UPDATE segments
          SET status = 'processing', error_message = NULL, updated_at = ?
          WHERE id = ? AND status = 'queued'
        `, [now, segmentId]);
        if (changed > 0) {
          claimed.push(segmentId);
        }
      }
    });
    return claimed;
  }

  public markSegmentFailed(segmentId: string, errorMessage: string): boolean {
    const normalizedMessage = errorMessage.trim().slice(0, 2_000) || "分析失败";
    return this.database.run(`
      UPDATE segments
      SET status = 'failed', error_message = ?, updated_at = ?
      WHERE id = ? AND status = 'processing'
    `, [normalizedMessage, new Date().toISOString(), segmentId]) > 0;
  }

  public saveSegmentAnalysis(
    segmentId: string,
    analysis: SegmentAnalysis,
    provider: string,
    model: string,
    promptVersion: string,
    usage: LlmUsage | null
  ): boolean {
    const now = new Date().toISOString();
    let saved = false;
    this.database.transaction(() => {
      const changed = this.database.run(`
        UPDATE segments
        SET status = 'completed', error_message = NULL, updated_at = ?
        WHERE id = ? AND status = 'processing'
      `, [now, segmentId]);
      if (changed === 0) {
        return;
      }
      this.database.run(`
        INSERT INTO segment_analyses (
          segment_id, provider, model, prompt_version, result_json, usage_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(segment_id) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          prompt_version = excluded.prompt_version,
          result_json = excluded.result_json,
          usage_json = excluded.usage_json,
          updated_at = excluded.updated_at
      `, [
        segmentId,
        provider,
        model,
        promptVersion,
        JSON.stringify(analysis),
        JSON.stringify(usage),
        now,
        now
      ]);
      saved = true;
    });

    return saved;
  }

  public finalizeDocumentAnalysis(documentId: string): AnalysisProgress | undefined {
    const progress = this.getAnalysisProgress(documentId);
    if (!progress) {
      return undefined;
    }

    const status = progress.failedSegments > 0
      ? "failed"
      : progress.queuedSegments > 0 || progress.processingSegments > 0
        ? "analyzing"
        : "ready";
    this.database.run(`
      UPDATE documents
      SET status = ?, updated_at = ?
      WHERE id = ?
    `, [status, new Date().toISOString(), documentId]);

    return this.getAnalysisProgress(documentId);
  }

  public markDocumentAnalysisFailed(documentId: string, errorMessage: string): void {
    const normalizedMessage = errorMessage.trim().slice(0, 2_000) || "分析失败";
    const now = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run(`
        UPDATE segments
        SET status = 'failed', error_message = ?, updated_at = ?
        WHERE document_id = ? AND status = 'processing'
      `, [normalizedMessage, now, documentId]);
      this.database.run(`
        UPDATE documents
        SET status = 'failed', updated_at = ?
        WHERE id = ?
      `, [now, documentId]);
    });
  }

  public queueSegmentRetry(segmentId: string): string | undefined {
    const segment = this.database.get<{ document_id: string }>(`
      SELECT document_id
      FROM segments
      WHERE id = ?
    `, [segmentId]);
    if (!segment) {
      return undefined;
    }

    this.database.transaction(() => {
      this.database.run(`
        DELETE FROM segment_analyses
        WHERE segment_id = ?
      `, [segmentId]);
      this.database.run(`
        UPDATE segments
        SET status = 'queued', error_message = NULL, updated_at = ?
        WHERE id = ?
      `, [new Date().toISOString(), segmentId]);
      this.database.run(`
        UPDATE documents
        SET status = 'analyzing', updated_at = ?
        WHERE id = ?
      `, [new Date().toISOString(), segment.document_id]);
    });

    return segment.document_id;
  }

  public delete(documentId: string): boolean {
    return this.database.run("DELETE FROM documents WHERE id = ?", [documentId]) > 0;
  }
}
