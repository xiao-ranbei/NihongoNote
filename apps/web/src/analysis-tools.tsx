import {
  useEffect,
  useRef,
  useState,
  type ReactElement
} from "react";

import type {
  AnalysisMode,
  AnalysisPreview,
  AnalysisProgress,
  DocumentSummary
} from "@nihongonote/core";

import {
  getAnalysisProgress,
  listDocuments,
  previewAnalysis,
  startBatchAnalysis
} from "./api/client";

/**
 * 分析工具页（设计文档 3.5/§六-4，落实 LLM-011/LLM-013）。
 *
 * 职责：只做「选文章 → 预览 → 确认 → 看进度」单一动作。
 * - 多选文章批量分析；
 * - 「完整分析」：词典命中本地解释 + 未命中走 AI（成本确认弹窗后才发请求）；
 * - 「仅词典分析」：零费用、不调用 LLM；
 * - 预览为纯本地统计（词典覆盖 / 预计 token / 闲时与高峰费用 / 时长），不产生任何费用。
 */

const modeOptions: Array<{ value: AnalysisMode; label: string; description: string }> = [
  {
    value: "full",
    label: "完整分析",
    description: "词典命中的词本地直接解释；未命中的词与句段语义走 AI，按量计费。"
  },
  {
    value: "dictionary-only",
    label: "仅词典分析",
    description: "只解释固定用法库命中的助词与功能词；零费用，不调用 AI。"
  }
];

function statusLabel(status: DocumentSummary["status"]): string {
  switch (status) {
    case "draft":
      return "待分析";
    case "analyzing":
      return "分析中";
    case "ready":
      return "已完成";
    case "failed":
      return "有失败";
  }
}

/** 金额很小（一次分析通常不足 1 元），小额显示 4 位小数，大额显示 2 位。 */
function formatCost(cost: number): string {
  return cost >= 1 ? `¥${cost.toFixed(2)}` : `¥${cost.toFixed(4)}`;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `约 ${seconds} 秒`;
  }
  const minutes = Math.round(seconds / 60);
  return `约 ${minutes} 分钟`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

interface ProgressRow {
  progress: AnalysisProgress | null;
  isRunning: boolean;
}

