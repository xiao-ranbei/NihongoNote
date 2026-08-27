import type { FastifyInstance } from "fastify";

import { AnalysisService } from "../services/analysis-service.js";
import { DocumentRepository } from "../repositories/document-repository.js";
import type { LlmProvider } from "../providers/types.js";

interface DocumentParams {
  documentId: string;
}

interface SegmentParams {
  segmentId: string;
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
    if (!provider.configured) {
      return providerNotConfigured(reply);
    }

    const progress = service.start(request.params.documentId);
    if (!progress) {
      return reply.code(404).send({
        error: "DOCUMENT_NOT_FOUND",
        message: "找不到指定文章"
      });
    }
    return reply.code(202).send(progress);
  });

  app.get<{ Params: DocumentParams }>("/api/documents/:documentId/progress", async (request, reply) => {
    const progress = repository.getAnalysisProgress(request.params.documentId);
    if (!progress) {
      return reply.code(404).send({
        error: "DOCUMENT_NOT_FOUND",
        message: "找不到指定文章"
      });
    }
    return progress;
  });

  app.post<{ Params: SegmentParams }>("/api/segments/:segmentId/retry", async (request, reply) => {
    if (!provider.configured) {
      return providerNotConfigured(reply);
    }

    const progress = service.retrySegment(request.params.segmentId);
    if (!progress) {
      return reply.code(404).send({
        error: "SEGMENT_NOT_FOUND",
        message: "找不到指定句段"
      });
    }
    return reply.code(202).send(progress);
  });
}
