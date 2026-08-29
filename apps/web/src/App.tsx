import {
  useEffect,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode
} from "react";

import type {
  AnalysisProgress,
  ContentType,
  DocumentDetail,
  DocumentSummary,
  HealthResponse,
  LlmBalance,
  TargetLevel,
  TokenAnalysis,
  TokenCategory,
  TokenAnalysisOverride
} from "@nihongonote/core";

import {
  createDocument,
  cancelDocumentAnalysis,
  getAnalysisProgress,
  getDocument,
  getHealth,
  getLlmBalance,
  listDocuments,
  retrySegment,
  startDocumentAnalysis,
  updateDocument,
  updateSegment,
  updateSegmentAnalysis,
  type SegmentAnalysisUpdateInput
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

const contentTypeOptions: Array<{ value: ContentType; label: string }> = [
  { value: "lesson", label: "课文" },
  { value: "article", label: "普通文章" },
  { value: "dialogue", label: "对话" },
  { value: "news_expository", label: "新闻 / 说明文" },
  { value: "note", label: "笔记" },
  { value: "other", label: "其他" }
];

const contentTypeLabels: Record<ContentType, string> = {
  lesson: "课文",
  article: "普通文章",
  dialogue: "对话",
  news_expository: "新闻 / 说明文",
  note: "笔记",
  other: "其他"
};

type LibraryStatus = "all" | DocumentDetail["status"];
type MvpDocument = DocumentDetail;
type MvpDocumentSummary = DocumentSummary;

const libraryStorageKeys = {
  open: "nihongonote.library.open",
  search: "nihongonote.library.search",
  status: "nihongonote.library.status"
} as const;

function storedValue(key: string): string | null {
  return typeof window === "undefined" ? null : window.localStorage.getItem(key);
}

function isLibraryStatus(value: string | null): value is LibraryStatus {
  return value === "draft"
    || value === "analyzing"
    || value === "ready"
    || value === "failed";
}

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

function contentTypeLabel(value: ContentType | null | undefined): string {
  return value ? contentTypeLabels[value] : "未选择类型";
}

/** 余额取第一个币种条目展示（当前 DeepSeek 只返回 CNY）。 */
function balanceSummary(balance: LlmBalance | null): string | null {
  const entry = balance?.entries[0];
  return entry ? `${entry.currency} ${entry.totalBalance}` : null;
}

/** 金额很小（一次分析通常不足 1 元），小额显示 4 位小数，大额显示 2 位。 */
function formatCost(cost: number): string {
  return cost >= 1 ? `¥${cost.toFixed(2)}` : `¥${cost.toFixed(4)}`;
}

function documentContentType(document: MvpDocument): ContentType {
  return document.contentType;
}

const tokenCategoryLabels: Record<TokenCategory, string> = {
  word: "词语",
  particle: "助词",
  functional: "功能词",
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
  if (
    partOfSpeech.includes("助動詞")
    || partOfSpeech.includes("助动词")
    || partOfSpeech.includes("auxiliary")
  ) {
    return "functional";
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
  isSelected: boolean,
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
      className={`article-segment status-${segment.status} ${isSelected ? "is-selected" : ""}`}
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
        {renderSegmentContent(
          segment,
          segment.id === selectedSegmentId,
          selectedTokenId,
          onSelectSegment,
          onSelectToken
        )}
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

function TokenFact({ label, value }: { label: string; value: string | null | undefined }): ReactElement | null {
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

function TokenPopover({
  token,
  isSaving,
  onClose,
  onSave
}: {
  token: TokenAnalysis;
  isSaving: boolean;
  onClose: () => void;
  onSave: (tokenId: string, override: TokenAnalysisOverride) => Promise<void>;
}): ReactElement {
  const category = getTokenCategory(token);
  const [isEditing, setIsEditing] = useState(false);
  const [draftLemma, setDraftLemma] = useState("");
  const [draftReading, setDraftReading] = useState("");
  const [draftPartOfSpeech, setDraftPartOfSpeech] = useState("");
  const [draftConjugation, setDraftConjugation] = useState("");
  const [draftGloss, setDraftGloss] = useState("");
  const [draftParticleFunction, setDraftParticleFunction] = useState("");
  const [draftGrammarPoint, setDraftGrammarPoint] = useState("");
  const [draftExplanation, setDraftExplanation] = useState("");

  function loadDraft(): void {
    setDraftLemma(token.lemma ?? "");
    setDraftReading(token.reading ?? "");
    setDraftPartOfSpeech(token.partOfSpeech ?? "");
    setDraftConjugation(token.conjugation ?? "");
    setDraftGloss(token.gloss ?? "");
    setDraftParticleFunction(token.particleFunction ?? "");
    setDraftGrammarPoint(token.grammarPoint ?? "");
    setDraftExplanation(token.explanation ?? "");
  }

  useEffect(() => {
    loadDraft();
    setIsEditing(false);
  }, [token.tokenId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onSave(token.tokenId, {
      tokenId: token.tokenId,
      lemma: optionalText(draftLemma),
      reading: optionalText(draftReading),
      partOfSpeech: optionalText(draftPartOfSpeech),
      conjugation: optionalText(draftConjugation),
      gloss: optionalText(draftGloss),
      particleFunction: optionalText(draftParticleFunction),
      grammarPoint: optionalText(draftGrammarPoint),
      explanation: optionalText(draftExplanation)
    });
    setIsEditing(false);
  }

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
        <div className="token-popover-actions">
          <button
            className="text-button"
            disabled={isSaving}
            onClick={() => {
              loadDraft();
              setIsEditing((current) => !current);
            }}
            type="button"
          >
            {isEditing ? "关闭编辑" : "编辑"}
          </button>
          <button aria-label="关闭词语解析" className="icon-button" onClick={onClose} type="button">
            ×
          </button>
        </div>
      </div>
      <span className={`annotation-label annotation-${category}`}>{tokenCategoryLabels[category]}</span>
      {isEditing ? (
        <form className="segment-editor token-editor" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            原形
            <input onChange={(event) => setDraftLemma(event.target.value)} value={draftLemma} />
          </label>
          <label>
            读音
            <input onChange={(event) => setDraftReading(event.target.value)} value={draftReading} />
          </label>
          <label>
            词性
            <input
              onChange={(event) => setDraftPartOfSpeech(event.target.value)}
              value={draftPartOfSpeech}
            />
          </label>
          <label>
            活用
            <input onChange={(event) => setDraftConjugation(event.target.value)} value={draftConjugation} />
          </label>
          <label>
            常见释义
            <input onChange={(event) => setDraftGloss(event.target.value)} value={draftGloss} />
          </label>
          <label>
            本句中的作用
            <textarea
              onChange={(event) => setDraftParticleFunction(event.target.value)}
              rows={2}
              value={draftParticleFunction}
            />
          </label>
          <label>
            语法点
            <textarea
              onChange={(event) => setDraftGrammarPoint(event.target.value)}
              rows={2}
              value={draftGrammarPoint}
            />
          </label>
          <label>
            本句解释
            <textarea
              onChange={(event) => setDraftExplanation(event.target.value)}
              rows={3}
              value={draftExplanation}
            />
          </label>
          <div className="metadata-editor-actions">
            <button className="text-button" onClick={() => setIsEditing(false)} type="button">
              取消
            </button>
            <button className="secondary-button" disabled={isSaving} type="submit">
              {isSaving ? "保存中…" : "保存词语修改"}
            </button>
          </div>
        </form>
      ) : (
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
      )}
    </aside>
  );
}

function DocumentMetadataEditor({
  document,
  isSaving,
  onCancel,
  onSave
}: {
  document: MvpDocument;
  isSaving: boolean;
  onCancel: () => void;
  onSave: (input: {
    title: string;
    contentType: ContentType;
    targetLevel: TargetLevel;
  }) => Promise<void>;
}): ReactElement {
  const [draftTitle, setDraftTitle] = useState(document.title);
  const [draftContentType, setDraftContentType] = useState<ContentType>(documentContentType(document));
  const [draftTargetLevel, setDraftTargetLevel] = useState<TargetLevel>(document.targetLevel);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setDraftTitle(document.title);
    setDraftContentType(documentContentType(document));
    setDraftTargetLevel(document.targetLevel);
    setValidationError(null);
  }, [document.id, document.title, document.contentType, document.targetLevel]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedTitle = draftTitle.trim();
    if (!normalizedTitle) {
      setValidationError("标题不能为空");
      return;
    }
    setValidationError(null);
    await onSave({
      title: normalizedTitle,
      contentType: draftContentType,
      targetLevel: draftTargetLevel
    });
  }

  const suggestion = document.contentTypeSuggestion?.contentType;
  return (
    <form className="metadata-editor" onSubmit={(event) => void handleSubmit(event)}>
      <div className="metadata-editor-grid">
        <label>
          标题
          <input
            onChange={(event) => {
              setValidationError(null);
              setDraftTitle(event.target.value);
            }}
            required
            value={draftTitle}
          />
        </label>
        <label>
          内容类型
          <select
            onChange={(event) => setDraftContentType(event.target.value as ContentType)}
            value={draftContentType}
          >
            {contentTypeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          解释等级
          <select
            onChange={(event) => setDraftTargetLevel(event.target.value as TargetLevel)}
            value={draftTargetLevel}
          >
            {levelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {validationError ? <p className="editor-error">{validationError}</p> : null}
      {suggestion && suggestion !== draftContentType ? (
        <p className="metadata-suggestion">
          系统建议：{contentTypeLabel(suggestion)}（仅供参考，当前以手动选择为准）
        </p>
      ) : null}
      <div className="metadata-editor-actions">
        <button className="text-button" onClick={onCancel} type="button">
          取消
        </button>
        <button className="secondary-button" disabled={isSaving} type="submit">
          {isSaving ? "保存中…" : "保存文章设置"}
        </button>
      </div>
    </form>
  );
}

function optionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function SegmentAnalysisPanel({
  segment,
  isRetrying,
  isSaving,
  onRetry,
  onSave
}: {
  segment: Segment;
  isRetrying: boolean;
  isSaving: boolean;
  onRetry: () => void;
  onSave: (
    segmentId: string,
    speaker: string | null,
    analysis: SegmentAnalysisUpdateInput | null
  ) => Promise<void>;
}): ReactElement {
  const [isEditing, setIsEditing] = useState(false);
  const [draftSpeaker, setDraftSpeaker] = useState("");
  const [draftTranslation, setDraftTranslation] = useState("");
  const [draftGrammarSummary, setDraftGrammarSummary] = useState("");
  const [draftTone, setDraftTone] = useState("");
  const [draftPoliteness, setDraftPoliteness] = useState("");
  const [draftImpliedMeaning, setDraftImpliedMeaning] = useState("");
  const [draftReplyReason, setDraftReplyReason] = useState("");
  const [draftUncertaintyNote, setDraftUncertaintyNote] = useState("");
  const [showOriginalAnalysis, setShowOriginalAnalysis] = useState(false);

  function loadDraft(): void {
    setDraftSpeaker(segment.speaker ?? "");
    setDraftTranslation(segment.analysis?.translation ?? "");
    setDraftGrammarSummary(segment.analysis?.grammarSummary ?? "");
    setDraftTone(segment.analysis?.tone ?? "");
    setDraftPoliteness(segment.analysis?.politeness ?? "");
    setDraftImpliedMeaning(segment.analysis?.impliedMeaning ?? "");
    setDraftReplyReason(segment.analysis?.replyReason ?? "");
    setDraftUncertaintyNote(segment.analysis?.uncertaintyNote ?? "");
  }

  useEffect(() => {
    loadDraft();
    setIsEditing(false);
    setShowOriginalAnalysis(false);
  }, [segment.id]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const analysis = segment.analysis
      ? {
          translation: draftTranslation.trim(),
          grammarSummary: draftGrammarSummary.trim(),
          tone: draftTone.trim(),
          politeness: draftPoliteness.trim(),
          impliedMeaning: optionalText(draftImpliedMeaning),
          replyReason: optionalText(draftReplyReason),
          uncertaintyNote: optionalText(draftUncertaintyNote)
        }
      : null;
    await onSave(segment.id, optionalText(draftSpeaker), analysis);
    setIsEditing(false);
  }

  const displayedAnalysis = showOriginalAnalysis ? segment.originalAnalysis : segment.analysis;

  return (
    <aside className="analysis-panel">
      <div className="analysis-panel-heading">
        <div>
          <p className="section-kicker">SENTENCE NOTE</p>
          <h3>
            第 {segment.index + 1} 句
            {segment.speaker ? ` · ${segment.speaker}` : ""}
          </h3>
          {segment.userRevision ? (
            <span className="revision-badge">已保留用户修正 v{segment.userRevision.revision}</span>
          ) : null}
        </div>
        <div className="analysis-panel-actions">
          {segment.userRevision && segment.originalAnalysis ? (
            <button
              className="text-button"
              onClick={() => setShowOriginalAnalysis((current) => !current)}
              type="button"
            >
              {showOriginalAnalysis ? "查看用户版本" : "查看 AI 原始"}
            </button>
          ) : null}
          <button
            className="text-button"
            disabled={isSaving}
            onClick={() => {
              loadDraft();
              setIsEditing((current) => !current);
            }}
            type="button"
          >
            {isEditing ? "关闭编辑" : "编辑"}
          </button>
          {segment.errorMessage ? (
            <button className="text-button" disabled={isRetrying} onClick={onRetry} type="button">
              {isRetrying ? "重试中…" : "重试"}
            </button>
          ) : null}
        </div>
      </div>
      {isEditing ? (
        <form className="segment-editor" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            角色
            <input
              onChange={(event) => setDraftSpeaker(event.target.value)}
              placeholder="例如：A、田中部长"
              value={draftSpeaker}
            />
          </label>
          {segment.analysis ? (
            <>
              <label>
                自然中文译文
                <textarea
                  onChange={(event) => setDraftTranslation(event.target.value)}
                  required
                  rows={3}
                  value={draftTranslation}
                />
              </label>
              <label>
                语法与结构
                <textarea
                  onChange={(event) => setDraftGrammarSummary(event.target.value)}
                  required
                  rows={3}
                  value={draftGrammarSummary}
                />
              </label>
              <div className="segment-editor-grid">
                <label>
                  语气 / 态度
                  <input
                    onChange={(event) => setDraftTone(event.target.value)}
                    required
                    value={draftTone}
                  />
                </label>
                <label>
                  礼貌程度
                  <input
                    onChange={(event) => setDraftPoliteness(event.target.value)}
                    required
                    value={draftPoliteness}
                  />
                </label>
              </div>
              <label>
                潜台词
                <textarea
                  onChange={(event) => setDraftImpliedMeaning(event.target.value)}
                  rows={2}
                  value={draftImpliedMeaning}
                />
              </label>
              <label>
                接话理由
                <textarea
                  onChange={(event) => setDraftReplyReason(event.target.value)}
                  rows={2}
                  value={draftReplyReason}
                />
              </label>
              <label>
                不确定性说明
                <textarea
                  onChange={(event) => setDraftUncertaintyNote(event.target.value)}
                  rows={2}
                  value={draftUncertaintyNote}
                />
              </label>
            </>
          ) : (
            <p className="editor-note">本句尚未有 AI 解析，先保存角色；完成分析后可编辑解析字段。</p>
          )}
          <div className="metadata-editor-actions">
            <button className="text-button" onClick={() => setIsEditing(false)} type="button">
              取消
            </button>
            <button className="secondary-button" disabled={isSaving} type="submit">
              {isSaving ? "保存中…" : "保存修改"}
            </button>
          </div>
        </form>
      ) : displayedAnalysis ? (
        <>
          <p className="analysis-translation">{displayedAnalysis.translation ?? "（未提供译文）"}</p>
          <div className="analysis-tags">
            <span>{displayedAnalysis.tone ?? "（未提供）"}</span>
            <span>{displayedAnalysis.politeness ?? "（未提供）"}</span>
          </div>
          <div className="analysis-block">
            <strong>语法与结构</strong>
            <p>{displayedAnalysis.grammarSummary ?? "（未提供）"}</p>
          </div>
          {displayedAnalysis.impliedMeaning ? (
            <div className="analysis-block">
              <strong>潜台词</strong>
              <p>{displayedAnalysis.impliedMeaning}</p>
            </div>
          ) : null}
          {displayedAnalysis.replyReason ? (
            <div className="analysis-block">
              <strong>为什么这样接话</strong>
              <p>{displayedAnalysis.replyReason}</p>
            </div>
          ) : null}
          {displayedAnalysis.uncertaintyNote ? (
            <div className="analysis-uncertainty">
              <strong>不确定性</strong>
              <p>{displayedAnalysis.uncertaintyNote}</p>
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
  const [documents, setDocuments] = useState<MvpDocumentSummary[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<MvpDocument | null>(null);
  const [title, setTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [contentType, setContentType] = useState<ContentType>("article");
  const [targetLevel, setTargetLevel] = useState<TargetLevel>("auto");
  const [isLoading, setIsLoading] = useState(true);
  const [isLibraryLoading, setIsLibraryLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingAnalysis, setIsStartingAnalysis] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isEditingDocument, setIsEditingDocument] = useState(false);
  const [isSavingDocument, setIsSavingDocument] = useState(false);
  const [isSavingSegment, setIsSavingSegment] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<AnalysisProgress | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [retryingSegmentId, setRetryingSegmentId] = useState<string | null>(null);
  const [isLibraryOpen, setIsLibraryOpen] = useState(
    () => storedValue(libraryStorageKeys.open) !== "false"
  );
  const [librarySearch, setLibrarySearch] = useState(
    () => storedValue(libraryStorageKeys.search) ?? ""
  );
  const [libraryStatus, setLibraryStatus] = useState<LibraryStatus>(() => {
    const value = storedValue(libraryStorageKeys.status);
    return isLibraryStatus(value) ? value : "all";
  });
  const [error, setError] = useState<string | null>(null);
  const [llmBalance, setLlmBalance] = useState<LlmBalance | null>(null);

  useEffect(() => {
    void getHealth()
      .then((healthResponse) => {
        setHealth(healthResponse);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "无法连接到本机 API");
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  // 余额查询是附加信息：未配置 provider / 查询失败都静默降级为 null（UI 显示「余额未知」），
  // 不阻塞页面也不弹错误横幅。
  useEffect(() => {
    let cancelled = false;
    void getLlmBalance()
      .then((balance) => {
        if (!cancelled) {
          setLlmBalance(balance);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLlmBalance(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setIsLibraryLoading(true);
      void listDocuments({
        search: librarySearch,
        status: libraryStatus === "all" ? undefined : libraryStatus
      })
        .then((documentList) => {
          if (!cancelled) {
            setDocuments(documentList);
          }
        })
        .catch((reason: unknown) => {
          if (!cancelled) {
            setError(reason instanceof Error ? reason.message : "读取学习库失败");
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsLibraryLoading(false);
          }
        });
    }, librarySearch.trim().length > 0 ? 220 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [librarySearch, libraryStatus]);

  useEffect(() => {
    window.localStorage.setItem(libraryStorageKeys.open, String(isLibraryOpen));
  }, [isLibraryOpen]);

  useEffect(() => {
    window.localStorage.setItem(libraryStorageKeys.search, librarySearch);
  }, [librarySearch]);

  useEffect(() => {
    window.localStorage.setItem(libraryStorageKeys.status, libraryStatus);
  }, [libraryStatus]);

  async function refreshLibrary(): Promise<void> {
    const documentList = await listDocuments({
      search: librarySearch,
      status: libraryStatus === "all" ? undefined : libraryStatus
    });
    setDocuments(documentList);
  }

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
            listDocuments({
              search: librarySearch,
              status: libraryStatus === "all" ? undefined : libraryStatus
            })
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
  }, [analysisProgress?.status, selectedDocument?.id, librarySearch, libraryStatus]);

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
        contentType,
        targetLevel
      });
      setSelectedDocument(document);
      setSelectedSegmentId(document.segments[0]?.id ?? null);
      setSelectedTokenId(null);
      setAnalysisProgress(await getAnalysisProgress(document.id));
      void refreshLibrary().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "刷新学习库失败");
      });
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
      setContentType(documentContentType(document));
      setTargetLevel(document.targetLevel);
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

  async function handleCancelAnalysis(): Promise<void> {
    if (!selectedDocument) {
      return;
    }

    setIsCancelling(true);
    setError(null);
    try {
      const progress = await cancelDocumentAnalysis(selectedDocument.id);
      const [document, documentList] = await Promise.all([
        getDocument(selectedDocument.id),
        listDocuments({
          search: librarySearch,
          status: libraryStatus === "all" ? undefined : libraryStatus
        })
      ]);
      setAnalysisProgress(progress);
      setSelectedDocument(document);
      setDocuments(documentList);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "取消分析失败");
    } finally {
      setIsCancelling(false);
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

  async function handleSaveDocumentMetadata(input: {
    title: string;
    contentType: ContentType;
    targetLevel: TargetLevel;
  }): Promise<void> {
    if (!selectedDocument) {
      return;
    }

    setIsSavingDocument(true);
    setError(null);
    try {
      const document = await updateDocument(selectedDocument.id, input);
      setSelectedDocument(document);
      setContentType(document.contentType);
      setTargetLevel(document.targetLevel);
      setIsEditingDocument(false);
      void refreshLibrary().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "刷新学习库失败");
      });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "保存文章设置失败");
    } finally {
      setIsSavingDocument(false);
    }
  }

  async function handleSaveSegment(
    segmentId: string,
    speaker: string | null,
    analysis: SegmentAnalysisUpdateInput | null
  ): Promise<void> {
    setIsSavingSegment(true);
    setError(null);
    try {
      const updatedSegment = await updateSegment(segmentId, { speaker });
      let document = await getDocument(updatedSegment.documentId);
      if (analysis) {
        await updateSegmentAnalysis(segmentId, analysis);
        document = await getDocument(document.id);
      }
      setSelectedDocument(document);
      void refreshLibrary().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "刷新学习库失败");
      });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "保存句段修改失败");
    } finally {
      setIsSavingSegment(false);
    }
  }

  async function handleSaveToken(
    segmentId: string,
    override: TokenAnalysisOverride
  ): Promise<void> {
    setIsSavingSegment(true);
    setError(null);
    try {
      const segment = await updateSegmentAnalysis(segmentId, { tokens: [override] });
      const document = await getDocument(segment.documentId);
      setSelectedDocument(document);
      void refreshLibrary().catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "刷新学习库失败");
      });
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "保存词语修改失败");
    } finally {
      setIsSavingSegment(false);
    }
  }

  const selectedSegment = selectedDocument?.segments.find((segment) => segment.id === selectedSegmentId) ?? null;
  const selectedToken = selectedSegment?.analysis?.tokens.find((token) => token.tokenId === selectedTokenId) ?? null;
  const isAnalysisRunning = analysisProgress?.status === "analyzing"
    || selectedDocument?.status === "analyzing";

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
                    onClick={() => setIsEditingDocument((current) => !current)}
                    type="button"
                  >
                    {isEditingDocument ? "关闭设置" : "编辑设置"}
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
                      onClose={() => setSelectedTokenId(null)}
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
        </section>
      </main>
    </div>
  );
}