export function AnalysisTools(): ReactElement {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<AnalysisMode>("full");
  const [preview, setPreview] = useState<AnalysisPreview | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [progressById, setProgressById] = useState<Map<string, ProgressRow>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const progressRef = useRef(progressById);
  progressRef.current = progressById;

  useEffect(() => {
    let cancelled = false;
    void listDocuments()
      .then((items) => {
        if (!cancelled) {
          setDocuments(items);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "读取文章列表失败");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refreshLibrary(): Promise<void> {
    const items = await listDocuments();
    setDocuments(items);
  }

  function toggleDocument(documentId: string): void {
    const next = new Set(selectedIds);
    if (next.has(documentId)) {
      next.delete(documentId);
    } else {
      next.add(documentId);
    }
    setSelectedIds(next);
    // 选择变化后，旧的预览不再准确
    setPreview(null);
  }

  function toggleAll(): void {
    if (selectedIds.size === documents.length && documents.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(documents.map((document) => document.id)));
    }
    setPreview(null);
  }

  async function handlePreview(): Promise<void> {
    if (selectedIds.size === 0) {
      setError("请先选择至少一篇文章");
      return;
    }
    setIsPreviewLoading(true);
    setError(null);
    try {
      setPreview(await previewAnalysis([...selectedIds]));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "预览失败");
    } finally {
      setIsPreviewLoading(false);
    }
  }

  async function handleRunBatch(): Promise<void> {
    setIsStarting(true);
    setError(null);
    try {
      const response = await startBatchAnalysis([...selectedIds], mode);
      const next = new Map(progressById);
      for (const progress of response.started) {
        next.set(progress.documentId, {
          progress,
          isRunning: progress.status === "analyzing"
        });
      }
      for (const skipped of response.skipped) {
        next.set(skipped.documentId, { progress: null, isRunning: false });
      }
      setProgressById(next);
      void refreshLibrary().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "刷新文章列表失败");
      });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "启动分析失败");
    } finally {
      setIsStarting(false);
    }
  }

  // 进度轮询：只依赖 running 数量（0 ↔ N 变化时重建），内部用 ref 读最新进度
  const runningCount = [...progressById.values()].filter((row) => row.isRunning).length;
  useEffect(() => {
    if (runningCount === 0) {
      return;
    }
    let cancelled = false;
    const poll = async (): Promise<void> => {
      const entries = await Promise.all(
        [...progressRef.current.keys()].map(async (documentId): Promise<{
          documentId: string;
          row: ProgressRow | undefined;
        }> => {
          const current = progressRef.current.get(documentId);
          if (current && current.isRunning) {
            try {
              const progress = await getAnalysisProgress(documentId);
              return {
                documentId,
                row: { progress, isRunning: progress.status === "analyzing" }
              };
            } catch {
              // 单篇轮询失败保留原值，不弹错
              return { documentId, row: current };
            }
          }
          return { documentId, row: current };
        })
      );
      if (cancelled) {
        return;
      }
      const next = new Map<string, ProgressRow>();
      for (const entry of entries) {
        if (entry.row) {
          next.set(entry.documentId, entry.row);
        }
      }
      setProgressById(next);
      const anyRunning = [...next.values()].some((row) => row.isRunning);
      if (!anyRunning) {
        void refreshLibrary().catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : "刷新文章列表失败");
        });
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runningCount]);

  const selectedDocuments = documents.filter((document) => selectedIds.has(document.id));
  const canStartFull = preview?.provider.configured ?? false;
  const hasSelection = selectedIds.size > 0;
  const totals = preview?.totals ?? null;
  const estimatedSeconds = totals ? Math.ceil(totals.estimatedOutputTokens / 40) : 0;

  return (
    <section className="tools-page">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">ANALYSIS TOOL</p>
          <h2>分析工具</h2>
        </div>
        <span className="foundation-badge">按需付费</span>
      </div>
      <p className="reader-note">
        选好文章后先预览策略与费用，确认后才发起 AI 请求；「仅词典分析」不调用 AI、零费用。
      </p>

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="tools-section">
        <div className="tools-section-heading">
          <h3>1. 选择文章（可多选）</h3>
          {documents.length > 0 ? (
            <button className="text-button" onClick={toggleAll} type="button">
              {selectedIds.size === documents.length ? "取消全选" : "全选"}
            </button>
          ) : null}
        </div>
        {isLoading ? (
          <p className="empty-copy">正在读取文章列表…</p>
        ) : documents.length === 0 ? (
          <p className="empty-copy">还没有文章。先到阅读页添加学习材料，再回到这里批量分析。</p>
        ) : (
          <div className="tools-document-list">
            {documents.map((document) => {
              const progressRow = progressById.get(document.id);
              return (
                <label
                  className={`tools-document-item ${
                    selectedIds.has(document.id) ? "is-selected" : ""
                  }`}
                  key={document.id}
                >
                  <input
                    checked={selectedIds.has(document.id)}
                    onChange={() => toggleDocument(document.id)}
                    type="checkbox"
                  />
                  <span className="tools-document-main">
                    <strong>{document.title}</strong>
                    <span>
                      {statusLabel(document.status)} · {document.segmentCount} 个句段 ·{" "}
                      {formatDate(document.updatedAt)}
                    </span>
                  </span>
                  {progressRow?.isRunning ? (
                    <span className="tools-progress-badge">
                      {progressRow.progress
                        ? `${progressRow.progress.completedSegments}/${progressRow.progress.totalSegments}`
                        : "分析中"}
                    </span>
                  ) : progressRow?.progress ? (
                    <span className="tools-progress-badge is-done">
                      {progressRow.progress.status === "failed" ? "有失败" : "已完成"}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        )}
      </div>

      <div className="tools-section">
        <h3>2. 分析模式</h3>
        <div className="tools-mode-options">
          {modeOptions.map((option) => (
            <label
              className={`tools-mode-option ${mode === option.value ? "is-selected" : ""}`}
              key={option.value}
            >
              <input
                checked={mode === option.value}
                name="analysis-mode"
                onChange={() => setMode(option.value)}
                type="radio"
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="tools-section">
        <div className="tools-section-heading">
          <h3>3. 策略与费用预览</h3>
          <button
            className="secondary-button"
            disabled={!hasSelection || isPreviewLoading}
            onClick={() => void handlePreview()}
            type="button"
          >
            {isPreviewLoading ? "统计中…" : "预览策略与费用"}
          </button>
        </div>

        {preview ? (
          <div className="tools-preview">
            <div className="tools-preview-stats">
              <div className="tools-stat">
                <span>词典覆盖</span>
                <strong>
                  {totals?.matchedTokens.toLocaleString()} / {totals?.totalTokens.toLocaleString()} token
                </strong>
                <small>{formatPercent(totals?.dictionaryCoverage ?? 0)} 的词无需 AI</small>
              </div>
              <div className="tools-stat">
                <span>预计 tokens</span>
                <strong>{formatTokens(totals?.estimatedTotalTokens ?? 0)}</strong>
                <small>
                  输入 {formatTokens(totals?.estimatedInputTokens ?? 0)} · 输出{" "}
                  {formatTokens(totals?.estimatedOutputTokens ?? 0)}
                </small>
              </div>
              <div className="tools-stat">
                <span>预计费用</span>
                <strong>
                  {totals?.estimatedCost
                    ? `${formatCost(totals.estimatedCost.offPeak ?? 0)} / ${formatCost(
                        totals.estimatedCost.peak ?? 0
                      )}`
                    : "价格未知"}
                </strong>
                <small>闲时 / 高峰两档单价估算</small>
              </div>
              <div className="tools-stat">
                <span>预计时长</span>
                <strong>{formatDuration(estimatedSeconds)}</strong>
                <small>按 minimal 推理档粗略估算</small>
              </div>
            </div>

            <div className="tools-preview-detail">
              <p>
                共 {selectedDocuments.length} 篇文章 · {totals?.segmentCount ?? 0} 个句段 ·
                词典库版本 v{preview.dictionaryVersion}（助词 {preview.dictionaryStats.particles} ·
                功能词 {preview.dictionaryStats.functional} · 句末模板{" "}
                {preview.dictionaryStats.endings}）
              </p>
              {mode === "dictionary-only" ? (
                <p className="tools-note-green">
                  仅词典分析：只落库词典命中的解释，零费用、不调用 AI。
                </p>
              ) : !preview.provider.configured ? (
                <p className="tools-note-warning">
                  尚未配置 LLM（apps/api/.env 缺 LLM_PROVIDER / LLM_API_KEY）。
                  完整分析不可用，可改用「仅词典分析」。
                </p>
              ) : null}
            </div>
          </div>
        ) : hasSelection ? (
          <p className="empty-copy">点击「预览策略与费用」，查看词典覆盖率与预计花费（纯本地统计，不产生费用）。</p>
        ) : (
          <p className="empty-copy">先选择至少一篇文章。</p>
        )}
      </div>

      <div className="tools-section">
        <h3>4. 开始分析</h3>
        <div className="tools-start-row">
          {mode === "full" ? (
            <button
              className="primary-button"
              disabled={!hasSelection || isStarting || !canStartFull}
              onClick={() => setIsConfirmOpen(true)}
              type="button"
            >
              {isStarting ? "启动中…" : "开始 AI 分析"}
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={!hasSelection || isStarting}
              onClick={() => void handleRunBatch()}
              type="button"
            >
              {isStarting ? "处理中…" : "开始仅词典分析"}
            </button>
          )}
          {mode === "full" && !canStartFull ? (
            <span className="field-note">未配置 LLM，无法发起 AI 分析。</span>
          ) : (
            <span className="field-note">
              {mode === "full"
                ? "点击后弹出成本确认（预计 token / 费用 / 时长 / 词典覆盖），确认才发请求。"
                : "仅词典分析零费用，确认后立即处理。"}
            </span>
          )}
        </div>
      </div>

      {progressById.size > 0 ? (
        <div className="tools-section">
          <h3>5. 进度</h3>
          <div className="tools-progress-list">
            {[...progressById.entries()].map(([documentId, row]) => {
              const document = documents.find((item) => item.id === documentId);
              const progress = row.progress;
              return (
                <div className="tools-progress-row" key={documentId}>
                  <span className="tools-progress-title">{document?.title ?? "已删除文章"}</span>
                  {progress ? (
                    <>
                      <span className={`tools-progress-status status-${progress.status}`}>
                        {statusLabel(progress.status)}
                      </span>
                      <div className="progress-track tools-progress-track">
                        <span
                          style={{
                            width: progress.totalSegments === 0
                              ? "0%"
                              : `${(progress.completedSegments / progress.totalSegments) * 100}%`
                          }}
                        />
                      </div>
                      <span className="tools-progress-count">
                        {progress.completedSegments} / {progress.totalSegments}
                      </span>
                      {progress.cost ? (
                        <span className="tools-progress-cost">{formatCost(progress.cost.totalCost)}</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="tools-progress-status status-failed">未找到</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {isConfirmOpen ? (
        <div
          aria-label="成本确认"
          aria-modal="true"
          className="confirm-overlay"
          role="dialog"
          onClick={() => setIsConfirmOpen(false)}
        >
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="analysis-panel-heading">
              <div>
                <p className="section-kicker">COST CONFIRM</p>
                <h3>确认发起 AI 分析？</h3>
              </div>
              <button
                aria-label="关闭"
                className="icon-button"
                onClick={() => setIsConfirmOpen(false)}
                type="button"
              >
                ×
              </button>
            </div>
            <dl className="confirm-facts">
              <div>
                <dt>文章</dt>
                <dd>
                  {selectedDocuments.length} 篇（{selectedDocuments.map((item) => item.title).join("、")}）
                </dd>
              </div>
              <div>
                <dt>预计 tokens</dt>
                <dd>
                  {formatTokens(totals?.estimatedTotalTokens ?? 0)}（输入{" "}
                  {formatTokens(totals?.estimatedInputTokens ?? 0)} · 输出{" "}
                  {formatTokens(totals?.estimatedOutputTokens ?? 0)}）
                </dd>
              </div>
              <div>
                <dt>预计费用</dt>
                <dd>
                  {totals?.estimatedCost
                    ? `闲时 ${formatCost(totals.estimatedCost.offPeak ?? 0)} / 高峰 ${formatCost(
                        totals.estimatedCost.peak ?? 0
                      )}`
                    : "该模型暂无内置价格表（费用未知）"}
                </dd>
              </div>
              <div>
                <dt>预计时长</dt>
                <dd>{formatDuration(estimatedSeconds)}</dd>
              </div>
              <div>
                <dt>词典覆盖</dt>
                <dd>
                  {totals?.matchedTokens.toLocaleString()} / {totals?.totalTokens.toLocaleString()} token（
                  {formatPercent(totals?.dictionaryCoverage ?? 0)} 无需 AI）
                </dd>
              </div>
            </dl>
            <p className="confirm-note">
              确认后才会发起 AI 请求（LLM-011）。本次按当前模型与档位估算，实际以用量为准。
            </p>
            <div className="metadata-editor-actions">
              <button className="text-button" onClick={() => setIsConfirmOpen(false)} type="button">
                取消
              </button>
              <button
                className="primary-button"
                disabled={isStarting}
                onClick={() => void handleRunBatch()}
                type="button"
              >
                {isStarting ? "启动中…" : "确认，开始分析"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
