import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import type {
  AnalysisProgress,
  ContentType,
  SegmentAnalysis,
  TargetLevel,
  TokenAnalysis,
  TokenAnalysisOverride
} from "@nihongonote/core";

import {
  cancelDocumentAnalysis,
  getAnalysisProgress,
  getDocument,
  retrySegment,
  startDocumentAnalysis,
  subscribeAnalysisEvents,
  updateDocument,
  updateSegment,
  updateSegmentAnalysis,
  type SegmentAnalysisUpdateInput
} from "../api/client";
import { documentContentType, exportFormatVersion, type MvpDocument, type Segment } from "../lib/constants";
import { downloadFile, fileStamp, safeFileStem } from "../lib/format";

/**
 * 阅读会话（M1.1 拆出的第 4b 个 hook，也是最后一块）：
 * 当前文档、选中项、编辑保存，以及分析生命周期（含进度轮询）。
 *
 * 为什么文档和分析放在同一个 hook：它们咬合得非常紧——
 * 分析的启动/取消/收尾都要刷新当前文档，进度轮询又挂在「当前文档 id」上。
 * 拆成两个只会制造循环依赖；这里的边界是**对外**清晰：
 * 建文由 useComposer 负责（经 adoptDocument 交进来），学习库刷新走 onLibraryChanged。
 *
 * 轮询细节：800ms 间隔、inFlight 防重入；收尾时（进度不再是 analyzing）并发刷新
 * 当前文档与学习库列表。
 */
export interface ReadingSessionController {
  document: MvpDocument | null;
  progress: AnalysisProgress | null;
  selectedSegmentId: string | null;
  selectedTokenId: string | null;
  selectedSegment: Segment | null;
  selectedToken: TokenAnalysis | null;
  isAnalysisRunning: boolean;
  isStartingAnalysis: boolean;
  isCancelling: boolean;
  isEditingDocument: boolean;
  isSavingDocument: boolean;
  isSavingSegment: boolean;
  retryingSegmentId: string | null;

  /** 从学习库打开一篇文章（并发取文档与进度）。 */
  openDocument: (documentId: string) => Promise<void>;
  /** 建文成功后直接采用已有结果，不再重复请求。 */
  adoptDocument: (document: MvpDocument, progress: AnalysisProgress | null) => void;
  /** 关闭当前文章（回到欢迎页 / 新建）。 */
  closeDocument: () => void;
  selectSegment: (segmentId: string) => void;
  selectToken: (segmentId: string, tokenId: string) => void;
  clearTokenSelection: () => void;
  startAnalysis: () => Promise<void>;
  cancelAnalysis: () => Promise<void>;
  retrySegment: (segmentId: string) => Promise<void>;
  saveDocumentMetadata: (input: DocumentMetadataInput) => Promise<void>;
  saveSegment: (
    segmentId: string,
    speaker: string | null,
    analysis: SegmentAnalysisUpdateInput | null
  ) => Promise<void>;
  saveToken: (segmentId: string, override: TokenAnalysisOverride) => Promise<void>;
  exportSourceText: () => void;
  exportAnalysisJson: () => void;
  setIsEditingDocument: Dispatch<SetStateAction<boolean>>;
}

export interface DocumentMetadataInput {
  title: string;
  contentType: ContentType;
  targetLevel: TargetLevel;
}

export interface UseReadingSessionOptions {
  /** 错误上报；传 null 表示清空旧横幅。 */
  onError: (message: string | null) => void;
  /** 学习库列表需要刷新时调用（返回 Promise 以便与文档刷新并发）。 */
  onLibraryChanged: () => Promise<void>;
  /** 文档元数据变化后同步到 App 侧（composer 的类型/等级选择随之更新）。 */
  onDocumentMetadataChanged: (contentType: ContentType, targetLevel: TargetLevel) => void;
}

/**
 * 把某个段落完成的分析合并进当前文档。
 * 用 map 保持其余段落的引用不变，把重渲染范围限制在被更新的那一段。
 */
function mergeSegmentAnalysis(
  current: MvpDocument | null,
  segmentId: string,
  analysis: SegmentAnalysis
): MvpDocument | null {
  if (!current) {
    return current;
  }
  return {
    ...current,
    segments: current.segments.map((segment) =>
      segment.id === segmentId ? { ...segment, status: "completed", analysis } : segment
    )
  };
}

function mergeSegmentFailure(
  current: MvpDocument | null,
  segmentId: string,
  message: string
): MvpDocument | null {
  if (!current) {
    return current;
  }
  return {
    ...current,
    segments: current.segments.map((segment) =>
      segment.id === segmentId ? { ...segment, status: "failed", errorMessage: message } : segment
    )
  };
}

