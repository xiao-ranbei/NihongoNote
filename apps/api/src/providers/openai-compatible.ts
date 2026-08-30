import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import OpenAI, {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError
} from "openai";
import { z } from "zod";

import { segmentAnalysisSchema, type Segment, type SegmentFieldProfile } from "@nihongonote/core";

import {
  estimateCompletionTokens,
  hardMaxCompletionTokens
} from "../llm-budget.js";
import {
  ProviderConfigurationError,
  ProviderRequestError,
  type AnalysisRequest,
  type LlmAnalysisResult,
  type LlmBalance,
  type LlmProtocol,
  type LlmProvider
} from "./types.js";

interface OpenAiCompatibleProviderConfig {
  providerName: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  thinkingType: "enabled" | "disabled" | undefined;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh" | undefined;
  debugLogging: boolean;
  debugLogFile: string;
}

type DeepSeekChatCompletionParams =
  OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
    thinking?: {
      type: "enabled" | "disabled";
    };
  };

const analysisEnvelopeSchema = z.object({
  analyses: z.array(z.unknown())
}).strict();
const segmentIdSchema = z.object({
  segmentId: z.string().min(1)
}).passthrough();

/**
 * DeepSeek 余额响应（snake_case 原始形态）：
 * GET {baseUrl}/user/balance，header Authorization: Bearer <KEY>
 * 见 https://api-docs.deepseek.com/zh-cn/api/get-user-balance
 * granted_balance / topped_up_balance 可能为 null（未赠送/未充值）。
 */
const balanceEntryResponseSchema = z.object({
  currency: z.string().min(1),
  total_balance: z.string().min(1),
  granted_balance: z.string().nullable(),
  topped_up_balance: z.string().nullable()
});
const balanceResponseSchema = z.object({
  is_available: z.boolean(),
  balance_infos: z.array(balanceEntryResponseSchema).min(1)
});

/** 只留首尾，中间打码：sk-49af…be98。完整 key 绝不离开服务端。 */
function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return `${apiKey.slice(0, 2)}…${apiKey.length > 2 ? "".padEnd(Math.min(4, apiKey.length - 2), "*") : ""}`;
  }
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

/**
 * 段级语义字段档位 → prompt 字段要求（设计文档 3.8，成本治理）。
 *
 * - full：全部 7 字段强制输出（历史行为）；
 * - standard（默认）：translation + grammarSummary + register（语气/礼貌合并）+ uncertaintyNote，
 *   可选字段「键级省略」——无值时不输出键，模型不必为写 null 而思考；
 * - minimal：仅 translation + grammarSummary，不输出任何其他段级字段。
 *
 * 档位只改变「要求模型输出什么」。schema 校验保持宽松（缺失字段 default(null) 降级），
 * 存储与 UI 完全兼容，不需要数据迁移；三个档位共用同一段 token 说明。
 */
