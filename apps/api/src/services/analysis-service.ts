import {
  segmentAnalysisSchema,
  type AnalysisPreview,
  type AnalysisProgress,
  type Segment,
  type SegmentAnalysis,
  type SegmentFieldProfile,
  type TokenAnalysis
} from "@nihongonote/core";

import {
  countSegmentTokens,
  estimateAnalysisTokens,
  estimatePreviewCost
} from "../analysis-preview.js";
import { getDictionaryStats, getDictionaryVersion } from "../dictionary/lookup.js";
import { DocumentRepository } from "../repositories/document-repository.js";
import { packingSafetyRatio, planBatches } from "../llm-budget.js";
import { estimateCost } from "../llm-pricing.js";
import { prepareSegmentTokens } from "../segment-preparation.js";
import type {
  LlmAnalysisResult,
  LlmProvider,
  SegmentTokenBoundaries
} from "../providers/types.js";
import { tokenizeJapanese, type TokenBoundary } from "../tokenization.js";

interface ActiveRun {
  id: symbol;
  controller: AbortController;
  completion: Promise<void>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "分析失败，原因未知";
}

function validateAnalysis(
  segment: Segment,
  analysis: SegmentAnalysis,
  tokenBoundaries: TokenBoundary[]
): SegmentAnalysis {
  const parsed = segmentAnalysisSchema.parse(analysis);
  if (parsed.segmentId !== segment.id) {
    throw new Error(`LLM returned an unexpected segment ID: ${parsed.segmentId}`);
  }

  if (parsed.tokens.length !== tokenBoundaries.length) {
    throw new Error(
      `LLM returned ${parsed.tokens.length} token analyses for segment ${segment.id}; expected ${tokenBoundaries.length}`
    );
  }

  const boundariesById = new Map(tokenBoundaries.map((boundary) => [boundary.tokenId, boundary]));
  const tokenIds = new Set<string>();
  for (const token of parsed.tokens) {
    if (tokenIds.has(token.tokenId)) {
      throw new Error(`LLM returned duplicate token ID: ${token.tokenId}`);
    }
    tokenIds.add(token.tokenId);

    const boundary = boundariesById.get(token.tokenId);
    if (!boundary) {
      throw new Error(`LLM returned an unexpected token ID: ${token.tokenId}`);
    }
    if (
      token.startOffset !== boundary.startOffset
      || token.endOffset !== boundary.endOffset
      || token.surface !== boundary.surface
    ) {
      throw new Error(`Token ${token.tokenId} does not match the local token boundary`);
    }
  }

  return parsed;
}

/**
 * 三层链路第 ③ 层合并：把本地命中 token 与 LLM 返回的未命中 token
 * 合并为完整 segment 分析。
 *
 * - 顺序：严格按本地边界顺序（token 顺序与 ID 稳定）；
 * - 不重不漏：合并后必须恰好覆盖全部边界；
 * - 附加 schemaVersion（I-7）与 dictionaryCoverage（设计文档 3.7）。
 */
export function mergeAnalysis(
  segment: Segment,
  boundaries: TokenBoundary[],
  localTokens: TokenAnalysis[],
  llmAnalysis: SegmentAnalysis
): SegmentAnalysis {
  const byId = new Map<string, TokenAnalysis>();
  for (const token of localTokens) {
    byId.set(token.tokenId, token);
  }
  for (const token of llmAnalysis.tokens) {
    byId.set(token.tokenId, token);
  }

  const merged = boundaries.map((boundary) => {
    const token = byId.get(boundary.tokenId);
    if (!token) {
      throw new Error(`Merged analysis is missing token ${boundary.tokenId}`);
    }
    return token;
  });
  if (merged.length !== byId.size) {
    throw new Error(`Merged analysis contains tokens outside the boundary list (${byId.size - merged.length} extra)`);
  }

  return segmentAnalysisSchema.parse({
    segmentId: segment.id,
    translation: llmAnalysis.translation,
    grammarSummary: llmAnalysis.grammarSummary,
    register: llmAnalysis.register,
    tone: llmAnalysis.tone,
    politeness: llmAnalysis.politeness,
    impliedMeaning: llmAnalysis.impliedMeaning,
    replyReason: llmAnalysis.replyReason,
    uncertaintyNote: llmAnalysis.uncertaintyNote,
    tokens: merged,
    schemaVersion: 1,
    dictionaryCoverage: {
      matched: localTokens.length,
      total: merged.length
    }
  });
}

