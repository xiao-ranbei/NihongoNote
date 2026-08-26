import {
  documentDetailSchema,
  documentSummarySchema,
  healthResponseSchema,
  type CreateDocumentInput,
  type DocumentDetail,
  type DocumentSummary,
  type HealthResponse
} from "@nihongonote/core";

async function request<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  parse: (value: unknown) => T
): Promise<T> {
  const response = await fetch(input, init);
  const payload: unknown = await response.json();

  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "message" in payload
      ? String(payload.message)
      : `请求失败（${response.status}）`;
    throw new Error(message);
  }

  return parse(payload);
}

export function getHealth(): Promise<HealthResponse> {
  return request("/api/health", { method: "GET" }, (payload) => healthResponseSchema.parse(payload));
}

export async function listDocuments(): Promise<DocumentSummary[]> {
  return request("/api/documents", { method: "GET" }, (payload) => {
    if (!Array.isArray(payload)) {
      throw new Error("文章列表返回格式不正确");
    }
    return payload.map((item) => documentSummarySchema.parse(item));
  });
}

export function getDocument(documentId: string): Promise<DocumentDetail> {
  return request(
    `/api/documents/${encodeURIComponent(documentId)}`,
    { method: "GET" },
    (payload) => documentDetailSchema.parse(payload)
  );
}

export function createDocument(input: CreateDocumentInput): Promise<DocumentDetail> {
  return request(
    "/api/documents",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    },
    (payload) => documentDetailSchema.parse(payload)
  );
}
