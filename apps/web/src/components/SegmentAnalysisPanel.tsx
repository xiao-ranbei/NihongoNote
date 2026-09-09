import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import type { SegmentAnalysisUpdateInput } from "../api/client";
import type { Segment } from "../lib/constants";
import { optionalText } from "../lib/format";

/**
 * 句段解析面板（S0 拆分自 App.tsx）。
 *
 * 展示/编辑整句译文、语法、语气、潜台词、接话理由与不确定性；
 * 有人工修正时可在「用户版本 / AI 原始」之间切换（需求 1.3：修正不得覆盖 AI 原版）。
 */

export function SegmentAnalysisPanel({
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
  const [draftRegister, setDraftRegister] = useState("");
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
    setDraftRegister(segment.analysis?.register ?? "");
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
          register: draftRegister.trim(),
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
              <label>
                语气与礼貌（合并，标准档）
                <input
                  onChange={(event) => setDraftRegister(event.target.value)}
                  value={draftRegister}
                />
              </label>
              <div className="segment-editor-grid">
                <label>
                  语气 / 态度（完整档）
                  <input
                    onChange={(event) => setDraftTone(event.target.value)}
                    required
                    value={draftTone}
                  />
                </label>
                <label>
                  礼貌程度（完整档）
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
          {displayedAnalysis.register ? (
            <div className="analysis-tags">
              <span>{displayedAnalysis.register}</span>
            </div>
          ) : (
            <div className="analysis-tags">
              <span>{displayedAnalysis.tone ?? "（未提供）"}</span>
              <span>{displayedAnalysis.politeness ?? "（未提供）"}</span>
            </div>
          )}
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