function contextFor(segment: Segment, allSegments: Segment[]): string[] {
  const context: string[] = [];
  const previous = allSegments[segment.index - 1];
  const next = allSegments[segment.index + 1];

  if (previous) {
    context.push(`上一句${previous.speaker ? `（${previous.speaker}）` : ""}：${previous.text}`);
  }
  if (next) {
    context.push(`下一句${next.speaker ? `（${next.speaker}）` : ""}：${next.text}`);
  }

  return context;
}

export class AnalysisService {
  private readonly activeRuns = new Map<string, ActiveRun>();

  public constructor(
    private readonly repository: DocumentRepository,
    private readonly provider: LlmProvider,
    private readonly promptVersion: string,
    private readonly batchSize = 3,
    private readonly batchConcurrency = 2,
    /**
     * 段级语义字段档位默认值（config.LLM_SEGMENT_FIELDS）。
     * 工具页请求显式传档位时覆盖它；预览估算与实际分析必须用同一档位。
     */
    private readonly defaultSegmentFields: SegmentFieldProfile = "standard"
  ) {}

  /**
   * 进度 + 用量 + 费用。
   *
   * 进度本身只统计句段状态；用量/费用是附加信息，由 repository 聚合 usage_json、
   * 再按 provider 当前模型的内置价格表折算（模型不在表内则 cost 为 null）。
   * 所有对外返回进度的入口（start / cancel / retry / 轮询）都走这里，保证口径一致。
   */
  public getProgress(documentId: string): AnalysisProgress | undefined {
    const progress = this.repository.getAnalysisProgress(documentId);
    if (!progress) {
      return undefined;
    }
    const costInfo = this.repository.getAnalysisCost(documentId);
    const usage = costInfo
      ? {
          inputTokens: costInfo.usage.inputTokens,
          outputTokens: costInfo.usage.outputTokens,
          totalTokens: costInfo.usage.totalTokens,
          // getAnalysisCost 聚合后必然有值，但类型上是可空字段，显式归一为 null
          cachedInputTokens: costInfo.usage.cachedInputTokens ?? null
        }
      : null;
    const cost = costInfo ? estimateCost(costInfo.model, costInfo.usage) : null;
    return { ...progress, usage, cost };
  }

  public start(
    documentId: string,
    segmentFields: SegmentFieldProfile = this.defaultSegmentFields
  ): AnalysisProgress | undefined {
    const existingProgress = this.repository.getAnalysisProgress(documentId);
    if (!existingProgress) {
      return undefined;
    }

    this.repository.markDocumentAnalyzing(documentId);
    if (!this.activeRuns.has(documentId)) {
      const run: ActiveRun = {
        id: Symbol(documentId),
        controller: new AbortController(),
        completion: Promise.resolve()
      };
      this.activeRuns.set(documentId, run);
      run.completion = this.process(documentId, run, segmentFields);
    }

    return this.getProgress(documentId);
  }

