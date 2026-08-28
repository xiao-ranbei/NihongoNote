import {
  segmentAnalysisSchema,
  type AnalysisProgress,
  type Segment,
  type SegmentAnalysis
} from "@nihongonote/core";

import { DocumentRepository } from "../repositories/document-repository.js";
import type { LlmProvider } from "../providers/types.js";
import { tokenizeJapanese, type TokenBoundary } from "../tokenization.js";

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
  private readonly activeRuns = new Map<string, {
    id: symbol;
    controller: AbortController;
  }>();

  public constructor(
    private readonly repository: DocumentRepository,
    private readonly provider: LlmProvider,
    private readonly promptVersion: string
  ) {}

  public start(documentId: string): AnalysisProgress | undefined {
    const existingProgress = this.repository.getAnalysisProgress(documentId);
    if (!existingProgress) {
      return undefined;
    }

    this.repository.markDocumentAnalyzing(documentId);
    if (!this.activeRuns.has(documentId)) {
      const run = {
        id: Symbol(documentId),
        controller: new AbortController()
      };
      this.activeRuns.set(documentId, run);
      void this.process(documentId, run);
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
    if (!documentId) {
      return undefined;
    }
    return this.start(documentId);
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

  private isCurrent(
    documentId: string,
    run: { id: symbol; controller: AbortController }
  ): boolean {
    return this.activeRuns.get(documentId)?.id === run.id && !run.controller.signal.aborted;
  }

  private async process(
    documentId: string,
    run: { id: symbol; controller: AbortController }
  ): Promise<void> {
    try {
      while (this.isCurrent(documentId, run)) {
        const document = this.repository.getById(documentId);
        if (!document) {
          return;
        }
        const segments = this.repository.getSegmentsForAnalysis(documentId);
        const segment = segments.find((candidate) => candidate.status === "queued");
        if (!segment) {
          break;
        }
        if (!this.repository.markSegmentProcessing(segment.id)) {
          continue;
        }

        try {
          const tokenBoundaries = tokenizeJapanese(segment.text, segment.id);
          const result = await this.provider.analyze({
            segments: [segment],
            tokenBoundaries,
            surroundingContext: contextFor(segment, segments),
            contentType: document.contentType,
            targetLevel: document.targetLevel,
            promptVersion: this.promptVersion,
            signal: run.controller.signal
          });

          if (!this.isCurrent(documentId, run)) {
            return;
          }
          if (result.analyses.length !== 1) {
            throw new Error(
              `LLM returned ${result.analyses.length} analyses for segment ${segment.id}; expected exactly one`
            );
          }

          const analysis = validateAnalysis(segment, result.analyses[0]!, tokenBoundaries);
          this.repository.saveSegmentAnalysis(
            segment.id,
            analysis,
            this.provider.name,
            this.provider.model,
            this.promptVersion,
            result.usage
          );
        } catch (reason: unknown) {
          if (!this.isCurrent(documentId, run)) {
            return;
          }
          this.repository.markSegmentFailed(segment.id, errorMessage(reason));
        }
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
