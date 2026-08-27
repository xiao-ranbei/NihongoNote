import { z } from "zod";

import { segmentAnalysisSchema } from "@nihongonote/core";

import {
  ProviderConfigurationError,
  ProviderRequestError,
  type AnalysisRequest,
  type LlmAnalysisResult,
  type LlmProtocol,
  type LlmProvider,
  type LlmUsage
} from "./types.js";

interface OpenAiCompatibleProviderConfig {
  providerName: string;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

const completionResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.string().nullable().optional()
    }),
    finish_reason: z.string().nullable().optional()
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional()
  }).optional()
});

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

Each token must contain tokenId, startOffset, endOffset, surface, lemma, reading, partOfSpeech,
conjugation, gloss, particleFunction, grammarPoint, explanation, and confidence.
The user payload provides the deterministic token boundaries. Return exactly one token analysis for
each provided boundary, preserving tokenId, startOffset, endOffset, and surface exactly.
Token offsets are JavaScript UTF-16 offsets relative to that segment's text. Use null for a field that
is not applicable or cannot be determined.
Do not invent context. If multiple interpretations are reasonable, say so in uncertaintyNote.
The word JSON must be followed: do not wrap it in Markdown fences.`;

function endpointFor(baseUrl: string): string {
  return new URL("chat/completions", `${baseUrl.replace(/\/+$/u, "")}/`).toString();
}

function parseJsonResponse(responseBody: string): unknown {
  try {
    return JSON.parse(responseBody) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown JSON parse error";
    throw new ProviderRequestError(`LLM returned invalid JSON: ${detail}`);
  }
}

function providerErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null || !("error" in payload)) {
    return fallback;
  }

  const providerError = payload.error;
  if (typeof providerError === "string" && providerError.trim().length > 0) {
    return providerError;
  }
  if (typeof providerError === "object" && providerError !== null && "message" in providerError) {
    const message = providerError.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }
  return fallback;
}

function toUsage(usage: z.infer<typeof completionResponseSchema>["usage"]): LlmUsage | null {
  if (!usage) {
    return null;
  }
  return {
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null
  };
}

function requestPayload(request: AnalysisRequest, model: string, temperature: number, maxTokens: number) {
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
    temperature,
    max_tokens: maxTokens,
    response_format: {
      type: "json_object"
    },
    stream: false
  };
}

export class OpenAiCompatibleLlmProvider implements LlmProvider {
  public readonly protocol: LlmProtocol = "openai";
  public readonly configured: boolean;
  public readonly model: string;

  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  public constructor(private readonly config: OpenAiCompatibleProviderConfig) {
    this.model = config.model;
    this.configured = config.apiKey !== undefined;
    this.endpoint = endpointFor(config.baseUrl);
    this.apiKey = config.apiKey;
    this.temperature = config.temperature;
    this.maxTokens = config.maxTokens;
    this.timeoutMs = config.timeoutMs;
  }

  public get name(): string {
    return this.config.providerName;
  }

  public async analyze(request: AnalysisRequest): Promise<LlmAnalysisResult> {
    if (!this.apiKey) {
      throw new ProviderConfigurationError(
        `LLM provider "${this.name}" requires LLM_API_KEY before analysis can start`
      );
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(requestPayload(request, this.model, this.temperature, this.maxTokens)),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown network error";
      throw new ProviderRequestError(`LLM request failed: ${detail}`);
    }

    const responseBody = await response.text();
    const payload = parseJsonResponse(responseBody);
    if (!response.ok) {
      throw new ProviderRequestError(
        providerErrorMessage(payload, `LLM request failed with HTTP ${response.status}`),
        response.status
      );
    }

    const completion = completionResponseSchema.safeParse(payload);
    if (!completion.success) {
      throw new ProviderRequestError("LLM response did not match the OpenAI-compatible format");
    }

    const choice = completion.data.choices[0];
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
      throw new ProviderRequestError("LLM JSON did not match the NihongoNote analysis schema");
    }

    return {
      analyses: analysisEnvelope.data.analyses,
      usage: toUsage(completion.data.usage)
    };
  }
}