  /**
   * 仅词典分析（设计文档 3.4/3.6，零 LLM 调用，零费用）：
   *
   * 只处理词典/形态素命中的 token——命中者瘦身落库（source=dictionary），
   * 未命中 token 不进入分析（不编造解释）；句段级语义字段（translation/tone 等）
   * 全部为 null。全部本地完成，同步返回最新进度；找不到文章返回 undefined。
   *
   * 语义与「完整分析」保持一致：只处理 queued 句段，已完成句段保留不动
   * （重复运行不会重复计费，也不会删除已有 AI 分析）。
   */
  public async startDictionaryOnly(documentId: string): Promise<AnalysisProgress | undefined> {
    const document = this.repository.getById(documentId);
    if (!document) {
      return undefined;
    }

    this.repository.markDocumentAnalyzing(documentId);
    for (const segment of document.segments) {
      const claimed = this.repository.markSegmentProcessing(segment.id);
      if (!claimed) {
        continue; // 非 queued（已完成/失败）的句段跳过，保留现有结果
      }
      const boundaries = tokenizeJapanese(segment.text, segment.id);
      const { localTokens } = await prepareSegmentTokens(segment, boundaries);
      const analysis = segmentAnalysisSchema.parse({
        segmentId: segment.id,
        translation: null,
        grammarSummary: null,
        register: null,
        tone: null,
        politeness: null,
        impliedMeaning: null,
        replyReason: null,
        uncertaintyNote: null,
        tokens: localTokens,
        schemaVersion: 1,
        dictionaryCoverage: {
          matched: localTokens.length,
          total: boundaries.length
        }
      });
      this.repository.saveSegmentAnalysis(
        segment.id,
        analysis,
        "dictionary",
        "local",
        this.dictionaryVersion,
        null
      );
    }
    return this.repository.finalizeDocumentAnalysis(documentId);
  }

  /**
   * 工具页策略/费用预览（设计文档 §六-4，纯本地统计，零 LLM 调用）。
   *
   * 对每篇文章做分词 + 三层链路本地预处理，统计词典覆盖率与未命中 token，
   * 再按当前模型内置价格表估算闲时/高峰两档费用。不存在的文章直接跳过。
   */
  public async previewAnalysis(
    documentIds: string[],
    segmentFields: SegmentFieldProfile = this.defaultSegmentFields
  ): Promise<AnalysisPreview> {
    const documents: AnalysisPreview["documents"] = [];
    const totals: AnalysisPreview["totals"] = {
      segmentCount: 0,
      totalTokens: 0,
      matchedTokens: 0,
      unmissedTokens: 0,
      dictionaryCoverage: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedTotalTokens: 0,
      estimatedCost: null
    };

    for (const documentId of documentIds) {
      const document = this.repository.getById(documentId);
      if (!document) {
        continue;
      }
      const stats = await countSegmentTokens(document.segments);
      const estimate = estimateAnalysisTokens(document.segments.length, stats.unmissedTokens, segmentFields);
      const estimatedCost = estimatePreviewCost(this.provider.model, estimate);
      documents.push({
        documentId: document.id,
        title: document.title,
        segmentCount: document.segments.length,
        totalTokens: stats.totalTokens,
        matchedTokens: stats.matchedTokens,
        unmissedTokens: stats.unmissedTokens,
        dictionaryCoverage: stats.totalTokens > 0 ? stats.matchedTokens / stats.totalTokens : 0,
        estimatedInputTokens: estimate.inputTokens,
        estimatedOutputTokens: estimate.outputTokens,
        estimatedTotalTokens: estimate.totalTokens,
        estimatedCost
      });
      totals.segmentCount += document.segments.length;
      totals.totalTokens += stats.totalTokens;
      totals.matchedTokens += stats.matchedTokens;
      totals.unmissedTokens += stats.unmissedTokens;
      totals.estimatedInputTokens += estimate.inputTokens;
      totals.estimatedOutputTokens += estimate.outputTokens;
      totals.estimatedTotalTokens += estimate.totalTokens;
    }
    totals.dictionaryCoverage = totals.totalTokens > 0
      ? totals.matchedTokens / totals.totalTokens
      : 0;
    totals.estimatedCost = estimatePreviewCost(
      this.provider.model,
      {
        inputTokens: totals.estimatedInputTokens,
        outputTokens: totals.estimatedOutputTokens,
        totalTokens: totals.estimatedTotalTokens
      }
    );

    return {
      dictionaryVersion: getDictionaryVersion(),
      dictionaryStats: getDictionaryStats(),
      provider: {
        configured: this.provider.configured,
        model: this.provider.model,
        // Ollama 等本地模型无 API 费用，前端据此显示「本地免费」而非「价格未知」
        isLocal: this.provider.name === "ollama"
      },
      documents,
      totals
    };
  }

