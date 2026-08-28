import { useEffect, useState, type FormEvent, type ReactElement, type ReactNode } from "react";

import type {
  AnalysisProgress,
  DocumentDetail,
  DocumentSummary,
  HealthResponse,
  TargetLevel,
  TokenAnalysis,
  TokenCategory
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

const tokenCategoryLabels: Record<TokenCategory, string> = {
  word: "词语",
  particle: "助词",
  adverb: "副词",
  grammar: "语法"
};

function getTokenCategory(token: TokenAnalysis): TokenCategory {
  if (token.category !== "word") {
    return token.category;
  }

  const partOfSpeech = token.partOfSpeech?.toLowerCase() ?? "";
  if (token.particleFunction) {
    return "particle";
  }
  if (partOfSpeech.includes("副词") || partOfSpeech.includes("adverb")) {
    return "adverb";
  }
  if (token.grammarPoint) {
    return "grammar";
  }
  return token.category;
}

function isRenderableToken(token: TokenAnalysis, text: string): boolean {
  return token.startOffset >= 0
    && token.endOffset > token.startOffset
    && token.endOffset <= text.length
    && text.slice(token.startOffset, token.endOffset) === token.surface;
}

type Segment = DocumentDetail["segments"][number];

function renderSegmentContent(
  segment: Segment,
  selectedTokenId: string | null,
  onSelectSegment: (segmentId: string) => void,
  onSelectToken: (segmentId: string, tokenId: string) => void
): ReactElement {
  const content: ReactNode[] = [];
  const tokens = (segment.analysis?.tokens ?? [])
    .filter((token) => isRenderableToken(token, segment.text))
    .sort((left, right) => left.startOffset - right.startOffset);
  let cursor = 0;

  for (const token of tokens) {
    if (token.startOffset < cursor) {
      continue;
    }
    if (token.startOffset > cursor) {
      content.push(
        <span className="article-plain" key={`${token.tokenId}:before`}>
          {segment.text.slice(cursor, token.startOffset)}
        </span>
      );
    }

    const category = getTokenCategory(token);
    content.push(
      <button
        aria-label={`${token.surface}，${tokenCategoryLabels[category]}`}
        aria-pressed={selectedTokenId === token.tokenId}
        className={`annotation-token annotation-${category} ${
          selectedTokenId === token.tokenId ? "is-selected" : ""
        }`}
        key={token.tokenId}
        onClick={(event) => {
          event.stopPropagation();
          onSelectToken(segment.id, token.tokenId);
        }}
        title={tokenCategoryLabels[category]}
        type="button"
      >
        {token.surface}
      </button>
    );
    cursor = token.endOffset;
  }

  if (cursor < segment.text.length) {
    content.push(
      <span className="article-plain" key={`${segment.id}:after`}>
        {segment.text.slice(cursor)}
      </span>
    );
  }

  if (content.length === 0) {
    content.push(
      <span className="article-plain" key={`${segment.id}:text`}>
        {segment.text}
      </span>
    );
  }

  return (
    <span
      aria-label={`第 ${segment.index + 1} 句`}
      className={`article-segment status-${segment.status}`}
      data-segment-id={segment.id}
      onClick={() => onSelectSegment(segment.id)}
    >
      {content}
    </span>
  );
}

function renderArticle(
  document: DocumentDetail,
  selectedSegmentId: string | null,
  selectedTokenId: string | null,
  onSelectSegment: (segmentId: string) => void,
  onSelectToken: (segmentId: string, tokenId: string) => void
): ReactNode[] {
  const content: ReactNode[] = [];
  let cursor = 0;

  for (const segment of document.segments) {
    const startOffset = Math.max(0, Math.min(document.sourceText.length, segment.startOffset));
    const endOffset = Math.max(startOffset, Math.min(document.sourceText.length, segment.endOffset));

    if (startOffset > cursor) {
      content.push(
        <span className="article-source-gap" key={`${segment.id}:gap`}>
          {document.sourceText.slice(cursor, startOffset)}
        </span>
      );
    }

    content.push(
      <span
        className={`article-segment-wrapper ${segment.id === selectedSegmentId ? "is-active" : ""}`}
        key={segment.id}
      >
        {renderSegmentContent(segment, selectedTokenId, onSelectSegment, onSelectToken)}
      </span>
    );
    cursor = Math.max(cursor, endOffset);
  }

  if (cursor < document.sourceText.length) {
    content.push(
      <span className="article-source-gap" key="article:tail">
        {document.sourceText.slice(cursor)}
      </span>
    );
  }

  if (content.length === 0) {
    content.push(<span key="article:source">{document.sourceText}</span>);
  }

  return content;
}

function TokenFact({ label, value }: { label: string; value: string | null }): ReactElement | null {
  if (!value || value.trim().length === 0) {
    return null;
  }
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function TokenPopover({ token, onClose }: { token: TokenAnalysis; onClose: () => void }): ReactElement {
  const category = getTokenCategory(token);
  return (
    <aside aria-label="词语解析" className="token-popover" role="dialog">
      <div className="token-popover-heading">
        <div>
          <p className="section-kicker">WORD NOTE</p>
          <div className="token-popover-title">
            <strong>{token.surface}</strong>
            <span>{token.reading ?? "读音未知"}</span>
          </div>
        </div>
        <button aria-label="关闭词语解析" className="icon-button" onClick={onClose} type="button">
          ×
        </button>
      </div>
      <span className={`annotation-label annotation-${category}`}>{tokenCategoryLabels[category]}</span>
      <dl className="token-facts">
        <TokenFact label="常见释义" value={token.gloss} />
        <TokenFact label="原形" value={token.lemma} />
        <TokenFact label="词性" value={token.partOfSpeech} />
        <TokenFact label="活用" value={token.conjugation} />
        <TokenFact label="本句中的作用" value={token.particleFunction} />
        <TokenFact label="语法点" value={token.grammarPoint} />
        <TokenFact label="本句解释" value={token.explanation} />
        <TokenFact
          label="置信度"
          value={token.confidence === null ? null : `${Math.round(token.confidence * 100)}%`}
        />
      </dl>
    </aside>
  );
}

function SegmentAnalysisPanel({
  segment,
  isRetrying,
  onRetry
}: {
  segment: Segment;
  isRetrying: boolean;
  onRetry: () => void;
}): ReactElement {
  return (
    <aside className="analysis-panel">
      <div className="analysis-panel-heading">
        <div>
          <p className="section-kicker">SENTENCE NOTE</p>
          <h3>
            第 {segment.index + 1} 句
            {segment.speaker ? ` · ${segment.speaker}` : ""}
          </h3>
        </div>
        {segment.errorMessage ? (
          <button className="text-button" disabled={isRetrying} onClick={onRetry} type="button">
            {isRetrying ? "重试中…" : "重试"}
          </button>
        ) : null}
      </div>
      {segment.analysis ? (
        <>
          <p className="analysis-translation">{segment.analysis.translation}</p>
          <div className="analysis-tags">
            <span>{segment.analysis.tone}</span>
            <span>{segment.analysis.politeness}</span>
          </div>
          <div className="analysis-block">
            <strong>语法与结构</strong>
            <p>{segment.analysis.grammarSummary}</p>
          </div>
          {segment.analysis.impliedMeaning ? (
            <div className="analysis-block">
              <strong>潜台词</strong>
              <p>{segment.analysis.impliedMeaning}</p>
            </div>
          ) : null}
          {segment.analysis.replyReason ? (
            <div className="analysis-block">
              <strong>为什么这样接话</strong>
              <p>{segment.analysis.replyReason}</p>
            </div>
          ) : null}
          {segment.analysis.uncertaintyNote ? (
            <div className="analysis-uncertainty">
              <strong>不确定性</strong>
              <p>{segment.analysis.uncertaintyNote}</p>
            </div>
          ) : null}
        </>
      ) : segment.errorMessage ? (
        <p className="analysis-empty">本句分析失败，请修正配置或点击“重试”。</p>
      ) : (
        <p className="analysis-empty">完成分析后，这里会显示翻译、语法、语气和上下文解释。</p>
      )}
    </aside>
  );
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
  const [isLibraryOpen, setIsLibraryOpen] = useState(true);
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
        <div className="topbar-actions">
          <button
            aria-expanded={isLibraryOpen}
            className="library-toggle"
            onClick={() => setIsLibraryOpen((current) => !current)}
            type="button"
          >
            <span className="library-toggle-icon" aria-hidden="true">
              {isLibraryOpen ? "‹" : "›"}
            </span>
            {isLibraryOpen ? "隐藏学习库" : "显示学习库"}
          </button>
          <div className={`status-pill ${health ? "status-ready" : "status-muted"}`}>
            <span className="status-dot" />
            {health ? "本机服务已连接" : isLoading ? "正在连接…" : "服务未连接"}
          </div>
        </div>
      </header>

      <main className={`workspace ${isLibraryOpen ? "" : "library-collapsed"}`}>
        {isLibraryOpen ? (
          <aside className="library-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">LIBRARY</p>
                <h2>学习库</h2>
              </div>
              <div className="library-heading-actions">
                <span className="count-badge">{documents.length}</span>
                <button
                  aria-label="隐藏学习库"
                  className="panel-icon-button"
                  onClick={() => setIsLibraryOpen(false)}
                  type="button"
                >
                  ×
                </button>
              </div>
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
        ) : null}

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
                placeholder={"粘贴课文、文章或对话，例如：\n初めまして…"}
                rows={11}
                value={sourceText}
              />
            </label>
            <div className="form-footer">
              <span>原文会保持连续阅读，分析结果再按稳定 token 位置叠加标注。</span>
              <button className="primary-button" disabled={isSaving} type="submit">
                {isSaving ? "保存中…" : "保存文章"}
              </button>
            </div>
          </form>

          {selectedDocument ? (
            <article className="reader-card">
              <div className="reader-heading">
                <div>
                  <p className="section-kicker">READER</p>
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
                文章会在一个连续阅读框中保留原文、换行和标点。分析完成后，点击彩色词块查看词语、助词、副词或语法解释；点击句子空白处查看整句分析。
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
                      {analysisProgress.failedSegments} 个句段失败，可以点击对应句子后单独重试。
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="reader-layout">
                <div className="article-column">
                  <div className="article-toolbar">
                    <div>
                      <p className="section-kicker">ANNOTATED ARTICLE</p>
                      <span className="article-meta">
                        {selectedDocument.segments.length} 个分析单元 · 原文连续显示
                      </span>
                    </div>
                    <div aria-label="标注图例" className="annotation-legend">
                      {(Object.keys(tokenCategoryLabels) as TokenCategory[]).map((category) => (
                        <span className="annotation-legend-item" key={category}>
                          <i className={`annotation-swatch annotation-${category}`} />
                          {tokenCategoryLabels[category]}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="article-canvas">
                    <div className="article-content">
                      {renderArticle(
                        selectedDocument,
                        selectedSegmentId,
                        selectedTokenId,
                        (segmentId) => {
                          setSelectedSegmentId(segmentId);
                          setSelectedTokenId(null);
                        },
                        (segmentId, tokenId) => {
                          setSelectedSegmentId(segmentId);
                          setSelectedTokenId(tokenId);
                        }
                      )}
                    </div>
                    {selectedToken ? (
                      <TokenPopover token={selectedToken} onClose={() => setSelectedTokenId(null)} />
                    ) : (
                      <p className="article-hint">
                        {selectedDocument.status === "ready"
                          ? "点击一个彩色词块，打开对应的词语解析。"
                          : "完成 AI 分析后，词语会按类型着色并可以点击查看解释。"}
                      </p>
                    )}
                  </div>
                </div>
                {selectedSegment ? (
                  <SegmentAnalysisPanel
                    isRetrying={retryingSegmentId === selectedSegment.id}
                    onRetry={() => void handleRetrySegment(selectedSegment.id)}
                    segment={selectedSegment}
                  />
                ) : null}
              </div>
            </article>
          ) : (
            <div className="welcome-card">
              <span className="welcome-mark">日</span>
              <h2>在完整文章里理解每个难点</h2>
              <p>
                粘贴课文、普通文章或对话后，原文会保持连续显示。AI 分析会为词语、助词、副词、语法和整句语气提供可点击的解释。
              </p>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