export function useReadingSession(options: UseReadingSessionOptions): ReadingSessionController {
  const [document, setDocument] = useState<MvpDocument | null>(null);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [isStartingAnalysis, setIsStartingAnalysis] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isEditingDocument, setIsEditingDocument] = useState(false);
  const [isSavingDocument, setIsSavingDocument] = useState(false);
  const [isSavingSegment, setIsSavingSegment] = useState(false);
  const [retryingSegmentId, setRetryingSegmentId] = useState<string | null>(null);

  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const onLibraryChangedRef = useRef(options.onLibraryChanged);
  onLibraryChangedRef.current = options.onLibraryChanged;
  const onMetadataChangedRef = useRef(options.onDocumentMetadataChanged);
  onMetadataChangedRef.current = options.onDocumentMetadataChanged;

  // 分析进行中 → 订阅 SSE 段级事件（M1.2，替代轮询）：
  // - segment 事件：该段已完成校验并落库，立即合并进当前文档让内容上屏（STREAM-001/002）；
  // - progress 事件：订阅建立与断线重连时都会先收到快照，替代轮询的状态对齐（STREAM-004）；
  // - done 事件：分析收尾（成功/取消/失败），刷新文档与学习库。
  // EventSource 自带断线重连；本 effect 的启停只由「文档 + 是否 analyzing」驱动。
  useEffect(() => {
    const documentId = document?.id;
    if (!documentId || progress?.status !== "analyzing") {
      return;
    }

    const unsubscribe = subscribeAnalysisEvents(documentId, (event) => {
      switch (event.type) {
        case "progress": {
          setProgress(event.progress);
          break;
        }
        case "segment": {
          setDocument((current) => mergeSegmentAnalysis(current, event.segmentId, event.analysis));
          break;
        }
        case "segment-failed": {
          setDocument((current) =>
            mergeSegmentFailure(current, event.segmentId, event.message)
          );
          break;
        }
        case "done": {
          void (async () => {
            try {
              const [fresh] = await Promise.all([
                getDocument(documentId),
                onLibraryChangedRef.current()
              ]);
              setDocument(fresh);
            } catch (reason: unknown) {
              onErrorRef.current(
                reason instanceof Error ? reason.message : "读取分析进度失败"
              );
            }
          })();
          break;
        }
      }
    });

    return unsubscribe;
  }, [progress?.status, document?.id]);

  const openDocument = async (documentId: string): Promise<void> => {
    onErrorRef.current(null);
    try {
      const [loaded, initialProgress] = await Promise.all([
        getDocument(documentId),
        getAnalysisProgress(documentId)
      ]);
      setDocument(loaded);
      setSelectedSegmentId(loaded.segments[0]?.id ?? null);
      setSelectedTokenId(null);
      onMetadataChangedRef.current(documentContentType(loaded), loaded.targetLevel);
      setProgress(initialProgress);
    } catch (reason: unknown) {
      onErrorRef.current(reason instanceof Error ? reason.message : "读取文章失败");
    }
  };

  const adoptDocument = (fresh: MvpDocument, initialProgress: AnalysisProgress | null): void => {
    setDocument(fresh);
    setSelectedSegmentId(fresh.segments[0]?.id ?? null);
    setSelectedTokenId(null);
    setProgress(initialProgress);
  };

  const closeDocument = (): void => {
    setDocument(null);
    setIsEditingDocument(false);
    setSelectedSegmentId(null);
    setSelectedTokenId(null);
    setProgress(null);
  };

  const selectSegment = (segmentId: string): void => {
    setSelectedSegmentId(segmentId);
    setSelectedTokenId(null);
  };

  const selectToken = (segmentId: string, tokenId: string): void => {
    setSelectedSegmentId(segmentId);
    setSelectedTokenId(tokenId);
  };

  const startAnalysis = async (): Promise<void> => {
    if (!document) {
      return;
    }
    setIsStartingAnalysis(true);
    onErrorRef.current(null);
    try {
      setProgress(await startDocumentAnalysis(document.id));
    } catch (reason: unknown) {
      onErrorRef.current(reason instanceof Error ? reason.message : "启动分析失败");
    } finally {
      setIsStartingAnalysis(false);
    }
  };

  const cancelAnalysis = async (): Promise<void> => {
    if (!document) {
      return;
    }
    setIsCancelling(true);
    onErrorRef.current(null);
    try {
      const latest = await cancelDocumentAnalysis(document.id);
      const [freshDocument] = await Promise.all([
        getDocument(document.id),
        onLibraryChangedRef.current()
      ]);
      setProgress(latest);
      setDocument(freshDocument);
    } catch (reason: unknown) {
      onErrorRef.current(reason instanceof Error ? reason.message : "取消分析失败");
    } finally {
      setIsCancelling(false);
    }
  };

  const retry = async (segmentId: string): Promise<void> => {
    setRetryingSegmentId(segmentId);
    onErrorRef.current(null);
    try {
      setProgress(await retrySegment(segmentId));
    } catch (reason: unknown) {
      onErrorRef.current(reason instanceof Error ? reason.message : "重试句段失败");
    } finally {
      setRetryingSegmentId(null);
    }
  };

  const saveDocumentMetadata = async (input: DocumentMetadataInput): Promise<void> => {
    if (!document) {
      return;
    }
    setIsSavingDocument(true);
    onErrorRef.current(null);
    try {
      const fresh = await updateDocument(document.id, input);
      setDocument(fresh);
      onMetadataChangedRef.current(fresh.contentType, fresh.targetLevel);
      setIsEditingDocument(false);
      void onLibraryChangedRef.current().catch((reason: unknown) => {
        onErrorRef.current(reason instanceof Error ? reason.message : "刷新学习库失败");
      });
    } catch (reason: unknown) {
      onErrorRef.current(reason instanceof Error ? reason.message : "保存文章设置失败");
    } finally {
      setIsSavingDocument(false);
    }
  };

  const saveSegment = async (
    segmentId: string,
    speaker: string | null,
    analysis: SegmentAnalysisUpdateInput | null
  ): Promise<void> => {
    setIsSavingSegment(true);
    onErrorRef.current(null);
    try {
      const updatedSegment = await updateSegment(segmentId, { speaker });
      let fresh = await getDocument(updatedSegment.documentId);
      if (analysis) {
        await updateSegmentAnalysis(segmentId, analysis);
        fresh = await getDocument(fresh.id);
      }
      setDocument(fresh);
      void onLibraryChangedRef.current().catch((reason: unknown) => {
        onErrorRef.current(reason instanceof Error ? reason.message : "刷新学习库失败");
      });
    } catch (reason: unknown) {
      onErrorRef.current(reason instanceof Error ? reason.message : "保存句段修改失败");
    } finally {
      setIsSavingSegment(false);
    }
  };

  const saveToken = async (segmentId: string, override: TokenAnalysisOverride): Promise<void> => {
    setIsSavingSegment(true);
    onErrorRef.current(null);
    try {
      const segment = await updateSegmentAnalysis(segmentId, { tokens: [override] });
      const fresh = await getDocument(segment.documentId);
      setDocument(fresh);
      void onLibraryChangedRef.current().catch((reason: unknown) => {
        onErrorRef.current(reason instanceof Error ? reason.message : "刷新学习库失败");
      });
    } catch (reason: unknown) {
      onErrorRef.current(reason instanceof Error ? reason.message : "保存词语修改失败");
    } finally {
      setIsSavingSegment(false);
    }
  };

  const exportSourceText = (): void => {
    if (!document) {
      return;
    }
    const stem = safeFileStem(document.title);
    downloadFile(`${stem}-原文-${fileStamp()}.txt`, document.sourceText, "text/plain");
  };

  /*
   * 导出解析 JSON（需求 5.5 / issues I-27）。
   * DocumentDetail 已含 sourceText / contentBlocks / segments（含 AI 解析与人工修正版本），
   * 因此纯前端即可完成，无需新增后端端点。
   */
  const exportAnalysisJson = (): void => {
    if (!document) {
      return;
    }
    const stem = safeFileStem(document.title);
    const payload = {
      format: "nihongonote-document",
      formatVersion: exportFormatVersion,
      exportedAt: new Date().toISOString(),
      document
    };
    downloadFile(
      `${stem}-解析-${fileStamp()}.json`,
      JSON.stringify(payload, null, 2),
      "application/json"
    );
  };

  const selectedSegment = document?.segments.find((item) => item.id === selectedSegmentId) ?? null;
  const selectedToken =
    selectedSegment?.analysis?.tokens.find((token) => token.tokenId === selectedTokenId) ?? null;
  const isAnalysisRunning = progress?.status === "analyzing" || document?.status === "analyzing";

  return {
    document,
    progress,
    selectedSegmentId,
    selectedTokenId,
    selectedSegment,
    selectedToken,
    isAnalysisRunning,
    isStartingAnalysis,
    isCancelling,
    isEditingDocument,
    isSavingDocument,
    isSavingSegment,
    retryingSegmentId,
    openDocument,
    adoptDocument,
    closeDocument,
    selectSegment,
    selectToken,
    clearTokenSelection: () => setSelectedTokenId(null),
    startAnalysis,
    cancelAnalysis,
    retrySegment: retry,
    saveDocumentMetadata,
    saveSegment,
    saveToken,
    exportSourceText,
    exportAnalysisJson,
    setIsEditingDocument
  };
}
