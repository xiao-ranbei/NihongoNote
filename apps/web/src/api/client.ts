import {
  analysisModeSchema,
  analysisPreviewSchema,
  analysisProgressSchema,
  batchAnalysisStartResponseSchema,
  type AnalysisMode,
  type AnalysisPreview,
  type ContentType,
  documentDetailSchema,
  documentSummarySchema,
  healthResponseSchema,
  llmBalanceSchema,
  segmentViewSchema,
  type AnalysisProgress,
  type BatchAnalysisStartResponse,
  type CreateDocumentInput,
  type DocumentStatus,
  type DocumentDetail,
  type DocumentSummary,
  type HealthResponse,
  type LlmBalance,
  type SegmentView,
  type TargetLevel,
  type TokenAnalysisOverride
} from "@nihongonote/core";

async function request<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  parse: (value: unknown) => T
): Promise<T> {
  const response = await fetch(input, init);
  const responseText = await response.text();
  let payload: unknown;
  if (responseText.trim().length > 0) {
    try {
      payload = JSON.parse(responseText) as unknown;
    } catch {
      throw new Error(response.ok ? "服务器返回格式不正确" : `请求失败（${response.status}）`);
    }
  }

  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "message" in payload
      ? String(payload.message)
      : `请求失败（${response.status}）`;
    throw new Error(message);
  }

  if (payload === undefined) {
    throw new Error("服务器返回为空");
  }

  return parse(payload);
}

export function getHealth(): Promise<HealthResponse> {
  return request("/api/health", { method: "GET" }, (payload) => healthResponseSchema.parse(payload));
}

/**
 * 查询当前 LLM 账号余额（服务端代理，只回传脱敏 key）。
 * 未配置 provider（503）或查询失败（502）时抛错，调用方应静默降级为「余额未知」。
 */
export function getLlmBalance(): Promise<LlmBalance> {
  return request(
    "/api/llm/balance",
    { method: "GET" },
    (payload) => llmBalanceSchema.parse(payload)
  );
}

export interface DocumentListOptions {
  search?: string | undefined;
  status?: DocumentStatus | undefined;
}

export async function listDocuments(options: DocumentListOptions = {}): Promise<DocumentSummary[]> {
  const searchParams = new URLSearchParams();
  if (options.search?.trim()) {
    searchParams.set("q", options.search.trim());
  }
  if (options.status) {
    searchParams.set("status", options.status);
  }
  const query = searchParams.toString();
  return request(query ? `/api/documents?${query}` : "/api/documents", { method: "GET" }, (payload) => {
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

export type CreateDocumentRequest = CreateDocumentInput & {
  contentType?: ContentType;
};

export function createDocument(input: CreateDocumentRequest): Promise<DocumentDetail> {
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

export function startDocumentAnalysis(documentId: string): Promise<AnalysisProgress> {
  return request(
    `/api/documents/${encodeURIComponent(documentId)}/analyze`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    },
    (payload) => analysisProgressSchema.parse(payload)
  );
}

export function cancelDocumentAnalysis(documentId: string): Promise<AnalysisProgress> {
  return request(
    `/api/documents/${encodeURIComponent(documentId)}/analyze/cancel`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    },
    (payload) => analysisProgressSchema.parse(payload)
  );
}

export function getAnalysisProgress(documentId: string): Promise<AnalysisProgress> {
  return request(
    `/api/documents/${encodeURIComponent(documentId)}/progress`,
    { method: "GET" },
    (payload) => analysisProgressSchema.parse(payload)
  );
}

export function retrySegment(segmentId: string): Promise<AnalysisProgress> {
  return request(
    `/api/segments/${encodeURIComponent(segmentId)}/retry`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    },
    (payload) => analysisProgressSchema.parse(payload)
  );
}

export interface DocumentUpdateInput {
  title?: string;
  contentType?: ContentType;
  targetLevel?: TargetLevel;
}

export function updateDocument(
  documentId: string,
  input: DocumentUpdateInput
): Promise<DocumentDetail> {
  return request(
    `/api/documents/${encodeURIComponent(documentId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    },
    (payload) => documentDetailSchema.parse(payload)
  );
}

export interface SegmentUpdateInput {
  speaker?: string | null;
}

export function updateSegment(segmentId: string, input: SegmentUpdateInput): Promise<SegmentView> {
  return request(
    `/api/segments/${encodeURIComponent(segmentId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    },
    (payload) => segmentViewSchema.parse(payload)
  );
}

export interface SegmentAnalysisUpdateInput {
  translation?: string;
  grammarSummary?: string;
  tone?: string;
  politeness?: string;
  impliedMeaning?: string | null;
  replyReason?: string | null;
  uncertaintyNote?: string | null;
  tokens?: TokenAnalysisOverride[];
}

export function updateSegmentAnalysis(
  segmentId: string,
  input: SegmentAnalysisUpdateInput
): Promise<SegmentView> {
  return request(
    `/api/segments/${encodeURIComponent(segmentId)}/analysis`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    },
    (payload) => segmentViewSchema.parse(payload)
  );
}

/**
 * 分析工具页：策略/费用预览（纯本地统计，零 LLM 调用，不产生任何费用）。
 */
export function previewAnalysis(documentIds: string[]): Promise<AnalysisPreview> {
  return request(
    "/api/analysis/preview",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentIds })
    },
    (payload) => analysisPreviewSchema.parse(payload)
  );
}

/**
 * 分析工具页：批量启动分析。
 * mode="full" 走词典 + AI（按量计费）；mode="dictionary-only" 零费用，不调用 LLM。
 */
export function startBatchAnalysis(
  documentIds: string[],
  mode: AnalysisMode
): Promise<BatchAnalysisStartResponse> {
  return request(
    "/api/analysis/start",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ documentIds, mode })
    },
    (payload) => batchAnalysisStartResponseSchema.parse(payload)
  );
}

/** 仅供工具页校验 mode 值（与 core 契约保持一致）。 */
export { analysisModeSchema };
export type { AnalysisMode, AnalysisPreview };
