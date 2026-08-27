import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import type {
  AnalysisProgress,
  DocumentDetail,
  DocumentSummary,
  HealthResponse,
  TargetLevel
} from "@nihongonote/core";

import {
  createDocument,
  getAnalysisProgress,
  getDocument,
  getHealth,
  listDocuments,
  retrySegment,
  startDocumentAnalysis
} from "./api/client";
import "./styles.css";

const levelOptions: Array<{ value: TargetLevel; label: string }> = [
  { value: "auto", label: "自动判断" },
  { value: "n5", label: "N5" },
  { value: "n4", label: "N4" },
  { value: "n3", label: "N3" },
  { value: "n2", label: "N2" },
  { value: "n1", label: "N1" }
];

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function statusLabel(status: DocumentDetail["status"] | DocumentDetail["segments"][number]["status"]): string {
  switch (status) {
    case "draft":
      return "待分析";
    case "analyzing":
      return "分析中";
    case "ready":
      return "已完成";
    case "failed":
      return "有失败";
    case "queued":
      return "等待中";
    case "processing":
      return "处理中";
    case "completed":
      return "已完成";
  }
}

export default function App(): ReactElement {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<DocumentDetail | null>(null);
  const [title, setTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [targetLevel, setTargetLevel] = useState<TargetLevel>("auto");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingAnalysis, setIsStartingAnalysis] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [retryingSegmentId, setRetryingSegmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([getHealth(), listDocuments()])
      .then(([healthResponse, documentList]) => {
        setHealth(healthResponse);
        setDocuments(documentList);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "无法连接到本机 API");
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  useEffect(() => {
    const documentId = selectedDocument?.id;
    if (!documentId || analysisProgress?.status !== "analyzing") {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const poll = async (): Promise<void> => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const progress = await getAnalysisProgress(documentId);
        if (cancelled) {
          return;
        }
        setAnalysisProgress(progress);
        if (progress.status !== "analyzing") {
          const [document, documentList] = await Promise.all([
            getDocument(documentId),
            listDocuments()
          ]);
          if (!cancelled) {
            setSelectedDocument(document);
            setDocuments(documentList);
          }
        }
      } catch (reason: unknown) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "读取分析进度失败");
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => {
      void poll();
    }, 800);
    void poll();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [analysisProgress?.status, selectedDocument?.id]);

  async function handleCreateDocument(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!sourceText.trim()) {
      setError("请先粘贴一段日语文章或对话");
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const document = await createDocument({
        title: title.trim() || undefined,
        sourceText,
        targetLevel
      });
      setSelectedDocument(document);
      setSelectedSegmentId(document.segments[0]?.id ?? null);
      setSelectedTokenId(null);
      setAnalysisProgress(await getAnalysisProgress(document.id));
      setDocuments((current) => [
        {
          id: document.id,
          title: document.title,
          targetLevel: document.targetLevel,
          status: document.status,
          segmentCount: document.segmentCount,
          completedSegmentCount: document.completedSegmentCount,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt
        },
        ...current
      ]);
      setTitle("");
      setSourceText("");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "保存文章失败");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSelectDocument(documentId: string): Promise<void> {
    setError(null);
    try {
      const [document, progress] = await Promise.all([
        getDocument(documentId),
        getAnalysisProgress(documentId)
      ]);
      setSelectedDocument(document);
      setSelectedSegmentId(document.segments[0]?.id ?? null);
      setSelectedTokenId(null);
      setAnalysisProgress(progress);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "读取文章失败");
    }
  }

  async function handleStartAnalysis(): Promise<void> {
    if (!selectedDocument) {
      return;
    }

    setIsStartingAnalysis(true);
    setError(null);
    try {
      setAnalysisProgress(await startDocumentAnalysis(selectedDocument.id));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "启动分析失败");
    } finally {
      setIsStartingAnalysis(false);
    }
  }

  async function handleRetrySegment(segmentId: string): Promise<void> {
    setRetryingSegmentId(segmentId);
    setError(null);
    try {
      setAnalysisProgress(await retrySegment(segmentId));
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "重试句段失败");
    } finally {
      setRetryingSegmentId(null);
    }
  }

  const selectedSegment = selectedDocument?.segments.find((segment) => segment.id === selectedSegmentId) ?? null;
  const selectedToken = selectedSegment?.analysis?.tokens.find((token) => token.tokenId === selectedTokenId) ?? null;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PERSONAL JAPANESE READER</p>
          <h1>NihongoNote</h1>
        </div>
        <div className={`status-pill ${health ? "status-ready" : "status-muted"}`}>
          <span className="status-dot" />
          {health ? "本机服务已连接" : isLoading ? "正在连接…" : "服务未连接"}
        </div>
      </header>

      <main className="workspace">
        <aside className="library-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">LIBRARY</p>
              <h2>学习库</h2>
            </div>
            <span className="count-badge">{documents.length}</span>
          </div>
          {documents.length === 0 ? (
            <p className="empty-copy">还没有文章。先粘贴一段日语，建立第一个学习条目。</p>
          ) : (
            <div className="document-list">
              {documents.map((document) => (
                <button
                  className={`document-item ${selectedDocument?.id === document.id ? "is-selected" : ""}`}
                  key={document.id}
                  onClick={() => void handleSelectDocument(document.id)}
                  type="button"
                >
                  <strong>{document.title}</strong>
                  <span>
                    {document.segmentCount} 个句段 · {formatDate(document.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="content-panel">
          {error ? <div className="error-banner">{error}</div> : null}

          <form className="composer-card" onSubmit={(event) => void handleCreateDocument(event)}>
            <div className="panel-heading">
              <div>
                <p className="section-kicker">NEW MATERIAL</p>
                <h2>添加学习材料</h2>
              </div>
              <span className="foundation-badge">P0 FOUNDATION</span>
            </div>
            <label>
              标题
              <input
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：商务需求访谈・场景 1"
                value={title}
              />
            </label>
            <label>
              学习难度
              <select
                onChange={(event) => setTargetLevel(event.target.value as TargetLevel)}
                value={targetLevel}
              >
                {levelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              日语原文
              <textarea
                onChange={(event) => setSourceText(event.target.value)}
                placeholder={"粘贴文章或对话，例如：\n李：初めまして…"}
                rows={11}
                value={sourceText}
              />
            </label>
            <div className="form-footer">
              <span>当前会保存原文并按句子生成基础 segment。</span>
              <button className="primary-button" disabled={isSaving} type="submit">
                {isSaving ? "保存中…" : "保存文章"}
              </button>
            </div>
          </form>

          {selectedDocument ? (
            <article className="reader-card">
              <div className="reader-heading">
                <div>
                  <p className="section-kicker">READER PREVIEW</p>
                  <h2>{selectedDocument.title}</h2>
                </div>
                <div className="reader-actions">
                  <span className="status-label">{statusLabel(selectedDocument.status)}</span>
                  <button
                    className="secondary-button"
                    disabled={isStartingAnalysis || analysisProgress?.status === "analyzing"}
                    onClick={() => void handleStartAnalysis()}
                    type="button"
                  >
                    {analysisProgress?.status === "analyzing" || isStartingAnalysis ? "分析中…" : "开始 AI 分析"}
                  </button>
                </div>
              </div>
              <p className="reader-note">
                点击句段查看分析。当前使用 DeepSeek OpenAI-compatible API；需要先在本机 API 配置密钥。
              </p>
              {analysisProgress ? (
                <div className="analysis-progress">
                  <div className="progress-copy">
                    <span>解析进度</span>
                    <strong>
                      {analysisProgress.completedSegments} / {analysisProgress.totalSegments}
                    </strong>
                  </div>
                  <div className="progress-track">
                    <span
                      style={{
                        width: analysisProgress.totalSegments === 0
                          ? "0%"
                          : `${(analysisProgress.completedSegments / analysisProgress.totalSegments) * 100}%`
                      }}
                    />
                  </div>
                  {analysisProgress.failedSegments > 0 ? (
                    <p className="progress-warning">
                      {analysisProgress.failedSegments} 个句段失败，可以在对应句段中单独重试。
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="segment-list">
                {selectedDocument.segments.map((segment) => (
                  <button
                    className={`segment-row ${selectedSegmentId === segment.id ? "is-selected" : ""}`}
                    key={segment.id}
                    onClick={() => {
                      setSelectedSegmentId(segment.id);
                      setSelectedTokenId(null);
                    }}
                    type="button"
                  >
                    <span className="segment-index">{String(segment.index + 1).padStart(2, "0")}</span>
                    <div>
                      <div className="segment-meta">
                        {segment.speaker ? <span className="speaker-label">{segment.speaker}</span> : null}
                        <span className={`segment-status status-${segment.status}`}>
                          {statusLabel(segment.status)}
                        </span>
                      </div>
                      <p>{segment.text}</p>
                      {segment.errorMessage ? <span className="segment-error">{segment.errorMessage}</span> : null}
                    </div>
                  </button>
                ))}
              </div>
              {selectedSegment ? (
                <aside className="analysis-panel">
                  <div className="analysis-panel-heading">
                    <div>
                      <p className="section-kicker">ANALYSIS</p>
                      <h3>{selectedSegment.speaker ?? "当前句段"}</h3>
                    </div>
                    {selectedSegment.errorMessage ? (
                      <button
                        className="text-button"
                        disabled={retryingSegmentId === selectedSegment.id}
                        onClick={() => void handleRetrySegment(selectedSegment.id)}
                        type="button"
                      >
                        {retryingSegmentId === selectedSegment.id ? "重试中…" : "重试"}
                      </button>
                    ) : null}
                  </div>
                  {selectedSegment.analysis ? (
                    <>
                      <p className="analysis-translation">{selectedSegment.analysis.translation}</p>
                      <div className="analysis-tags">
                        <span>{selectedSegment.analysis.tone}</span>
                        <span>{selectedSegment.analysis.politeness}</span>
                      </div>
                      <div className="analysis-block">
                        <strong>语法与结构</strong>
                        <p>{selectedSegment.analysis.grammarSummary}</p>
                      </div>
                      {selectedSegment.analysis.impliedMeaning ? (
                        <div className="analysis-block">
                          <strong>潜台词</strong>
                          <p>{selectedSegment.analysis.impliedMeaning}</p>
                        </div>
                      ) : null}
                      {selectedSegment.analysis.replyReason ? (
                        <div className="analysis-block">
                          <strong>为什么这样接话</strong>
                          <p>{selectedSegment.analysis.replyReason}</p>
                        </div>
                      ) : null}
                      {selectedSegment.analysis.uncertaintyNote ? (
                        <div className="analysis-uncertainty">
                          <strong>不确定性</strong>
                          <p>{selectedSegment.analysis.uncertaintyNote}</p>
                        </div>
                      ) : null}
                      {selectedSegment.analysis.tokens.length > 0 ? (
                        <div className="token-section">
                          <strong>词语定位</strong>
                          <div className="token-list">
                            {selectedSegment.analysis.tokens.map((token) => (
                              <button
                                className={`token-chip ${selectedTokenId === token.tokenId ? "is-selected" : ""}`}
                                key={token.tokenId}
                                onClick={() => setSelectedTokenId(token.tokenId)}
                                type="button"
                              >
                                {token.surface}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {selectedToken ? (
                        <div className="token-detail">
                          <div className="token-detail-title">
                            <strong>{selectedToken.surface}</strong>
                            <span>{selectedToken.reading ?? "读音未知"}</span>
                          </div>
                          <p>
                            {selectedToken.gloss ?? "暂无词义"}
                            {selectedToken.partOfSpeech ? ` · ${selectedToken.partOfSpeech}` : ""}
                          </p>
                          {selectedToken.explanation ? <p>{selectedToken.explanation}</p> : null}
                          {selectedToken.particleFunction ? (
                            <p>助词功能：{selectedToken.particleFunction}</p>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : selectedSegment.errorMessage ? (
                    <p className="analysis-empty">本句分析失败，请修正配置或点击“重试”。</p>
                  ) : (
                    <p className="analysis-empty">开始分析后，这里会显示翻译、语法、语气和上下文解释。</p>
                  )}
                </aside>
              ) : null}
            </article>
          ) : (
            <div className="welcome-card">
              <span className="welcome-mark">日</span>
              <h2>把难句留在原文里理解</h2>
              <p>
                现在先完成文章保存和句段定位。后续会在这层基础上加入助词、语法、语气、朗读和跟读。
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