export function buildSystemPrompt(profile: SegmentFieldProfile): string {
  const fieldLines: string[] = [];
  let fieldRules = "";

  switch (profile) {
    case "full":
      fieldLines.push(
        "- translation: a natural Chinese translation",
        "- grammarSummary: the important grammar and sentence structure",
        "- tone: the speaker's communicative attitude and strength",
        "- politeness: the politeness/register level and evidence",
        "- impliedMeaning: implicit meaning or null when there is none or it cannot be determined",
        "- replyReason: why this reply follows the surrounding dialogue, or null when there is no dialogue context",
        "- uncertaintyNote: a clear uncertainty note or null"
      );
      fieldRules = [
        "Each analysis must contain all of the following top-level fields and none may be omitted:",
        ...fieldLines,
        "Omitting any top-level field — including politeness, tone, grammarSummary or translation — invalidates",
        "that analysis, so emit every one of them for every segment."
      ].join("\n");
      break;
    case "standard":
      fieldLines.push(
        "- translation: a natural Chinese translation",
        "- grammarSummary: the important grammar and sentence structure",
        "- register: the speaker's tone (communicative attitude and strength) and politeness level combined into one short phrase, citing evidence when notable",
        "- uncertaintyNote: a clear uncertainty note when there is one"
      );
      fieldRules = [
        "Each analysis must contain these top-level fields:",
        ...fieldLines,
        "register and uncertaintyNote are optional: when there is nothing meaningful to say, omit the key entirely rather than writing null."
      ].join("\n");
      break;
    case "minimal":
      fieldLines.push(
        "- translation: a natural Chinese translation",
        "- grammarSummary: the important grammar and sentence structure"
      );
      fieldRules = [
        "Each analysis must contain exactly these top-level fields and no others:",
        ...fieldLines
      ].join("\n");
      break;
  }

  return `You are NihongoNote, a careful Japanese language tutor.
Analyze the supplied Japanese sentence or dialogue segment for a Chinese-speaking learner.
Return JSON only. The JSON must have exactly one top-level key named "analyses", whose value is an array.
For every supplied segment, return exactly one analysis with the same segmentId.

${fieldRules}
- tokens: one entry for every boundary listed under that segment's tokenBoundaries

Each token must contain all of the following fields and none may be omitted: tokenId, startOffset,
endOffset, surface, category, lemma, reading, partOfSpeech, conjugation, gloss, particleFunction,
grammarPoint, explanation, and confidence. Omitting any field, including confidence, invalidates
that token's analysis.
confidence is required for every token: a JSON number between 0 and 1 — never a quoted string, never
a word like "high", and never absent.
Set category to exactly one of "word", "particle", "functional", "adverb", or "grammar":
- "particle" for 助词 such as は/が/を/に/で/と/の/へ/も/から/まで
- "functional" for 助动词 and other function words that are not particles, such as ます/です/た/ない/たい/ください
- "adverb" for 副词 such as とても/まだ/すぐ
- "grammar" for a token that carries a grammar construction, such as 〜てしまう or 〜ばかり
- "word" for everything else, including nouns, verbs, adjectives and proper names

The user payload provides deterministic token boundaries computed locally. Those boundaries are fixed:
return exactly one token analysis for every provided boundary, in the same order, preserving tokenId,
startOffset, endOffset and surface exactly. Do not skip a boundary because it looks trivial, do not
merge two boundaries, and do not invent boundaries that were not supplied.
Every token deserves a short explanation even when it is a single particle — a learner is reading this
precisely to understand those. It is fine to say a token is unremarkable; it is not fine to omit it.
Token offsets are JavaScript UTF-16 offsets relative to that segment's text. Use null for a field that
is not applicable or cannot be determined.
Do not invent context. If multiple interpretations are reasonable, say so in uncertaintyNote.
contentType is the user's selected document type. Treat it as authoritative; do not replace it with an inferred type.
targetLevel controls explanation wording only. It must never change token boundaries, lexical facts, or grammar facts.
Example JSON shape: {"analyses":[{"segmentId":"...","translation":"...","grammarSummary":"...","tone":"...","politeness":"...","impliedMeaning":null,"replyReason":null,"uncertaintyNote":null,"tokens":[]}]}
Return raw JSON only: no Markdown fences, no prose before or after the JSON.
ASCII double quotes are used ONLY as JSON structural delimiters around keys and string values.
Inside the text of a string value, never place an ASCII double quote: quote Japanese or Chinese
terms with full-width marks（“…” or 「…」）. An ASCII double quote inside a string value
terminates it and invalidates the entire JSON response.`;
}

/**
 * 给估算结果留的放大系数。
 *
 * 开启思考后真正的内容只占输出的小头，凭直觉估预算会严重低估：
 * 实测（deepseek-v4-flash，thinking=enabled，reasoning_effort=medium）
 * 19 批请求里 completion token 是原文字符数的 200 ~ 500 倍，推理过程占输出 72.8%。
 * 估算式与系数见 `llm-budget.ts`；这里再放大 1.3 倍作为上限。
 * 多给不会多花钱（max_tokens 只是上限，计费按实际生成量），截断才会白跑一次。
 */
const completionTokenSafetyFactor = 1.3;

/** config.ts 的 schema 校验上限，代码内不得越过。 */
const hardMaxTokens = hardMaxCompletionTokens;

function endpointFor(baseUrl: string): string {
  return new URL("chat/completions", `${baseUrl.replace(/\/+$/u, "")}/`).toString();
}

