import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import OpenAI, {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError
} from "openai";
import { z } from "zod";

import { segmentAnalysisSchema } from "@nihongonote/core";

import {
  ProviderConfigurationError,
  ProviderRequestError,
  type AnalysisRequest,
  type LlmAnalysisResult,
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

const systemPrompt = `You are NihongoNote, a careful Japanese language tutor.
Analyze the supplied Japanese sentence or dialogue segment for a Chinese-speaking learner.
Return JSON only. The JSON must have exactly one top-level key named "analyses", whose value is an array.
For every supplied segment, return exactly one analysis with the same segmentId.

Each analysis must contain:
- segmentId
- translation: a natural Chinese translation
- grammarSummary: the important grammar and sentence structure
- tone: the speaker's communicative attitude and strength
- politeness: the politeness/register level and evidence
- impliedMeaning: implicit meaning or null when there is none or it cannot be determined
- replyReason: why this reply follows the surrounding dialogue, or null when there is no dialogue context
- uncertaintyNote: a clear uncertainty note or null
- tokens: an array of meaningful surface tokens

Each token must contain tokenId, startOffset, endOffset, surface, category, lemma, reading, partOfSpeech,
conjugation, gloss, particleFunction, grammarPoint, explanation, and confidence. Set category to exactly
one of "word", "particle", "adverb", or "grammar": use "particle" for 助词, "adverb" for 副词,
"grammar" for a token that carries a grammar construction or function, and "word" for other vocabulary.
The user payload provides the deterministic token boundaries. Return exactly one token analysis for
each provided boundary, preserving tokenId, startOffset, endOffset, and surface exactly.
Token offsets are JavaScript UTF-16 offsets relative to that segment's text. Use null for a field that
is not applicable or cannot be determined.
Do not invent context. If multiple interpretations are reasonable, say so in uncertaintyNote.
contentType is the user's selected document type. Treat it as authoritative; do not replace it with an inferred type.
targetLevel controls explanation wording only. It must never change token boundaries, lexical facts, or grammar facts.
Example JSON shape: {"analyses":[{"segmentId":"...","translation":"...","grammarSummary":"...","tone":"...","politeness":"...","impliedMeaning":null,"replyReason":null,"uncertaintyNote":null,"tokens":[]}]}
The word JSON must be followed: do not wrap it in Markdown fences.`;

function endpointFor(baseUrl: string): string {
  return new URL("chat/completions", `${baseUrl.replace(/\/+$/u, "")}/`).toString();
}

function writeDebugLog(
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

function parseJsonResponse(responseBody: string): unknown {
  try {
    return JSON.parse(responseBody) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown JSON parse error";
    throw new ProviderRequestError(`LLM returned invalid JSON: ${detail}`);
  }
}

function validateRequest(request: AnalysisRequest): void {
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

function schemaIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue
    ? `LLM analysis did not match the schema (${issue.path.join(".")}: ${issue.message})`
    : "LLM analysis did not match the schema";
}

function sanitizedErrorMessage(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : "unknown request error";
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
  reasoningEffort: OpenAiCompatibleProviderConfig["reasoningEffort"]
): DeepSeekChatCompletionParams {
  return {
    model,
    messages: [
      {
        role: "system",
        content: systemPrompt
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
    response_format: {
      type: "json_object"
    },
    ...(thinkingType ? { thinking: { type: thinkingType } } : {}),
    ...(thinkingType !== "disabled" && reasoningEffort
      ? { reasoning_effort: reasoningEffort }
      : {}),
    ...(thinkingType === "enabled" ? {} : { temperature }),
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

  private readonly client: OpenAI | undefined;
  private readonly apiKey: string | undefined;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly thinkingType: OpenAiCompatibleProviderConfig["thinkingType"];
  private readonly reasoningEffort: OpenAiCompatibleProviderConfig["reasoningEffort"];
  private readonly debugLogging: boolean;
  private readonly debugLogFile: string;

  public constructor(private readonly config: OpenAiCompatibleProviderConfig) {
    this.model = config.model;
    this.configured = config.apiKey !== undefined;
    this.apiKey = config.apiKey;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.timeoutMs = config.timeoutMs;
    this.thinkingType = config.thinkingType;
    this.reasoningEffort = config.reasoningEffort;
    this.debugLogging = config.debugLogging;
    this.debugLogFile = config.debugLogFile;
    this.client = config.apiKey
      ? new OpenAI({
          apiKey: config.apiKey,
          baseURL: config.baseUrl,
          maxRetries: 0,
          timeout: config.timeoutMs
        })
      : undefined;
  }

  public get name(): string {
    return this.config.providerName;
  }

  public async analyze(request: AnalysisRequest): Promise<LlmAnalysisResult> {
    if (!this.apiKey || !this.client) {
      throw new ProviderConfigurationError(
        `LLM provider "${this.name}" requires LLM_API_KEY before analysis can start`
      );
    }

    request.signal.throwIfAborted();
    validateRequest(request);
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeoutSignal]);
    const requestId = randomUUID();
    const requestBody = requestPayload(
      request,
      this.model,
      this.temperature,
      this.maxTokens,
      this.thinkingType,
      this.reasoningEffort
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
        "LLM response was truncated at the token limit; increase LLM_MAX_TOKENS and retry"
      );
    }
    if (content.trim().length === 0) {
      throw new ProviderRequestError("LLM returned empty analysis content");
    }

    const analysisPayload = parseJsonResponse(content);
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
        failures.push({
          segmentId,
          message: schemaIssueMessage(parsed.error)
        });
        continue;
      }
      analyses.push(parsed.data);
    }

    return {
      analyses,
      failures,
      usage: usage
        ? {
            inputTokens: usage.prompt_tokens ?? null,
            outputTokens: usage.completion_tokens ?? null,
            totalTokens: usage.total_tokens ?? null
          }
        : null
    };
  }
}