  private get dictionaryVersion(): string {
    return getDictionaryVersion();
  }

  public retrySegment(segmentId: string): AnalysisProgress | undefined {
    const segment = this.repository.getSegment(segmentId);
    if (!segment) {
      return undefined;
    }
    if (this.activeRuns.has(segment.documentId)) {
      this.cancel(segment.documentId);
    }
    const documentId = this.repository.queueSegmentRetry(segmentId);
    return documentId ? this.start(documentId) : undefined;
  }

  public cancel(documentId: string): AnalysisProgress | undefined {
    const progress = this.repository.getAnalysisProgress(documentId);
    if (!progress) {
      return undefined;
    }
    const run = this.activeRuns.get(documentId);
    if (!run) {
      return this.getProgress(documentId);
    }
    this.activeRuns.delete(documentId);
    run.controller.abort(new DOMException("Analysis cancelled by user", "AbortError"));
    return this.repository.markDocumentAnalysisCancelled(documentId)
      ? this.getProgress(documentId)
      : undefined;
  }

  public cancelAll(): void {
    for (const documentId of [...this.activeRuns.keys()]) {
      this.cancel(documentId);
    }
  }

  public async close(): Promise<void> {
    const completions = [...this.activeRuns.values()].map((run) => run.completion);
    this.cancelAll();
    await Promise.allSettled(completions);
  }

  private isCurrent(documentId: string, run: ActiveRun): boolean {
    return this.activeRuns.get(documentId)?.id === run.id && !run.controller.signal.aborted;
  }

  private async processBatch(
    documentId: string,
    run: ActiveRun,
    document: NonNullable<ReturnType<DocumentRepository["getById"]>>,
    allSegments: Segment[],
    batch: Segment[],
    segmentFields: SegmentFieldProfile
  ): Promise<void> {
    // ① 本地边界（全量，确定性）
    const tokenBoundaries: SegmentTokenBoundaries[] = batch.map((segment) => ({
      segmentId: segment.id,
      tokens: tokenizeJapanese(segment.text, segment.id)
    }));

    // ② 本地预处理（三层链路 ①② 层）：形态素填充事实字段 + 词典查表命中解释层。
    //    词典命中的 token 直接本地确定，不进入 LLM（零 token）。
    const prepared = await Promise.all(batch.map(async (segment, index) => {
      const boundaries = tokenBoundaries[index]!.tokens;
      const { localTokens, llmBoundaries } = await prepareSegmentTokens(segment, boundaries);
      return { segment, boundaries, localTokens, llmBoundaries };
    }));

    let result: LlmAnalysisResult;
    try {
      result = await this.provider.analyze({
        segments: batch,
        // ③ LLM 解释层：只处理未命中 token（设计文档 3.1）——
        //    词典命中 token 不进 AI batch，从源头省 token。
        tokenBoundaries: prepared.map((item) => ({
          segmentId: item.segment.id,
          tokens: item.llmBoundaries
        })),
        surroundingContext: batch.map((segment) => ({
          segmentId: segment.id,
          context: contextFor(segment, allSegments)
        })),
        contentType: document.contentType,
        targetLevel: document.targetLevel,
        promptVersion: this.promptVersion,
        segmentFields,
        signal: run.controller.signal
      });
    } catch (reason: unknown) {
      if (!this.isCurrent(documentId, run)) {
        return;
      }
      const message = errorMessage(reason);
      for (const segment of batch) {
        this.repository.markSegmentFailed(segment.id, message);
      }
      return;
    }

    if (!this.isCurrent(documentId, run)) {
      return;
    }

    const analysesBySegment = new Map<string, SegmentAnalysis[]>();
    for (const analysis of result.analyses) {
      const analyses = analysesBySegment.get(analysis.segmentId) ?? [];
      analyses.push(analysis);
      analysesBySegment.set(analysis.segmentId, analyses);
    }
    const failuresBySegment = new Map<string, string[]>();
    const unassignedFailures: string[] = [];
    for (const failure of result.failures) {
      if (failure.segmentId === null) {
        unassignedFailures.push(failure.message);
      } else {
        const failures = failuresBySegment.get(failure.segmentId) ?? [];
        failures.push(failure.message);
        failuresBySegment.set(failure.segmentId, failures);
      }
    }

    for (const [index, segment] of batch.entries()) {
      if (!this.isCurrent(documentId, run)) {
        return;
      }
      const analyses = analysesBySegment.get(segment.id) ?? [];
      const failures = failuresBySegment.get(segment.id) ?? [];
      try {
        if (failures.length > 0) {
          throw new Error(failures.join("; "));
        }
        if (analyses.length !== 1) {
          const detail = analyses.length === 0
            ? (unassignedFailures[0] ?? "LLM omitted this segment from the batch response")
            : `LLM returned duplicate analyses for segment ${segment.id}`;
          throw new Error(detail);
        }
        const preparedGroup = prepared[index];
        if (!preparedGroup || preparedGroup.segment.id !== segment.id) {
          throw new Error(`Internal token boundary mismatch for segment ${segment.id}`);
        }
        // LLM 输出只校验未命中子集
        const analysis = validateAnalysis(segment, analyses[0]!, preparedGroup.llmBoundaries);
        // 合并本地命中 + LLM 未命中 → 完整 segment 分析（顺序稳定、不重不漏）
        const merged = mergeAnalysis(
          segment,
          preparedGroup.boundaries,
          preparedGroup.localTokens,
          analysis
        );
        this.repository.saveSegmentAnalysis(
          segment.id,
          merged,
          this.provider.name,
          this.provider.model,
          this.promptVersion,
          result.usage
        );
      } catch (reason: unknown) {
        this.repository.markSegmentFailed(segment.id, errorMessage(reason));
      }
    }
  }

