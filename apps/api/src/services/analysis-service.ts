import {
  segmentAnalysisSchema,
  type AnalysisPreview,
  type AnalysisProgress,
  type Segment,
  type AnalysisStreamEvent,
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
import { classifyError, observability } from "../observability.js";
import { estimateCost } from "../llm-pricing.js";
import { prepareSegmentTokens } from "../segment-preparation.js";
import type { ContentDictionaryHolder } from "../dictionary/content/index.js";
import type { GlossTranslator } from "../dictionary/content/translator.js";
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
  /** 开始时刻：duration_ms 的基准（OBS-002）。 */
  startedAt: number;
  /** 首个段落完成落库的时刻；null = 尚无段落完成（first_segment_ms 的度量，STREAM-005）。 */
  firstSegmentAt: number | null;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "分析失败，原因未知";
}

export function validateAnalysis(
  segment: Pick<Segment, "id">,
  analysis: SegmentAnalysis,
  tokenBoundaries: TokenBoundary[]
): SegmentAnalysis {
  const parsed = segmentAnalysisSchema.parse(analysis);
  if (parsed.segmentId !== segment.id) {
    throw new Error(`LLM returned an unexpected segment ID: ${parsed.segmentId}`);
  }

  const boundariesById = new Map(tokenBoundaries.map((boundary) => [boundary.tokenId, boundary]));
  const tokenIds = new Set<string>();
  const aligned: TokenAnalysis[] = [];
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
      token.startOffset === boundary.startOffset
      && token.endOffset === boundary.endOffset
      && token.surface === boundary.surface
    ) {
      aligned.push(token);
      continue;
    }
    // QUAL-001 对齐修复之一：tokenId 匹配但 surface/offset 抄错 → 以本地边界回填。
    // 本地分词是唯一权威、模型只负责填空；抄写偏差不值得让整段失败重试。
    aligned.push({
      ...token,
      startOffset: boundary.startOffset,
      endOffset: boundary.endOffset,
      surface: boundary.surface
    });
  }

  // QUAL-001 对齐修复之二：模型漏答个别 token → 补「未提供」占位（仅补不丢）。
  // 占位省略全部解释字段（与瘦身存储同款、不落库恒定 null），confidence 为 null；
  // UI 显示为无解释的普通词——好过同段其余正确字段一起作废、再花一轮请求重试整段。
  const missingPlaceholders: TokenAnalysis[] = tokenBoundaries
    .filter((boundary) => !tokenIds.has(boundary.tokenId))
    .map((boundary) => ({
      tokenId: boundary.tokenId,
      startOffset: boundary.startOffset,
      endOffset: boundary.endOffset,
      surface: boundary.surface,
      // 占位无词性信息，用最常见的 word 兜底；解释字段整体省略（瘦身存储同款，不落恒定 null）
      category: "word",
      confidence: null
    }));
  if (missingPlaceholders.length > 0) {
    aligned.push(...missingPlaceholders);
  }

  return { ...parsed, tokens: aligned };
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
  segment: Pick<Segment, "id">,
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
  /** 每个文档的分析事件订阅者（SSE 连接；同一文档允许多个标签页同时订阅）。 */
  private readonly streamListeners = new Map<string, Set<(event: AnalysisStreamEvent) => void>>();

  /**
   * 订阅某文档的分析事件，返回退订函数。
   * 监听器抛异常由 emitStreamEvent 兜住——单个 SSE 连接的写失败不能拖垮分析主流程。
   */
  public subscribe(
    documentId: string,
    listener: (event: AnalysisStreamEvent) => void
  ): () => void {
    const set = this.streamListeners.get(documentId) ?? new Set();
    set.add(listener);
    this.streamListeners.set(documentId, set);
    return () => {
      const current = this.streamListeners.get(documentId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.streamListeners.delete(documentId);
      }
    };
  }

  private emitStreamEvent(event: AnalysisStreamEvent): void {
    for (const listener of this.streamListeners.get(event.documentId) ?? []) {
      try {
        listener(event);
      } catch {
        // 单个 SSE 连接写失败（客户端已关闭等）不影响分析与其余订阅者
      }
    }
  }

  /** 向订阅方推一次当前进度快照（订阅建立时立即调用；断线重连后也靠它对齐）。 */
  public emitProgress(documentId: string): void {
    const progress = this.getProgress(documentId);
    if (progress) {
      this.emitStreamEvent({ type: "progress", documentId, progress });
    }
  }

  public constructor(
    private readonly repository: DocumentRepository,
    /**
     * 可变 provider 容器（设计文档 llm-settings-design.md §4）：
     * 设置页保存后热切换 provider，这里每次分析批次开始取 current，
     * 进行中的批次在下一个 batch 循环自然读到新 provider。
     */
    private readonly providerHolder: { current: LlmProvider },
    /**
     * 内容词词典层容器（设计文档 jmdict-integration-design.md）：
     * 镜像 providerHolder，设置页后续热切换。默认 none（不加载索引），
     * 行为与接入前完全一致（AC-01）。
     */
    private readonly contentDictionaryHolder: ContentDictionaryHolder,
    /**
     * 译中器（阶段 B）：内容词英文释义 → 中文，仅本地 Ollama，零云端成本。
     * 仅在真实分析路径（startDictionaryOnly / processBatch）注入；
     * 预览/估算路径不传，避免每个预览都烧本地推理。
     * Ollama 未启动或翻译失败时调用方回退英文（不阻断分析，AC-05/AC-06 精神）。
     */
    private readonly glossTranslator: GlossTranslator,
    private readonly promptVersion: string,
    private readonly batchSize = 3,
    private readonly batchConcurrency = 2,
    /**
     * 段级语义字段档位默认值（config.LLM_SEGMENT_FIELDS）。
     * 工具页请求显式传档位时覆盖它；预览估算与实际分析必须用同一档位。
     * 设置页保存档位后经 updateSegmentFields 热更新。
     */
    private defaultSegmentFields: SegmentFieldProfile = "standard"
  ) {}

  /** 设置页保存档位后调用：立即作用于后续分析（LLM-011 不回溯历史）。 */
  public updateSegmentFields(profile: SegmentFieldProfile): void {
    this.defaultSegmentFields = profile;
  }

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
        completion: Promise.resolve(),
        startedAt: Date.now(),
        firstSegmentAt: null
      };
      this.activeRuns.set(documentId, run);
      // OBS：分析起点。事件只含 id 与时间，不含文章内容（PRIV-004）。
      observability.write({ event: "analyze_start", documentId });
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
      const { localTokens } = await prepareSegmentTokens(
        segment,
        boundaries,
        this.contentDictionaryHolder.current,
        this.glossTranslator
      );
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
      const stats = await countSegmentTokens(
        document.segments,
        this.contentDictionaryHolder.current
      );
      const estimate = estimateAnalysisTokens(document.segments.length, stats.unmissedTokens, segmentFields);
      const estimatedCost = estimatePreviewCost(this.providerHolder.current.model, estimate);
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
      this.providerHolder.current.model,
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
        configured: this.providerHolder.current.configured,
        model: this.providerHolder.current.model,
        // Ollama 等本地模型无 API 费用，前端据此显示「本地免费」而非「价格未知」
        isLocal: this.providerHolder.current.name === "ollama"
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
      const { localTokens, llmBoundaries } = await prepareSegmentTokens(
        segment,
        boundaries,
        this.contentDictionaryHolder.current,
        this.glossTranslator
      );
      return { segment, boundaries, localTokens, llmBoundaries };
    }));

    let result: LlmAnalysisResult;
    // 本地模型（Ollama/qwen3.5 等）偶发整批 JSON 语法错误（字符串内引号混用等，
    // 2026-08-30 实测约 1/3 批次首跑失败），云端偶发批次级错误同样存在。
    // 免费/低成本场景自动重试一次（最多 2 次尝试），仍失败才落 failed，
    // 避免用户为一次偶发错误手动重跑整篇。重试只针对 provider 抛异常（整批无效），
    // 逐段的 schema 校验失败不在此列（那是模型对单段的系统性偏差，重试无益）。
    for (let attempt = 0; ; attempt += 1) {
      try {
        result = await this.providerHolder.current.analyze({
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
        break;
      } catch (reason: unknown) {
        if (!this.isCurrent(documentId, run) || attempt >= 1) {
          if (!this.isCurrent(documentId, run)) {
            return;
          }
          const message = errorMessage(reason);
          for (const segment of batch) {
            this.repository.markSegmentFailed(segment.id, message);
            this.emitStreamEvent({
              type: "segment-failed",
              documentId,
              segmentId: segment.id,
              message
            });
          }
          return;
        }
        // 短暂等待后重试一次（本地模型刚崩完一个请求，立即重试命中率更高）
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
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
          this.providerHolder.current.name,
          this.providerHolder.current.model,
          this.promptVersion,
          result.usage
        );
        // 段落完成即推送：前端立刻把这一段的分析内容上屏（不必等同批其它段或整篇）
        this.emitStreamEvent({
          type: "segment",
          documentId,
          segmentId: segment.id,
          analysis: merged
        });
        // OBS：首段反馈时间（STREAM-005 的度量）——只记首个，后续段落不再重复
        if (run.firstSegmentAt === null) {
          run.firstSegmentAt = Date.now();
          observability.write({
            event: "analyze_first_segment",
            documentId,
            firstSegmentMs: run.firstSegmentAt - run.startedAt
          });
        }
      } catch (reason: unknown) {
        const failureMessage = errorMessage(reason);
        this.repository.markSegmentFailed(segment.id, failureMessage);
        this.emitStreamEvent({
          type: "segment-failed",
          documentId,
          segmentId: segment.id,
          message: failureMessage
        });
      }
    }
  }

  private async process(
    documentId: string,
    run: ActiveRun,
    segmentFields: SegmentFieldProfile
  ): Promise<void> {
    // 终态判定（OBS-001）：默认 cancelled——被取消或被新 run 取代时静默走到 finally。
    let outcome: "success" | "error" | "cancelled" = "cancelled";
    let failureMessage: string | null = null;
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
        // provider 取一次存局部变量：打包期间若设置页热切换了 provider，
        // 预算与估算模型必须来自同一个实例，否则会算出矛盾的分批。
        const provider = this.providerHolder.current;
        const tokenBudget = Math.floor(provider.completionTokenBudget * packingSafetyRatio);
        const batches = planBatches(queued, this.batchSize, tokenBudget, provider.outputTokenModel)
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
        this.emitProgress(documentId);
        this.emitStreamEvent({ type: "done", documentId });
        outcome = "success";
      }
    } catch (reason: unknown) {
      if (this.isCurrent(documentId, run)) {
        failureMessage = errorMessage(reason);
        this.repository.markDocumentAnalysisFailed(documentId, failureMessage);
        this.emitProgress(documentId);
        this.emitStreamEvent({ type: "done", documentId });
        outcome = "error";
      }
    } finally {
      if (this.activeRuns.get(documentId)?.id === run.id) {
        this.activeRuns.delete(documentId);
      }
      // OBS-001：每次分析恰好一个终态事件（成功/失败/取消都走到这里）
      this.writeFinishEvent(documentId, run, outcome, failureMessage);
    }
  }

  /**
   * 写分析终态事件（OBS-001/OBS-002）。
   * 进度里的 usage/cost 是聚合数值，事件不含原文与译文（PRIV-004）。
   */
  private writeFinishEvent(
    documentId: string,
    run: ActiveRun,
    outcome: "success" | "error" | "cancelled",
    failureMessage: string | null
  ): void {
    if (!observability.enabled) {
      return;
    }
    const progress = this.getProgress(documentId);
    observability.write({
      event: "analyze_finish",
      documentId,
      outcome,
      durationMs: Date.now() - run.startedAt,
      firstSegmentMs: run.firstSegmentAt === null ? null : run.firstSegmentAt - run.startedAt,
      segments: progress
        ? {
            total: progress.totalSegments,
            completed: progress.completedSegments,
            failed: progress.failedSegments
          }
        : null,
      usage: progress?.usage ?? null,
      cost: progress?.cost ?? null,
      errorCategory:
        outcome === "error" && failureMessage !== null ? classifyError(failureMessage) : undefined
    });
  }
}
