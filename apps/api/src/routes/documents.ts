import {
  createDocumentInputSchema,
  documentStatusSchema,
  segmentAnalysisOverrideSchema,
  updateSegmentInputSchema,
  updateDocumentInputSchema
} from "@nihongonote/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { DocumentRepository } from "../repositories/document-repository.js";
import { AnalysisService } from "../services/analysis-service.js";

interface DocumentParams {
  documentId: string;
}

interface SegmentParams {
  segmentId: string;
}

const documentListQuerySchema = z.object({
  q: z.string().trim().max(500).optional(),
  status: documentStatusSchema.optional(),
  analysisStatus: documentStatusSchema.optional()
}).strict().refine((value) =>
  value.status === undefined
  || value.analysisStatus === undefined
  || value.status === value.analysisStatus, {
  message: "status and analysisStatus cannot conflict"
});
const documentParamsSchema = z.object({
  documentId: z.string().min(1).max(500)
}).strict();
const segmentParamsSchema = z.object({
  segmentId: z.string().min(1).max(500)
}).strict();

function invalidInput(reply: {
  code: (statusCode: number) => { send: (payload: unknown) => unknown };
}, message: string, details: unknown): unknown {
  return reply.code(400).send({
    error: "INVALID_INPUT",
    message,
    details
  });
}

export function registerDocumentRoutes(
  app: FastifyInstance,
  repository: DocumentRepository,
  analysisService: AnalysisService
): void {
  app.get("/api/documents", async (request, reply) => {
    const query = documentListQuerySchema.safeParse(request.query);
    if (!query.success) {
      return invalidInput(reply, "搜索词或分析状态筛选不符合要求", query.error.flatten());
    }
    return repository.list(query.data.q, query.data.status ?? query.data.analysisStatus);
  });

  app.post("/api/documents", async (request, reply) => {
    const input = createDocumentInputSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        error: "INVALID_INPUT",
        message: "文章标题、正文或难度设置不符合要求",
        details: input.error.flatten()
      });
    }

    const document = repository.create(input.data);
    return reply.code(201).send(document);
  });

  app.get<{ Params: DocumentParams }>("/api/documents/:documentId", async (request, reply) => {
    const params = documentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return invalidInput(reply, "文章 ID 不符合要求", params.error.flatten());
    }
    const document = repository.getById(params.data.documentId);
    if (!document) {
      return reply.code(404).send({
        error: "DOCUMENT_NOT_FOUND",
        message: "找不到指定文章"
      });
    }
    return document;
  });

  app.patch<{ Params: DocumentParams }>("/api/documents/:documentId", async (request, reply) => {
    const params = documentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return invalidInput(reply, "文章 ID 不符合要求", params.error.flatten());
    }
    const input = updateDocumentInputSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        error: "INVALID_INPUT",
        message: "没有可更新的文章字段，或字段格式不符合要求",
        details: input.error.flatten()
      });
    }

    const document = repository.update(params.data.documentId, input.data);
    if (!document) {
      return reply.code(404).send({
        error: "DOCUMENT_NOT_FOUND",
        message: "找不到指定文章"
      });
    }
    return document;
  });

  app.delete<{ Params: DocumentParams }>("/api/documents/:documentId", async (request, reply) => {
    const params = documentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return invalidInput(reply, "文章 ID 不符合要求", params.error.flatten());
    }
    analysisService.cancel(params.data.documentId);
    const deleted = repository.delete(params.data.documentId);
    if (!deleted) {
      return reply.code(404).send({
        error: "DOCUMENT_NOT_FOUND",
        message: "找不到指定文章"
      });
    }
    return { deleted: true };
  });

  app.patch<{ Params: SegmentParams }>("/api/segments/:segmentId", async (request, reply) => {
    const params = segmentParamsSchema.safeParse(request.params);
    const input = updateSegmentInputSchema.safeParse(request.body);
    if (!params.success) {
      return invalidInput(reply, "句段 ID 不符合要求", params.error.flatten());
    }
    if (!input.success) {
      return invalidInput(reply, "角色字段不符合要求", input.error.flatten());
    }
    const segment = repository.updateSegment(params.data.segmentId, input.data);
    if (!segment) {
      return reply.code(404).send({
        error: "SEGMENT_NOT_FOUND",
        message: "找不到指定句段"
      });
    }
    return segment;
  });

  app.patch<{ Params: SegmentParams }>(
    "/api/segments/:segmentId/analysis",
    async (request, reply) => {
      const params = segmentParamsSchema.safeParse(request.params);
      const input = segmentAnalysisOverrideSchema.safeParse(request.body);
      if (!params.success) {
        return invalidInput(reply, "句段 ID 不符合要求", params.error.flatten());
      }
      if (!input.success) {
        return invalidInput(reply, "人工修正字段不符合要求", input.error.flatten());
      }
      try {
        const segment = repository.saveAnalysisOverride(params.data.segmentId, input.data);
        if (!segment) {
          return reply.code(404).send({
            error: "SEGMENT_NOT_FOUND",
            message: "找不到指定句段"
          });
        }
        return segment;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message === "ANALYSIS_NOT_FOUND") {
          return reply.code(409).send({
            error: "ANALYSIS_NOT_FOUND",
            message: "该句段尚无可修正的 AI 分析"
          });
        }
        if (message.startsWith("UNKNOWN_TOKEN_ID:")) {
          return reply.code(400).send({
            error: "INVALID_TOKEN_OVERRIDE",
            message: `人工修正引用了不存在的 token：${message.slice("UNKNOWN_TOKEN_ID:".length)}`
          });
        }
        throw error;
      }
    }
  );
}