export function writeDebugLog(
  enabled: boolean,
  filePath: string,
  event: string,
  requestId: string,
  details: Record<string, unknown>
): void {
  if (!enabled) {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(
    filePath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      requestId,
      ...details
    })}\n`,
    "utf8"
  );
}

const controlCharacterEscapes: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f"
};

/*
 * 模型偶尔会在 JSON 字符串里直接吐出裸换行/制表符，导致整批响应无法解析
 * （实测 `Bad control character in string literal`）。
 * 只转义字符串字面量内部的控制字符，不改动结构字符，也不丢弃内容。
 */
export function escapeControlCharacters(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (inString) {
      if (escaped) {
        result += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        result += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
        result += char;
        continue;
      }
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20) {
        result += controlCharacterEscapes[char] ?? `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      result += char;
      continue;
    }

    if (char === '"') {
      inString = true;
    }
    result += char;
  }

  return result;
}

export function parseJsonResponse(responseBody: string): unknown {
  try {
    return JSON.parse(responseBody) as unknown;
  } catch (error) {
    // 先尝试修掉裸控制字符再解析，仍然失败才报错
    try {
      return JSON.parse(escapeControlCharacters(responseBody)) as unknown;
    } catch {
      const detail = error instanceof Error ? error.message : "unknown JSON parse error";
      throw new ProviderRequestError(`LLM returned invalid JSON: ${detail}`);
    }
  }
}

export function validateRequest(request: AnalysisRequest): void {
  if (request.segments.length === 0) {
    throw new ProviderRequestError("Analysis request must contain at least one segment");
  }
  const segmentIds = new Set(request.segments.map((segment) => segment.id));
  if (segmentIds.size !== request.segments.length) {
    throw new ProviderRequestError("Analysis request contains duplicate segment IDs");
  }
  const boundaryIds = request.tokenBoundaries.map((group) => group.segmentId);
  const contextIds = request.surroundingContext.map((group) => group.segmentId);
  if (
    boundaryIds.length !== segmentIds.size
    || new Set(boundaryIds).size !== segmentIds.size
    || boundaryIds.some((id) => !segmentIds.has(id))
  ) {
    throw new ProviderRequestError("Token boundary groups must match the requested segment IDs exactly");
  }
  if (
    contextIds.length !== segmentIds.size
    || new Set(contextIds).size !== segmentIds.size
    || contextIds.some((id) => !segmentIds.has(id))
  ) {
    throw new ProviderRequestError("Context groups must match the requested segment IDs exactly");
  }

  const allTokenIds = new Set<string>();
  for (const group of request.tokenBoundaries) {
    const segment = request.segments.find((candidate) => candidate.id === group.segmentId);
    if (!segment) {
      throw new ProviderRequestError(`Unexpected token boundary segment ID: ${group.segmentId}`);
    }
    for (const token of group.tokens) {
      if (allTokenIds.has(token.tokenId)) {
        throw new ProviderRequestError(`Duplicate token ID in analysis request: ${token.tokenId}`);
      }
      allTokenIds.add(token.tokenId);
      if (
        token.startOffset < 0
        || token.endOffset <= token.startOffset
        || segment.text.slice(token.startOffset, token.endOffset) !== token.surface
      ) {
        throw new ProviderRequestError(
          `Token ${token.tokenId} does not match segment ${group.segmentId}`
        );
      }
    }
  }
}

export function schemaIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue
    ? `LLM analysis did not match the schema (${issue.path.join(".")}: ${issue.message})`
    : "LLM analysis did not match the schema";
}

export function sanitizedErrorMessage(error: unknown, apiKey: string | undefined): string {
  const message = error instanceof Error ? error.message : "unknown request error";
  // Ollama 等本地 provider 没有 API key，无需脱敏
  if (!apiKey) {
    return message;
  }
  return message
    .replaceAll(apiKey, "[REDACTED]")
    .replace(/Authorization:\s*\S+/giu, "Authorization: [REDACTED]")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]");
}

