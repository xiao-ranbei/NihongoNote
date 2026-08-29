import {
  segmentAnalysisSchema,
  type AnalysisProgress,
  type Segment,
  type SegmentAnalysis
} from "@nihongonote/core";

import { DocumentRepository } from "../repositories/document-repository.js";
import { packingSafetyRatio, planBatches } from "../llm-budget.js";
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

    return this.repository.getAnalysisProgress(documentId);
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
      return progress;
    }
    this.activeRuns.delete(documentId);
    run.controller.abort(new DOMException("Analysis cancelled by user", "AbortError"));
    return this.repository.markDocumentAnalysisCancelled(documentId);
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
    const tokenBoundaries: SegmentTokenBoundaries[] = batch.map((segment) => ({
      segmentId: segment.id,
      tokens: tokenizeJapanese(segment.text, segment.id)
    }));

    let result: LlmAnalysisResult;
    try {
      result = await this.provider.analyze({
        segments: batch,
        tokenBoundaries,
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
        const boundaryGroup = tokenBoundaries[index];
        if (!boundaryGroup || boundaryGroup.segmentId !== segment.id) {
          throw new Error(`Internal token boundary mismatch for segment ${segment.id}`);
        }
        const analysis = validateAnalysis(segment, analyses[0]!, boundaryGroup.tokens);
        this.repository.saveSegmentAnalysis(
          segment.id,
          analysis,
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
