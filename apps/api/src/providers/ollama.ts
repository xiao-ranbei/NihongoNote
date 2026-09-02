import { randomUUID } from "node:crypto";

import { z } from "zod";

import { segmentAnalysisSchema, type SegmentFieldProfile } from "@nihongonote/core";

import {
  buildSystemPrompt,
  parseJsonResponse,
  sanitizedErrorMessage,
  schemaIssueMessage,
  validateRequest,
  writeDebugLog
} from "./openai-compatible.js";
import {
  ProviderConfigurationError,
  ProviderRequestError,
  type AnalysisRequest,
  type LlmAnalysisResult,
  type LlmBalance,
  type LlmProtocol,
  type LlmProvider
} from "./types.js";

/*
 * Ollama 本地模型专用 provider（原生 /api/chat 协议）。
 *
 * 为什么不用 OpenAI 兼容层（/v1/chat/completions）？2026-08-30 实测：
 *  1. 兼容层强制 num_ctx=4096（usage.total_tokens 卡 4096，顶层/options 的 num_ctx
 *     均被忽略）——prompt 占掉 ~2K 后只剩 ~2K 输出空间，真实分析必然截断；
 *  2. 兼容层无法关闭 qwen3.5 系的 thinking（think:false / thinking:false /
 *     options.think 均无效，reasoning_effort 仅 "none" 有效），思考会把
 *     max_tokens 吃光（content 为空、finish_reason=length）。
 * 原生 /api/chat 两个问题都不存在：options.num_ctx 实测可扩到 16K+（实测 16352
 * 输出 tokens），think:false 实测有效。代价是流式协议不同（每行一个 JSON 对象，
 * 非 OpenAI 的 delta 结构），由本 provider 负责解析。
 *
 * 设计文档 3.9（Ollama 支持）的四个特判在本 provider 内建：
 *  - configured 恒 true（localhost 免鉴权，无 API key 概念）；
 *  - fetchBalance() 返回 null（无 /user/balance 端点，前端显示不可用）；
 *  - 不发 response_format（JSON 模式兼容不稳定，靠 prompt 的 "Return raw JSON only"）；
 *  - 预览费用「本地免费」由 analysis-service 的 isLocal（name === "ollama"）驱动。
 */

interface OllamaProviderConfig {
  providerName: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  debugLogging: boolean;
  debugLogFile: string;
}

