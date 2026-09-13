import { useState, type ReactElement } from "react";

import type { ContentType, TargetLevel, TokenCategory } from "@nihongonote/core";

import { AnalysisTools } from "./analysis-tools";
import { renderArticle } from "./components/ArticleSurface";
import { DocumentMetadataEditor } from "./components/DocumentMetadataEditor";
import { SegmentAnalysisPanel } from "./components/SegmentAnalysisPanel";
import { TokenPopover } from "./components/TokenPopover";
import type { LibraryStatus } from "./lib/constants";
import {
  contentTypeOptions,
  levelOptions,
  tokenCategoryLabels
} from "./lib/constants";
import {
  balanceSummary,
  contentTypeLabel,
  formatCost,
  formatDate,
  statusLabel
} from "./lib/format";
import { themeOptions } from "./lib/storage";
import { useComposer } from "./hooks/useComposer";
import { useLibrary } from "./hooks/useLibrary";
import { useReadingSession } from "./hooks/useReadingSession";
import { useServiceStatus } from "./hooks/useServiceStatus";
import { useTheme } from "./hooks/useTheme";
import { SettingsPanel } from "./settings";
import "./styles.css";

/*
 * S0 拆分说明（docs/p1-enhancement-design.md 第六节）：
 * 常量/类型 → lib/constants，格式化与下载 → lib/format，
 * 本机偏好与主题 → lib/storage，token 类别派生 → lib/tokens，
 * 阅读表面 → components/ArticleSurface，三个解析/编辑卡 → components/*。
 * 本文件只保留状态编排、数据请求与页面布局。
 */