function requestPayload(
  request: AnalysisRequest,
  model: string,
  temperature: number,
  maxTokens: number,
  thinkingType: OpenAiCompatibleProviderConfig["thinkingType"],
  reasoningEffort: OpenAiCompatibleProviderConfig["reasoningEffort"],
  segmentFields: SegmentFieldProfile,
  isOllama: boolean
): DeepSeekChatCompletionParams {
  return {
    model,
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(segmentFields)
      },
      {
        role: "user",
        content: JSON.stringify({
          contentType: request.contentType,
          targetLevel: request.targetLevel,
          surroundingContext: request.surroundingContext,
          segments: request.segments.map((segment) => ({
            segmentId: segment.id,
            index: segment.index,
            speaker: segment.speaker,
            text: segment.text
          })),
          tokenBoundaries: request.tokenBoundaries
        })
      }
    ],
    max_tokens: maxTokens,
    // Ollama 的 /v1 兼容层对 response_format（JSON 模式）支持不稳定（模型/版本相关），
    // 本地模型靠 prompt 的 "Return raw JSON only" 约束；云端（DeepSeek/OpenAI）继续走 JSON 模式。
    ...(isOllama ? {} : { response_format: { type: "json_object" } }),
    // Ollama 已改为走原生 /api/chat 协议（ollama.ts，可扩上下文+关思考），
    // 此 isOllama 分支仅作防御性保留：OpenAI 兼容层的 response_format 对
    // Ollama 不稳定（模型/版本相关），靠 prompt 的 "Return raw JSON only" 约束；
    // reasoning_effort: "none" 是实测唯一能关闭 qwen3.5 系思考的参数。
    // 云端（DeepSeek/OpenAI）保持既有 thinking / reasoning_effort 逻辑。
    ...(isOllama
      ? { reasoning_effort: "none" as const, temperature }
      : {
          ...(thinkingType ? { thinking: { type: thinkingType } } : {}),
          ...(thinkingType !== "disabled" && reasoningEffort
            ? { reasoning_effort: reasoningEffort }
            : {}),
          ...(thinkingType === "enabled" ? {} : { temperature })
        }),
    stream: true,
    stream_options: {
      include_usage: true
    }
  };
}

export class OpenAiCompatibleLlmProvider implements LlmProvider {
  public readonly protocol: LlmProtocol = "openai";
  public readonly configured: boolean;
  public readonly model: string;
  public readonly completionTokenBudget = hardMaxCompletionTokens;

  private readonly client: OpenAI | undefined;
  private readonly apiKey: string | undefined;
  private readonly isOllama: boolean;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly thinkingType: OpenAiCompatibleProviderConfig["thinkingType"];
  private readonly reasoningEffort: OpenAiCompatibleProviderConfig["reasoningEffort"];
  private readonly debugLogging: boolean;
  private readonly debugLogFile: string;

  public constructor(private readonly config: OpenAiCompatibleProviderConfig) {
    this.model = config.model;
    // Ollama 等本地 provider 无 API key 概念：没配 key 也算配置完成（localhost 免鉴权）。
    this.isOllama = config.providerName === "ollama";
    this.configured = this.isOllama || config.apiKey !== undefined;
    this.apiKey = config.apiKey;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.timeoutMs = config.timeoutMs;
    this.thinkingType = config.thinkingType;
    this.reasoningEffort = config.reasoningEffort;
    this.debugLogging = config.debugLogging;
    this.debugLogFile = config.debugLogFile;
    // 云端 provider 缺 key 时不构造 client（analyze 会明确报配置错误）；
    // Ollama 用占位 key 构造（OpenAI SDK 只要求非空字符串，Ollama 忽略 Authorization header）。
    const needsKey = !this.isOllama;
    this.client = needsKey && !config.apiKey
      ? undefined
      : new OpenAI({
          apiKey: config.apiKey ?? "ollama",
          baseURL: config.baseUrl,
          maxRetries: 0,
          timeout: config.timeoutMs
        });
  }

  public get name(): string {
    return this.config.providerName;
  }

