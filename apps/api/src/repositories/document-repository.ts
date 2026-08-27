import { randomUUID } from "node:crypto";

import {
  analysisProgressSchema,
  documentDetailSchema,
  documentStatusSchema,
  documentSummarySchema,
  segmentAnalysisSchema,
  segmentStatusSchema,
  type AnalysisProgress,
  type CreateDocumentInput,
  type DocumentDetail,
  type DocumentSummary,
  type Segment,
  type SegmentAnalysis,
  type SegmentView,
  type UpdateDocumentInput
} from "@nihongonote/core";

import type { AppDatabase } from "../db/database.js";
import { splitIntoSegments } from "../segmentation.js";
import type { LlmUsage } from "../providers/types.js";

interface DocumentRow {
  id: string;
  title: string;
  source_text: string;
  target_level: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface DocumentSummaryRow {
  id: string;
  title: string;
  target_level: string;
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

function toSegment(row: SegmentRow, analysis: SegmentAnalysis | null): SegmentView {
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
    analysis
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

  public list(search?: string): DocumentSummary[] {
    const normalizedSearch = search?.trim();
    const rows = normalizedSearch
      ? this.database.all<DocumentSummaryRow>(`
          SELECT
            d.id,
            d.title,
            d.target_level,
            d.status,
            COUNT(s.id) AS segment_count,
            COALESCE(SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_segment_count,
            d.created_at,
            d.updated_at
          FROM documents d
          LEFT JOIN segments s ON s.document_id = d.id
          WHERE d.title LIKE ? OR d.source_text LIKE ?
          GROUP BY d.id
          ORDER BY d.updated_at DESC
        `, [`%${normalizedSearch}%`, `%${normalizedSearch}%`])
      : this.database.all<DocumentSummaryRow>(`
          SELECT
            d.id,
            d.title,
            d.target_level,
            d.status,
            COUNT(s.id) AS segment_count,
            COALESCE(SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_segment_count,
            d.created_at,
            d.updated_at
          FROM documents d
          LEFT JOIN segments s ON s.document_id = d.id
          GROUP BY d.id
          ORDER BY d.updated_at DESC
        `);

    return rows.map((row) => documentSummarySchema.parse({
      id: row.id,
      title: row.title,
      targetLevel: row.target_level,
      status: documentStatusSchema.parse(row.status),
      segmentCount: Number(row.segment_count),
      completedSegmentCount: Number(row.completed_segment_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  public getById(documentId: string): DocumentDetail | undefined {
    const row = this.database.get<DocumentRow>(`
      SELECT id, title, source_text, target_level, status, created_at, updated_at
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

    return documentDetailSchema.parse({
      id: row.id,
      title: row.title,
      sourceText: row.source_text,
      targetLevel: row.target_level,
      status: documentStatusSchema.parse(row.status),
      segmentCount: segmentRows.length,
      completedSegmentCount: segmentRows.filter((segment) => segment.status === "completed").length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      segments: segmentRows.map((segment) => toSegment(segment, analyses.get(segment.id) ?? null))
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
    return document.segments.map(({ analysis: _analysis, ...segment }) => segment);
  }

  public create(input: CreateDocumentInput): DocumentDetail {
    const documentId = randomUUID();
    const now = new Date().toISOString();
    const title = input.title ?? defaultTitle(input.sourceText);
    const segments = splitIntoSegments(input.sourceText, documentId);

    this.database.transaction(() => {
      this.database.run(`
        INSERT INTO documents (id, title, source_text, target_level, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'draft', ?, ?)
      `, [
        documentId,
        title,
        input.sourceText,
        input.targetLevel,
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

    this.database.run(`
      UPDATE documents
      SET title = ?, target_level = ?, updated_at = ?
      WHERE id = ?
    `, [title, targetLevel, now, documentId]);

    return this.getById(documentId);
  }

  public markDocumentAnalyzing(documentId: string): boolean {
    return this.database.run(`
      UPDATE documents
      SET status = 'analyzing', updated_at = ?
      WHERE id = ?
    `, [new Date().toISOString(), documentId]) > 0;
  }

  public markSegmentProcessing(segmentId: string): boolean {
    return this.database.run(`
      UPDATE segments
      SET status = 'processing', error_message = NULL, updated_at = ?
      WHERE id = ?
    `, [new Date().toISOString(), segmentId]) > 0;
  }

  public markSegmentFailed(segmentId: string, errorMessage: string): boolean {
    const normalizedMessage = errorMessage.trim().slice(0, 2_000) || "分析失败";
    return this.database.run(`
      UPDATE segments
      SET status = 'failed', error_message = ?, updated_at = ?
      WHERE id = ?
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
    this.database.transaction(() => {
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
      this.database.run(`
        UPDATE segments
        SET status = 'completed', error_message = NULL, updated_at = ?
        WHERE id = ?
      `, [now, segmentId]);
    });

    return true;
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
