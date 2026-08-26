import { randomUUID } from "node:crypto";

import {
  documentDetailSchema,
  documentSummarySchema,
  segmentStatusSchema,
  type CreateDocumentInput,
  type DocumentDetail,
  type DocumentSummary,
  type Segment,
  type UpdateDocumentInput
} from "@nihongonote/core";

import type { AppDatabase } from "../db/database.js";
import { splitIntoSegments } from "../segmentation.js";

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
}

function defaultTitle(sourceText: string): string {
  const firstLine = sourceText.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
  return firstLine?.slice(0, 80) || "未命名文章";
}

function toSegment(row: SegmentRow): Segment {
  return {
    id: row.id,
    documentId: row.document_id,
    index: row.segment_index,
    text: row.text,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    speaker: row.speaker,
    status: segmentStatusSchema.parse(row.status)
  };
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
      status: row.status,
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
      SELECT id, document_id, segment_index, text, start_offset, end_offset, speaker, status
      FROM segments
      WHERE document_id = ?
      ORDER BY segment_index ASC
    `, [documentId]);

    return documentDetailSchema.parse({
      id: row.id,
      title: row.title,
      sourceText: row.source_text,
      targetLevel: row.target_level,
      status: row.status,
      segmentCount: segmentRows.length,
      completedSegmentCount: segmentRows.filter((segment) => segment.status === "completed").length,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      segments: segmentRows.map(toSegment)
    });
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
            id, document_id, segment_index, text, start_offset, end_offset, speaker, status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          segment.id,
          segment.documentId,
          segment.index,
          segment.text,
          segment.startOffset,
          segment.endOffset,
          segment.speaker,
          segment.status,
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

  public delete(documentId: string): boolean {
    return this.database.run("DELETE FROM documents WHERE id = ?", [documentId]) > 0;
  }
}
