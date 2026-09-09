import type { ContentType, TargetLevel } from "@nihongonote/core";
import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import type { MvpDocument } from "../lib/constants";
import {
  contentTypeOptions,
  documentContentType,
  levelOptions
} from "../lib/constants";
import { contentTypeLabel } from "../lib/format";

/**
 * 文章元数据编辑（S0 拆分自 App.tsx）。
 *
 * 标题 / 内容类型 / 解释等级。系统自动识别的类型只作为建议展示，
 * 最终以用户手动选择为准（需求 1.2）。
 */

export function DocumentMetadataEditor({
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
