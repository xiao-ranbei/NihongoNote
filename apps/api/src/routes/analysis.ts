import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { AnalysisService } from "../services/analysis-service.js";
import { DocumentRepository } from "../repositories/document-repository.js";
import type { LlmProvider } from "../providers/types.js";

interface DocumentParams {
  documentId: string;
}

interface SegmentParams {
  segmentId: string;
}

const documentParamsSchema = z.object({
  documentId: z.string().min(1).max(500)
}).strict();
const segmentParamsSchema = z.object({
  segmentId: z.string().min(1).max(500)
}).strict();
const emptyBodySchema = z.object({}).strict().nullish();

function invalidInput(reply: {
  code: (statusCode: number) => { send: (payload: unknown) => unknown };
}, details: unknown): unknown {
  return reply.code(400).send({
    error: "INVALID_INPUT",
    message: "请求参数或请求体不符合要求",
    details
  });
}

function providerNotConfigured(reply: {
  code: (statusCode: number) => { send: (payload: unknown) => unknown };
}): unknown {
  return reply.code(503).send({
    error: "LLM_NOT_CONFIGURED",
    message: "尚未配置可用的 LLM。请在 apps/api/.env 中设置 LLM_PROVIDER 和 LLM_API_KEY"
  });
}

export function registerAnalysisRoutes(
  app: FastifyInstance,
  repository: DocumentRepository,
  service: AnalysisService,
  provider: LlmProvider
): void {
  app.post<{ Params: DocumentParams }>("/api/documents/:documentId/analyze", async (request, reply) => {
    const params = documentParamsSchema.safeParse(request.params);
    const body = emptyBodySchema.safeParse(request.body);
    if (!params.success) {
      return invalidInput(reply, params.error.flatten());
    }
    if (!body.success) {
      return invalidInput(reply, body.error.flatten());
    }
    if (!provider.configured) {
      return providerNotConfigured(reply);
    }

    const progress = service.start(params.data.documentId);
    if (!progress) {
      return reply.code(404).send({
        error: "DOCUMENT_NOT_FOUND",
        message: "找不到指定文章"
      });
    }
    return reply.code(202).send(progress);
  });

  app.post<{ Params: DocumentParams }>(
    "/api/documents/:documentId/analyze/cancel",
    async (request, reply) => {
      const params = documentParamsSchema.safeParse(request.params);
      const body = emptyBodySchema.safeParse(request.body);
      if (!params.success) {
        return invalidInput(reply, params.error.flatten());
      }
      if (!body.success) {
        return invalidInput(reply, body.error.flatten());
      }
      const progress = service.cancel(params.data.documentId);
      if (!progress) {
        return reply.code(404).send({
          error: "DOCUMENT_NOT_FOUND",
          message: "找不到指定文章"
        });
      }
      return progress;
    }
  );

  app.get<{ Params: DocumentParams }>("/api/documents/:documentId/progress", async (request, reply) => {
    const params = documentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return invalidInput(reply, params.error.flatten());
    }
    const progress = repository.getAnalysisProgress(params.data.documentId);
    if (!progress) {
      return reply.code(404).send({
        error: "DOCUMENT_NOT_FOUND",
        message: "找不到指定文章"
      });
    }
    return progress;
  });

  app.post<{ Params: SegmentParams }>("/api/segments/:segmentId/retry", async (request, reply) => {
    const params = segmentParamsSchema.safeParse(request.params);
    const body = emptyBodySchema.safeParse(request.body);
    if (!params.success) {
      return invalidInput(reply, params.error.flatten());
    }
    if (!body.success) {
      return invalidInput(reply, body.error.flatten());
    }
    if (!provider.configured) {
      return providerNotConfigured(reply);
    }

    const progress = service.retrySegment(params.data.segmentId);
    if (!progress) {
      return reply.code(404).send({
        error: "SEGMENT_NOT_FOUND",
        message: "找不到指定句段"
      });
    }
    return reply.code(202).send(progress);
  });
}