export default function App(): ReactElement {
  const [view, setView] = useState<"reader" | "tools" | "settings">("reader");
  const [error, setError] = useState<string | null>(null);
  const { themePreference, setThemePreference } = useTheme();
  const {
    documents,
    isLibraryLoading,
    isLibraryOpen,
    setIsLibraryOpen,
    librarySearch,
    setLibrarySearch,
    libraryStatus,
    setLibraryStatus,
    refreshLibrary
  } = useLibrary({ onError: setError });
  const { health, isLoading, llmBalance, refreshBalance } = useServiceStatus({ onError: setError });
  const {
    document: selectedDocument,
    progress: analysisProgress,
    selectedSegmentId,
    selectedTokenId,
    selectedSegment,
    selectedToken,
    isAnalysisRunning,
    isStartingAnalysis,
    isCancelling,
    isEditingDocument,
    setIsEditingDocument,
    isSavingDocument,
    isSavingSegment,
    retryingSegmentId,
    openDocument: handleSelectDocument,
    adoptDocument,
    closeDocument,
    selectSegment,
    selectToken,
    clearTokenSelection,
    startAnalysis: handleStartAnalysis,
    cancelAnalysis: handleCancelAnalysis,
    retrySegment: handleRetrySegment,
    saveDocumentMetadata: handleSaveDocumentMetadata,
    saveSegment: handleSaveSegment,
    saveToken: handleSaveToken,
    exportSourceText: handleExportSourceText,
    exportAnalysisJson: handleExportAnalysisJson
  } = useReadingSession({
    onError: setError,
    onLibraryChanged: refreshLibrary,
    onDocumentMetadataChanged: (nextContentType, nextTargetLevel) => {
      setContentType(nextContentType);
      setTargetLevel(nextTargetLevel);
    }
  });
  const {
    title,
    setTitle,
    sourceText,
    setSourceText,
    contentType,
    setContentType,
    targetLevel,
    setTargetLevel,
    isSaving,
    submit: handleCreateDocument,
    reset: resetComposer
  } = useComposer({
    onCreated: adoptDocument,
    onError: setError,
    onLibraryChanged: () => {
      void refreshLibrary().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "刷新学习库失败");
      });
    }
  });

  function handleNewDocument(): void {
    setError(null);
    closeDocument();
    resetComposer();
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PERSONAL JAPANESE READER</p>
          <h1>NihongoNote</h1>
        </div>
        <div className="topbar-actions">
          <button
            className={`view-toggle ${view === "reader" ? "is-active" : ""}`}
            onClick={() => setView("reader")}
            type="button"
          >
            阅读
          </button>
          <button
            className={`view-toggle ${view === "tools" ? "is-active" : ""}`}
            onClick={() => setView("tools")}
            type="button"
          >
            分析工具
          </button>
          <button
            className={`view-toggle ${view === "settings" ? "is-active" : ""}`}
            onClick={() => setView("settings")}
            type="button"
          >
            设置
          </button>
          <select
            aria-label="界面主题"
            className="theme-select"
            onChange={(event) => setThemePreference(event.target.value)}
            title="切换界面主题（六套提案）；跟随系统会随系统深色模式自动切换"
            value={themePreference}
          >
            {themeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
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
          <div
            className={`balance-pill ${llmBalance ? "balance-ready" : "balance-muted"}`}
            title={llmBalance
              ? `模型：${llmBalance.model} · ${llmBalance.baseUrl}`
              : "未配置 LLM 或余额查询失败"}
          >
            {llmBalance
              ? `${llmBalance.apiKeyMasked} · ${balanceSummary(llmBalance)}`
              : "余额未知"}
          </div>
          <div className={`status-pill ${health ? "status-ready" : "status-muted"}`}>
            <span className="status-dot" />
            {health ? "本机服务已连接" : isLoading ? "正在连接…" : "服务未连接"}
          </div>
        </div>
      </header>

      <main className={`workspace ${view !== "reader" || !isLibraryOpen ? "library-collapsed" : ""}`}>
        {view !== "reader" ? null : isLibraryOpen ? (
          <aside className="library-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">LIBRARY</p>
                <h2>学习库</h2>
              </div>
              <div className="library-heading-actions">
                <span className="count-badge">{documents.length}</span>
                <button
                  aria-label="新建学习材料"
                  className="panel-icon-button"
                  onClick={handleNewDocument}
                  title="新建学习材料"
                  type="button"
                >
                  ＋
                </button>
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
            <div className="library-filters">
              <label className="filter-field">
                <span>搜索文章</span>
                <input
                  onChange={(event) => setLibrarySearch(event.target.value)}
                  placeholder="标题或原文片段"
                  type="search"
                  value={librarySearch}
                />
              </label>
              <label className="filter-field">
                <span>分析状态</span>
                <select
                  onChange={(event) => setLibraryStatus(event.target.value as LibraryStatus)}
                  value={libraryStatus}
                >
                  <option value="all">全部状态</option>
                  <option value="draft">待分析</option>
                  <option value="analyzing">分析中</option>
                  <option value="ready">已完成</option>
                  <option value="failed">有失败</option>
                </select>
              </label>
            </div>
            {isLibraryLoading ? (
              <p className="empty-copy">正在更新学习库…</p>
            ) : documents.length === 0 ? (
              <p className="empty-copy">
                {librarySearch.trim() || libraryStatus !== "all"
                  ? "没有符合当前搜索或状态筛选的文章。"
                  : "还没有文章。先粘贴一段日语，建立第一个学习条目。"}
              </p>
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
                      {contentTypeLabel(document.contentType)} · {statusLabel(document.status)} ·{" "}
                      {document.segmentCount} 个句段 · {formatDate(document.updatedAt)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>
        ) : null}

        <section className="content-panel">
          {view === "tools" ? (
            <AnalysisTools />
          ) : view === "settings" ? (
            <SettingsPanel onSettingsSaved={refreshBalance} />
          ) : (
            <>
          {error ? <div className="error-banner">{error}</div> : null}

          {selectedDocument === null ? (
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
                内容类型
                <select
                  onChange={(event) => setContentType(event.target.value as ContentType)}
                  value={contentType}
                >
                  {contentTypeOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="field-note">自动识别只作建议，保存后仍以你的选择为准。</span>
              </label>
              <label>
                解释等级
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
                <span className="field-note">只影响教学表达；基础 token、语法和句意分析保持共用。</span>
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
          ) : null}

          {selectedDocument ? (
            <article className="reader-card">
              <div className="reader-heading">
                <div>
                  <p className="section-kicker">READER</p>
                  <h2>{selectedDocument.title}</h2>
                  <div className="reader-subtitle">
                    <span className="content-type-badge">{contentTypeLabel(selectedDocument.contentType)}</span>
                    {selectedDocument.contentTypeSuggestion
                      && selectedDocument.contentTypeSuggestion.contentType !== selectedDocument.contentType ? (
                      <span>
                        系统建议：{contentTypeLabel(selectedDocument.contentTypeSuggestion.contentType)}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="reader-actions">
                  <span className="status-label">{statusLabel(selectedDocument.status)}</span>
                  <button
                    className="text-button"
                    onClick={handleNewDocument}
                    type="button"
                  >
                    新建
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setIsEditingDocument((current) => !current)}
                    type="button"
                  >
                    {isEditingDocument ? "关闭设置" : "编辑设置"}
                  </button>
                  <button
                    className="text-button"
                    disabled={!selectedDocument}
                    onClick={handleExportSourceText}
                    title="把当前文章的原文导出为 .txt"
                    type="button"
                  >
                    导出原文
                  </button>
                  <button
                    className="text-button"
                    disabled={!selectedDocument}
                    onClick={handleExportAnalysisJson}
                    title="把当前文章的解析结果导出为 .json（含句段、token 分析与人工修正版本）"
                    type="button"
                  >
                    导出解析
                  </button>
                  {isAnalysisRunning ? (
                    <button
                      className="cancel-button"
                      disabled={isCancelling}
                      onClick={() => void handleCancelAnalysis()}
                      type="button"
                    >
                      {isCancelling ? "取消中…" : "取消分析"}
                    </button>
                  ) : (
                    <button
                      className="secondary-button"
                      disabled={isStartingAnalysis}
                      onClick={() => void handleStartAnalysis()}
                      type="button"
                    >
                      {isStartingAnalysis ? "启动中…" : "开始 AI 分析"}
                    </button>
                  )}
                </div>
              </div>
              {isEditingDocument ? (
                <DocumentMetadataEditor
                  document={selectedDocument}
                  isSaving={isSavingDocument}
                  onCancel={() => setIsEditingDocument(false)}
                  onSave={handleSaveDocumentMetadata}
                />
              ) : null}
              <p className="reader-note">
                文章会在一个连续阅读框中保留原文、换行和标点。P1 MVP 先提供句子层和 token 层解析；点击彩色词块查看词语解释，点击句子空白处查看整句分析。多个短句会合并为批量请求并以流式方式接收。
              </p>
              {analysisProgress ? (
                <div className="analysis-progress">
                  <div className="progress-copy">
                    <span>
                      解析进度 · {statusLabel(analysisProgress.status)}
                      {isAnalysisRunning ? " · 流式处理中" : ""}
                    </span>
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
                  <p className="progress-detail">
                    {analysisProgress.processingSegments} 个处理中 · {analysisProgress.queuedSegments} 个待处理
                  </p>
                  {analysisProgress.failedSegments > 0 ? (
                    <p className="progress-warning">
                      {analysisProgress.failedSegments} 个句段失败，可以点击对应句子后单独重试。
                    </p>
                  ) : null}
                  {analysisProgress.usage ? (
                    <p className="progress-cost">
                      {analysisProgress.cost ? (
                        <>
                          本次已花费{" "}
                          <strong>{formatCost(analysisProgress.cost.totalCost)}</strong>
                          <span className="progress-cost-note">
                            （{analysisProgress.cost.tier === "peak" ? "高峰" : "闲时"}计价
                            · 输入 {analysisProgress.cost.cachedInputTokens.toLocaleString()} 缓存
                            + {analysisProgress.cost.uncachedInputTokens.toLocaleString()} 未命中
                            / 输出 {analysisProgress.cost.outputTokens.toLocaleString()}）
                          </span>
                        </>
                      ) : (
                        "费用：该模型暂无内置价格表（价格未知）"
                      )}
                      {analysisProgress.usage.totalTokens !== null ? (
                        <span className="progress-cost-note">
                          {" · "}
                          累计 {analysisProgress.usage.totalTokens.toLocaleString()} tokens
                        </span>
                      ) : null}
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
                        selectSegment,
                        selectToken
                      )}
                    </div>
                    {selectedToken ? null : (
                      <p className="article-hint">
                        {selectedDocument.status === "ready"
                          ? "点击一个彩色词块，打开对应的词语解析。"
                          : "完成 AI 分析后，词语会按类型着色并可以点击查看解释。"}
                      </p>
                    )}
                  </div>
                </div>
                <div className="notes-column">
                  {selectedSegment ? (
                    <SegmentAnalysisPanel
                      isRetrying={retryingSegmentId === selectedSegment.id}
                      isSaving={isSavingSegment}
                      onRetry={() => void handleRetrySegment(selectedSegment.id)}
                      onSave={handleSaveSegment}
                      segment={selectedSegment}
                    />
                  ) : null}
                  {selectedToken && selectedSegment ? (
                    <TokenPopover
                      isSaving={isSavingSegment}
                      onClose={clearTokenSelection}
                      onSave={(_tokenId, override) => handleSaveToken(selectedSegment.id, override)}
                      token={selectedToken}
                    />
                  ) : null}
                </div>
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
            </>
          )}
        </section>
      </main>
    </div>
  );
}