/** Ollama /api/chat 流式响应：每行一个 JSON 对象，done=true 时携带用量与结束原因。 */
interface OllamaStreamChunk {
  message?: {
    role?: string;
    content?: string;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const segmentIdSchema = z.object({
  segmentId: z.string().min(1)
}).passthrough();

const analysisEnvelopeSchema = z.object({
  analyses: z.array(z.unknown())
}).strict();

/** baseUrl 可能写成 http://127.0.0.1:11434 或 …/v1，统一归一化到 /api/chat。 */
function chatEndpointFor(baseUrl: string): string {
  return new URL(
    "api/chat",
    `${baseUrl.replace(/\/+$/u, "").replace(/\/v1$/iu, "")}/`
  ).toString();
}

export class OllamaProvider implements LlmProvider {
  public readonly protocol: LlmProtocol = "openai";
  public readonly configured = true;
  public readonly model: string;
  /**
   * 本地模型单批输出预算（内存约束，见 analyze 注释）。planBatches 按此装箱：
   * 超预算的长句段自动单独成批，不会截断；远小于云端硬上限（32000）。
   * 配置上限（LLM_MAX_TOKENS）再大也会被压缩到 8K，保护 16GB VRAM 不 OOM。
   */
  public readonly completionTokenBudget: number;

  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly debugLogging: boolean;
  private readonly debugLogFile: string;
  private readonly endpoint: string;
  private readonly tagsEndpoint: string;

  public constructor(private readonly config: OllamaProviderConfig) {
    this.completionTokenBudget = Math.min(config.maxTokens, 8_192);
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
    this.temperature = config.temperature;
    this.debugLogging = config.debugLogging;
    this.debugLogFile = config.debugLogFile;
    this.endpoint = chatEndpointFor(config.baseUrl);
    this.tagsEndpoint = new URL(
      "api/tags",
      `${config.baseUrl.replace(/\/+$/u, "").replace(/\/v1$/iu, "")}/`
    ).toString();
  }

  public get name(): string {
    return this.config.providerName;
  }

  /**
   * 分析前探活本地服务（2026-09-01 新增，见调查报告根因 3）。
   *
   * `configured` 对 Ollama 恒为 true（localhost 免鉴权，无 key 概念），
   * 于是服务没启动时 provider 仍判定「可用」，每个句段都要跑满 timeout
   * （当时 60s）才失败，整篇分析要白白等上十几分钟，而 UI 只显示
   * 「本句分析失败」，用户完全看不出是服务没起。
   * 这里花几毫秒探一次 /api/tags，把「服务未启动」「模型未拉取」两类
   * 配置问题一次性暴露成可操作的错误，而不是让每个句段各超时一遍。
   */
  private async assertServerReady(signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.tagsEndpoint, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)])
      });
    } catch (error) {
      if (signal.aborted) {
        return; // 用户主动取消，交给后续流程统一处理
      }
      throw new ProviderConfigurationError(
        `本地模型服务未启动或无法连接（${this.tagsEndpoint}）。`
        + "请先启动 Ollama 再重试分析。"
        + `原始错误：${sanitizedErrorMessage(error, undefined)}`
      );
    }

    if (!response.ok) {
      throw new ProviderConfigurationError(
        `本地模型服务响应异常：${this.tagsEndpoint} 返回 HTTP ${response.status}`
      );
    }

    const payload = await response.json() as { models?: Array<{ name?: string }> };
    const installed = (payload.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    if (installed.length === 0) {
      return; // 空列表不误判（部分版本/代理不返回详情）
    }
    // 请求 "qwen3.5" 而列表是 "qwen3.5:9b" 也算命中：比较 tag 之前的部分
    const requested = this.model;
    const hit = installed.some(
      (name) => name === requested || name.split(":")[0] === requested.split(":")[0]
    );
    if (!hit) {
      throw new ProviderConfigurationError(
        `本地模型 "${requested}" 未安装。已安装：${installed.join("、")}。`
        + `请先执行 ollama pull ${requested}`
      );
    }
  }

  public async analyze(request: AnalysisRequest): Promise<LlmAnalysisResult> {
    request.signal.throwIfAborted();
    validateRequest(request);
    await this.assertServerReady(request.signal);

    const requestId = randomUUID();
    const segmentFields: SegmentFieldProfile = request.segmentFields ?? "standard";
    // 本地模型内存预算（2026-08-30 实测校准，16GB VRAM / 9B Q4 权重 ~6.6GB）：
    //  - KV cache ≈ 2×层数×隐藏维×2B/token ≈ 590KB/token（qwen3.5 9B 量级）；
    //  - num_ctx=12288 → KV ~7GB，加权重 ~6.6GB ≈ 13.6GB，在 16GB VRAM 内安全；
    //  - 此前把 num_ctx 顶到 40K（≈23GB KV）直接 OOM 崩溃（实测 2026-08-30）。
    // 输出预算 8K：本地模型按档位输出结构化 JSON（14 字段/token），单批 2~4 段
    // 实际输出 ~3~6K tokens，8K 留有安全余量；planBatches 按 completionTokenBudget
    // 装箱会自动把超预算的长句段单独成批，因此不会因预算小导致截断。
    const maxTokens = this.completionTokenBudget;
    const numCtx = maxTokens + 4_096; // prompt（system+段文本+边界）约 2~4K 余量

    const body = {
      model: this.model,
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
      // think:false 关闭 qwen3.5 系思考（实测有效，与 reasoning_effort 无关）；
      // num_predict 限制输出上限（等价 OpenAI 的 max_tokens）。
      think: false,
      options: {
        num_ctx: numCtx,
        num_predict: maxTokens,
        temperature: this.temperature
      },
      stream: true
    };

    writeDebugLog(this.debugLogging, this.debugLogFile, "llm.request.started", requestId, {
      provider: this.name,
      protocol: this.protocol,
      baseUrl: this.config.baseUrl,
      endpoint: this.endpoint,
      model: this.model,
      stream: true,
      segmentIds: request.segments.map((segment) => segment.id),
      timeoutMs: this.timeoutMs,
      body,
      note: "Ollama native /api/chat; think disabled; no Authorization header."
    });

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeoutSignal]);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal
      });
    } catch (error) {
      writeDebugLog(this.debugLogging, this.debugLogFile, "llm.request.failed", requestId, {
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: sanitizedErrorMessage(error, undefined)
      });
      if (request.signal.aborted) {
        throw request.signal.reason instanceof Error
          ? request.signal.reason
          : new DOMException("Analysis cancelled", "AbortError");
      }
      if (timeoutSignal.aborted) {
        throw new ProviderRequestError(`LLM request timed out after ${this.timeoutMs}ms`);
      }
      throw new ProviderRequestError(`LLM request failed: ${sanitizedErrorMessage(error, undefined)}`);
    }

    if (!response.ok) {
      let detail = `status ${response.status}`;
      try {
        const payload = await response.json() as OllamaStreamChunk;
        if (payload.error) {
          detail = payload.error;
        }
      } catch {
        // 非 JSON 错误体，保留状态码即可
      }
      throw new ProviderRequestError(`Ollama request failed with ${detail}`);
    }

    if (!response.body) {
      throw new ProviderRequestError("Ollama response has no body stream");
    }

    // 逐行解析 Ollama 流式响应（每行一个 JSON 对象）
    let content = "";
    let finishReason: string | null = null;
    let promptEvalCount: number | null = null;
    let evalCount: number | null = null;
    let chunkCount = 0;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) {
            continue;
          }
          let chunk: OllamaStreamChunk;
          try {
            chunk = JSON.parse(line) as OllamaStreamChunk;
          } catch {
            // Ollama 偶尔输出不完整行，跳过不中断（内容在后续行继续）
            continue;
          }
          chunkCount += 1;
          if (chunk.message?.content) {
            content += chunk.message.content;
          }
          if (chunk.done) {
            finishReason = chunk.done_reason ?? "stop";
            promptEvalCount = chunk.prompt_eval_count ?? null;
            evalCount = chunk.eval_count ?? null;
          }
        }
      }
    } catch (error) {
      writeDebugLog(this.debugLogging, this.debugLogFile, "llm.request.failed", requestId, {
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorMessage: sanitizedErrorMessage(error, undefined),
        statusCode: null
      });
      if (request.signal.aborted) {
        throw request.signal.reason instanceof Error
          ? request.signal.reason
          : new DOMException("Analysis cancelled", "AbortError");
      }
      if (timeoutSignal.aborted) {
        throw new ProviderRequestError(`LLM request timed out after ${this.timeoutMs}ms`);
      }
      throw new ProviderRequestError(`LLM request failed: ${sanitizedErrorMessage(error, undefined)}`);
    } finally {
      reader.releaseLock();
    }

    writeDebugLog(this.debugLogging, this.debugLogFile, "llm.response.received", requestId, {
      durationMs: Date.now() - startedAt,
      finishReason,
      chunkCount,
      contentLength: content.length,
      usage: {
        inputTokens: promptEvalCount,
        outputTokens: evalCount,
        totalTokens: promptEvalCount !== null && evalCount !== null
          ? promptEvalCount + evalCount
          : null
      }
    });

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
      writeDebugLog(this.debugLogging, this.debugLogFile, "llm.json.invalid", requestId, {
        message: error instanceof Error ? error.message : "unknown JSON parse error",
        contentLength: content.length,
        excerpt: content.slice(0, 8_000)
      });
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
        writeDebugLog(this.debugLogging, this.debugLogFile, "llm.schema.mismatch", requestId, {
          segmentId,
          message,
          issues: parsed.error.issues.slice(0, 5),
          rawItem: JSON.stringify(item).slice(0, 2_000)
        });
        failures.push({ segmentId, message });
        continue;
      }
      analyses.push(parsed.data);
    }

    return {
      analyses,
      failures,
      usage: promptEvalCount !== null || evalCount !== null
        ? {
            inputTokens: promptEvalCount,
            outputTokens: evalCount,
            totalTokens: promptEvalCount !== null && evalCount !== null
              ? promptEvalCount + evalCount
              : null,
            // Ollama 无缓存命中细分，且本地不花钱，cachedInputTokens 不适用
            cachedInputTokens: null
          }
        : null
    };
  }

  public async fetchBalance(): Promise<LlmBalance | null> {
    // 本地 provider：无 /user/balance 端点，也没有余额概念（返回 null，前端显示不可用）
    return null;
  }
}
