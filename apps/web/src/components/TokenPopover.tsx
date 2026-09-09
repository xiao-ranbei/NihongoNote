import type { TokenAnalysis, TokenAnalysisOverride } from "@nihongonote/core";
import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import { tokenCategoryLabels } from "../lib/constants";
import { optionalText } from "../lib/format";
import { getTokenCategory } from "../lib/tokens";

/**
 * 词语解析卡（S0 拆分自 App.tsx）。
 *
 * 展示与编辑单个 token 的事实字段。人工修正写入 `userRevision`，
 * 不覆盖 AI 原始响应（需求 1.3）。
 */

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

export function TokenPopover({
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