  /**
   * 按本批 segment 的实际长度放大输出上限。
   *
   * 固定上限、批量大小和句子长度三者是耦合的：早期版本按「段数 × 常数」估预算，
   * 结果三个长句段凑一批照样打满 30000 上限（样本 2 因此丢掉 3 个句段）。
   * 改为按原文长度估算后，取「配置值」与「估算值 × 1.3」的较大者，
   * 既不突破 32000 硬上限，也不会因为 batch_size 调大而突然失败。
   */
  private resolveMaxTokens(segments: readonly Pick<Segment, "text">[]): number {
    return Math.min(
      Math.max(
        this.maxTokens,
        Math.ceil(estimateCompletionTokens(segments) * completionTokenSafetyFactor)
      ),
      hardMaxTokens
    );
  }

  public async analyze(request: AnalysisRequest): Promise<LlmAnalysisResult> {
    if (!this.client) {
      throw new ProviderConfigurationError(
        `LLM provider "${this.name}" requires LLM_API_KEY before analysis can start`
      );
    }

    request.signal.throwIfAborted();
    validateRequest(request);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeoutSignal]);
    const requestId = randomUUID();
    const maxTokens = this.resolveMaxTokens(request.segments);
    const segmentFields = request.segmentFields ?? "standard";
    const requestBody = requestPayload(
      request,
      this.model,
      this.temperature,
      maxTokens,
      this.thinkingType,
      this.reasoningEffort,
      segmentFields,
      this.isOllama
    );
    const startedAt = Date.now();
    writeDebugLog(
      this.debugLogging,
      this.debugLogFile,
      "llm.request.started",
      requestId,
      {
        provider: this.name,
        protocol: this.protocol,
        baseUrl: this.config.baseUrl,
        endpoint: endpointFor(this.config.baseUrl),
        model: this.model,
        stream: true,
        segmentIds: request.segments.map((segment) => segment.id),
        timeoutMs: this.timeoutMs,
        body: requestBody,
        note: "Authorization header is intentionally omitted; request body contains source text."
      }
    );
    let content = "";
    let finishReason: string | null = null;
    let usage: OpenAI.Completions.CompletionUsage | null = null;
    let responseId: string | null = null;
    let chunkCount = 0;
    try {
      const stream = await this.client.chat.completions.create(
        requestBody,
        { signal }
      );
      for await (const chunk of stream) {
        chunkCount += 1;
        signal.throwIfAborted();
        responseId ??= chunk.id;
        usage = chunk.usage ?? usage;
        const choice = chunk.choices.find((candidate) => candidate.index === 0)
          ?? chunk.choices[0];
        if (choice?.delta.content) {
          content += choice.delta.content;
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }
    } catch (error) {
      writeDebugLog(
        this.debugLogging,
        this.debugLogFile,
        "llm.request.failed",
        requestId,
        {
          durationMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: sanitizedErrorMessage(error, this.apiKey),
          statusCode: error instanceof APIError ? error.status ?? null : null
        }
      );
      if (request.signal.aborted) {
        throw request.signal.reason instanceof Error
          ? request.signal.reason
          : new DOMException("Analysis cancelled", "AbortError");
      }
      if (timeoutSignal.aborted || error instanceof APIConnectionTimeoutError) {
        throw new ProviderRequestError(`LLM request timed out after ${this.timeoutMs}ms`);
      }
      if (error instanceof APIUserAbortError) {
        throw new ProviderRequestError("LLM request was aborted");
      }
      if (error instanceof APIError) {
        throw new ProviderRequestError(
          sanitizedErrorMessage(error, this.apiKey),
          error.status ?? null
        );
      }
      const detail = sanitizedErrorMessage(error, this.apiKey);
      throw new ProviderRequestError(`LLM request failed: ${detail}`);
    }

    writeDebugLog(
      this.debugLogging,
      this.debugLogFile,
      "llm.response.received",
      requestId,
      {
        durationMs: Date.now() - startedAt,
        responseId,
        finishReason,
        chunkCount,
        contentLength: content.length,
        usage
      }
    );
    if (responseId === null) {
      throw new ProviderRequestError("LLM response did not contain a completion choice");
    }
    if (finishReason === "length") {
      throw new ProviderRequestError(
        `LLM response was truncated at the ${maxTokens} token limit while analyzing `
        + `${request.segments.length} segment(s); retry the failed segments, `
        + "or lower LLM_BATCH_SIZE / raise LLM_MAX_TOKENS"
      );
    }
    if (content.trim().length === 0) {
      throw new ProviderRequestError("LLM returned empty analysis content");
    }

    let analysisPayload: unknown;
    try {
      analysisPayload = parseJsonResponse(content);
    } catch (error) {
      // 解析失败时若不留下原文，下次排查只能重跑一遍请求（实测一次要几分钟）
      writeDebugLog(
        this.debugLogging,
        this.debugLogFile,
        "llm.json.invalid",
        requestId,
        {
          message: error instanceof Error ? error.message : "unknown JSON parse error",
          contentLength: content.length,
          excerpt: content.slice(0, 8_000)
        }
      );
      throw error;
    }
    const analysisEnvelope = analysisEnvelopeSchema.safeParse(analysisPayload);
    if (!analysisEnvelope.success) {
      const issue = analysisEnvelope.error.issues[0];
      const detail = issue ? ` (${issue.path.join(".")}: ${issue.message})` : "";
      throw new ProviderRequestError(
        `LLM JSON did not match the NihongoNote analysis schema${detail}`
      );
    }

    const expectedSegmentIds = new Set(request.segments.map((segment) => segment.id));
    const analyses = [];
    const failures: LlmAnalysisResult["failures"] = [];
    for (const item of analysisEnvelope.data.analyses) {
      const idResult = segmentIdSchema.safeParse(item);
      const segmentId = idResult.success ? idResult.data.segmentId : null;
      if (segmentId !== null && !expectedSegmentIds.has(segmentId)) {
        failures.push({
          segmentId: null,
          message: `LLM returned an unexpected segment ID: ${segmentId}`
        });
        continue;
      }
      const parsed = segmentAnalysisSchema.safeParse(item);
      if (!parsed.success) {
        const message = schemaIssueMessage(parsed.error);
        // 只看到 schema 错误无法判断是提示词没说清还是模型在乱输出，
        // 记下原始片段，下次排查不用重新跑一遍请求。
        writeDebugLog(
          this.debugLogging,
          this.debugLogFile,
          "llm.schema.mismatch",
          requestId,
          {
            segmentId,
            message,
            issues: parsed.error.issues.slice(0, 5),
            rawItem: JSON.stringify(item).slice(0, 2_000)
          }
        );
        failures.push({ segmentId, message });
        continue;
      }
      analyses.push(parsed.data);
    }

    const rawUsage = usage as OpenAI.Completions.CompletionUsage & {
      prompt_cache_hit_tokens?: number;
      prompt_cache_miss_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    const cachedInputTokens = rawUsage.prompt_cache_hit_tokens
      ?? rawUsage.prompt_tokens_details?.cached_tokens
      ?? null;

    return {
      analyses,
      failures,
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens ?? null,
            outputTokens: usage.completion_tokens ?? null,
            totalTokens: usage.total_tokens ?? null,
            cachedInputTokens
          }
        : null
    };
  }

  public async fetchBalance(): Promise<LlmBalance | null> {
    // Ollama 等本地 provider：没有 /user/balance 端点，也没有余额概念（返回 null，前端显示不可用）
    if (this.isOllama) {
      return null;
    }
    if (!this.apiKey) {
      return null;
    }
    const url = new URL("user/balance", `${this.config.baseUrl.replace(/\/+$/u, "")}/`).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const detail = sanitizedErrorMessage(error, this.apiKey);
      throw new ProviderRequestError(`Balance request failed: ${detail}`);
    }
    if (!response.ok) {
      throw new ProviderRequestError(
        `Balance request failed with status ${response.status}`,
        response.status
      );
    }
    const payload = await response.json() as unknown;
    const parsed = balanceResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderRequestError("Balance response did not match the expected shape");
    }
    return {
      isAvailable: parsed.data.is_available,
      apiKeyMasked: maskApiKey(this.apiKey),
      model: this.model,
      baseUrl: this.config.baseUrl,
      entries: parsed.data.balance_infos.map((entry) => ({
        currency: entry.currency,
        totalBalance: entry.total_balance,
        grantedBalance: entry.granted_balance,
        toppedUpBalance: entry.topped_up_balance
      }))
    };
  }
}