  private async process(
    documentId: string,
    run: ActiveRun,
    segmentFields: SegmentFieldProfile
  ): Promise<void> {
    try {
      while (this.isCurrent(documentId, run)) {
        const document = this.repository.getById(documentId);
        if (!document) {
          return;
        }
        const segments = this.repository.getSegmentsForAnalysis(documentId);
        const queued = segments.filter((segment) => segment.status === "queued");
        if (queued.length === 0) {
          break;
        }

        /*
         * 按估算成本装箱，而不是按固定段数切。
         * 固定段数在长句段上会把单次请求顶到 token 上限（实测样本 2 因此丢 3 段），
         * 而一味调小 batch_size 又让短句段多花请求。batchSize 退化为"最多几段"。
         */
        const tokenBudget = Math.floor(
          this.provider.completionTokenBudget * packingSafetyRatio
        );
        const batches = planBatches(queued, this.batchSize, tokenBudget)
          .slice(0, this.batchConcurrency)
          .map((batch) => {
            const claimed = new Set(this.repository.markSegmentsProcessing(batch.map((segment) => segment.id)));
            return batch.filter((segment) => claimed.has(segment.id));
          })
          .filter((batch) => batch.length > 0);

        if (batches.length === 0) {
          continue;
        }
        await Promise.all(
          batches.map((batch) => this.processBatch(documentId, run, document, segments, batch, segmentFields))
        );
      }

      if (this.isCurrent(documentId, run)) {
        this.repository.finalizeDocumentAnalysis(documentId);
      }
    } catch (reason: unknown) {
      if (this.isCurrent(documentId, run)) {
        this.repository.markDocumentAnalysisFailed(documentId, errorMessage(reason));
      }
    } finally {
      if (this.activeRuns.get(documentId)?.id === run.id) {
        this.activeRuns.delete(documentId);
      }
    }
  }
}
