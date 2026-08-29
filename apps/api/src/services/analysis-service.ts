import {
  segmentAnalysisSchema,
  type AnalysisProgress,
  type Segment,
  type SegmentAnalysis,
  type TokenAnalysis
} from "@nihongonote/core";

import { DocumentRepository } from "../repositories/document-repository.js";
import { packingSafetyRatio, planBatches } from "../llm-budget.js";
import { estimateCost } from "../llm-pricing.js";
import { lookupToken } from "../dictionary/lookup.js";
import { alignMorphology, tokenizeWithMorphology } from "../morphology.js";
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

export interface PreparedSegmentTokens {
  /** 词典/形态素命中的 token（本地确定，不进 LLM） */
  localTokens: TokenAnalysis[];
  /** 未命中的 token 边界（LLM 只处理这些） */
  llmBoundaries: TokenBoundary[];
}

/**
 * 三层链路第 ①② 层（本地预处理，零 token，设计文档 3.1/3.3）：
 * 形态素对齐填充事实字段 + 固定用法库查表命中解释层。
 *
 * 命中规则：
 * - 词典命中 → 构造瘦身 TokenAnalysis（source=dictionary，省略恒定 null 字段）；
 *   事实字段（lemma/reading/partOfSpeech/conjugation）优先取形态素对齐结果；
 * - 未命中 → 该 token 进入 LLM 候选（llmBoundaries）。
 */
export async function prepareSegmentTokens(
  segment: Segment,
  boundaries: TokenBoundary[]
): Promise<PreparedSegmentTokens> {
  const morphology = await tokenizeWithMorphology(segment.text);
  const aligned = alignMorphology(boundaries, morphology);

  const localTokens: TokenAnalysis[] = [];
  const llmBoundaries: TokenBoundary[] = [];

  for (const boundary of boundaries) {
    const dictHit = lookupToken(boundary.surface);
    if (!dictHit) {
      llmBoundaries.push(boundary);
      continue;
    }
    const morph = aligned.get(boundary.tokenId);
    localTokens.push({
      tokenId: boundary.tokenId,
      startOffset: boundary.startOffset,
      endOffset: boundary.endOffset,
      surface: boundary.surface,
      category: dictHit.category,
      lemma: morph?.lemma ?? null,
      reading: morph?.reading ?? dictHit.reading ?? null,
      partOfSpeech: morph?.partOfSpeech ?? null,
      conjugation: morph?.conjugation ?? null,
      gloss: dictHit.gloss,
      explanation: dictHit.explanation,
      confidence: dictHit.confidence,
      source: "dictionary"
    });
  }

  return { localTokens, llmBoundaries };
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
    private readonly batchConcurrency = 2
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

  public start(documentId: string): AnalysisProgress | undefined {
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
      run.completion = this.process(documentId, run);
    }

    return this.getProgress(documentId);
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
    batch: Segment[]
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

  private async process(documentId: string, run: ActiveRun): Promise<void> {
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
          batches.map((batch) => this.processBatch(documentId, run, document, segments, batch))
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
