import type { FastifyInstance } from "fastify";
import {
  analysisModeSchema,
  segmentFieldProfileSchema,
  type AnalysisProgress,
  type AnalysisStreamEvent
} from "@nihongonote/core";
import { z } from "zod";

import { AnalysisService } from "../services/analysis-service.js";
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
const previewBodySchema = z.object({
  documentIds: z.array(z.string().min(1).max(500)).min(1).max(100),
  /** 段级语义字段档位（缺省用服务端 LLM_SEGMENT_FIELDS，默认 standard） */
  segmentFields: segmentFieldProfileSchema.optional()
}).strict();
const batchStartBodySchema = z.object({
  documentIds: z.array(z.string().min(1).max(500)).min(1).max(100),
  mode: analysisModeSchema,
  /** 段级语义字段档位（缺省用服务端 LLM_SEGMENT_FIELDS，默认 standard） */
  segmentFields: segmentFieldProfileSchema.optional()
}).strict();

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
  service: AnalysisService,
  providerHolder: { current: LlmProvider }
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
    if (!providerHolder.current.configured) {
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
    // 经 service 统一附加用量/费用（usage/cost），避免与 start/cancel/retry 口径不一致
    const progress = service.getProgress(params.data.documentId);
    if (!progress) {
      return reply.code(404).send({
        error: "DOCUMENT_NOT_FOUND",
        message: "找不到指定文章"
      });
    }
    return progress;
  });

  /*
   * 段级流式事件（M1.2 / STREAM-001..005）：
   * SSE 推送段落完成/失败、进度快照与收尾事件。订阅建立即发一次快照，
   * EventSource 断线自动重连后同样先收到快照对齐——这就是断线可恢复（STREAM-004）。
   * reply.hijack() 接管原始响应，绕过 Fastify 的序列化与压缩（SSE 必须逐块写出）。
   */
  app.get<{ Params: DocumentParams }>(
    "/api/documents/:documentId/analysis/events",
    async (request, reply) => {
      const params = documentParamsSchema.safeParse(request.params);
      if (!params.success) {
        return invalidInput(reply, params.error.flatten());
      }
      const documentId = params.data.documentId;

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      raw.write("retry: 3000\n\n");

      const send = (event: AnalysisStreamEvent): void => {
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // 先订阅再推快照，保证「当前状态」不会与后续事件乱序
      const unsubscribe = service.subscribe(documentId, send);
      service.emitProgress(documentId);

      // 空闲心跳：防止本机代理/浏览器把静默连接掐掉
      const heartbeat = setInterval(() => {
        raw.write(": keep-alive\n\n");
      }, 15_000);
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    }
  );

  app.post<{ Params: SegmentParams }>("/api/segments/:segmentId/retry", async (request, reply) => {
    const params = segmentParamsSchema.safeParse(request.params);
    const body = emptyBodySchema.safeParse(request.body);
    if (!params.success) {
      return invalidInput(reply, params.error.flatten());
    }
    if (!body.success) {
      return invalidInput(reply, body.error.flatten());
    }
    if (!providerHolder.current.configured) {
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

  /*
   * 分析工具页（设计文档 §六-4，落实 LLM-011/LLM-013）：
   * - POST /api/analysis/preview —— 纯本地统计（词典覆盖 + 估算 token/费用），零 LLM 调用；
   * - POST /api/analysis/start —— 批量启动，「完整分析」或「仅词典分析」两种模式。
   */

  app.post("/api/analysis/preview", async (request, reply) => {
    const body = previewBodySchema.safeParse(request.body);
    if (!body.success) {
      return invalidInput(reply, body.error.flatten());
    }
    return service.previewAnalysis(body.data.documentIds, body.data.segmentFields);
  });

  app.post("/api/analysis/start", async (request, reply) => {
    const body = batchStartBodySchema.safeParse(request.body);
    if (!body.success) {
      return invalidInput(reply, body.error.flatten());
    }
    const { documentIds, mode, segmentFields } = body.data;
    if (mode === "full" && !providerHolder.current.configured) {
      return providerNotConfigured(reply);
    }

    const started: AnalysisProgress[] = [];
    const skipped: Array<{ documentId: string; reason: string }> = [];
    for (const documentId of documentIds) {
      const progress = mode === "full"
        ? service.start(documentId, segmentFields)
        : await service.startDictionaryOnly(documentId);
      if (progress) {
        started.push(progress);
      } else {
        skipped.push({ documentId, reason: "DOCUMENT_NOT_FOUND" });
      }
    }
    return { mode, started, skipped };
  });
}
