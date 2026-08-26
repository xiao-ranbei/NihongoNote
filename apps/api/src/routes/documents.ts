import {
  createDocumentInputSchema,
  updateDocumentInputSchema
} from "@nihongonote/core";
import type { FastifyInstance } from "fastify";

import { DocumentRepository } from "../repositories/document-repository.js";

interface DocumentListQuery {
  q?: string;
}

interface DocumentParams {
  documentId: string;
}

export function registerDocumentRoutes(
  app: FastifyInstance,
  repository: DocumentRepository
): void {
  app.get<{ Querystring: DocumentListQuery }>("/api/documents", async (request) => {
    return repository.list(request.query.q);
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
    const document = repository.getById(request.params.documentId);
    if (!document) {
      return reply.code(404).send({
        error: "DOCUMENT_NOT_FOUND",
        message: "找不到指定文章"
      });
    }
    return document;
  });

  app.patch<{ Params: DocumentParams }>("/api/documents/:documentId", async (request, reply) => {
    const input = updateDocumentInputSchema.safeParse(request.body);
    if (!input.success) {
      return reply.code(400).send({
        error: "INVALID_INPUT",
        message: "没有可更新的文章字段，或字段格式不符合要求",
        details: input.error.flatten()
      });
    }

    const document = repository.update(request.params.documentId, input.data);
    if (!document) {
      return reply.code(404).send({
        error: "DOCUMENT_NOT_FOUND",
        message: "找不到指定文章"
      });
    }
    return document;
  });

  app.delete<{ Params: DocumentParams }>("/api/documents/:documentId", async (request, reply) => {
    const deleted = repository.delete(request.params.documentId);
    if (!deleted) {
      return reply.code(404).send({
        error: "DOCUMENT_NOT_FOUND",
        message: "找不到指定文章"
      });
    }
    return { deleted: true };
  });
}
