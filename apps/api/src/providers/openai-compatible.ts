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
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & {
    thinking?: {
      type: "enabled" | "disabled";
    };
  };

const analysisEnvelopeSchema = z.object({
  analyses: z.array(segmentAnalysisSchema)
});

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
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(thinkingType === "enabled" ? {} : { temperature }),
    stream: false
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
        timeoutMs: this.timeoutMs,
        body: requestBody,
        note: "Authorization header is intentionally omitted; request body contains source text."
      }
    );
    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        requestBody,
        { signal }
      );
    } catch (error) {
      writeDebugLog(
        this.debugLogging,
        this.debugLogFile,
        "llm.request.failed",
        requestId,
        {
          durationMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : "unknown request error",
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
        throw new ProviderRequestError(error.message, error.status ?? null);
      }
      const detail = error instanceof Error ? error.message : "unknown network error";
      throw new ProviderRequestError(`LLM request failed: ${detail}`);
    }

    const choice = completion.choices[0];
    writeDebugLog(
      this.debugLogging,
      this.debugLogFile,
      "llm.response.received",
      requestId,
      {
        durationMs: Date.now() - startedAt,
        responseId: completion.id,
        finishReason: choice?.finish_reason ?? null,
        contentLength: choice?.message.content?.length ?? 0,
        content: choice?.message.content ?? null,
        usage: completion.usage ?? null
      }
    );
    if (!choice) {
      throw new ProviderRequestError("LLM response did not contain a completion choice");
    }
    if (choice.finish_reason === "length") {
      throw new ProviderRequestError(
        "LLM response was truncated at the token limit; increase LLM_MAX_TOKENS and retry"
      );
    }
    if (!choice.message.content || choice.message.content.trim().length === 0) {
      throw new ProviderRequestError("LLM returned empty analysis content");
    }

    const analysisPayload = parseJsonResponse(choice.message.content);
    const analysisEnvelope = analysisEnvelopeSchema.safeParse(analysisPayload);
    if (!analysisEnvelope.success) {
      const issue = analysisEnvelope.error.issues[0];
      const detail = issue ? ` (${issue.path.join(".")}: ${issue.message})` : "";
      throw new ProviderRequestError(
        `LLM JSON did not match the NihongoNote analysis schema${detail}`
      );
    }

    return {
      analyses: analysisEnvelope.data.analyses,
      usage: completion.usage
        ? {
            inputTokens: completion.usage.prompt_tokens ?? null,
            outputTokens: completion.usage.completion_tokens ?? null,
            totalTokens: completion.usage.total_tokens ?? null
          }
        : null
    };
  }
}