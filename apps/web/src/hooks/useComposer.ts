import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction
} from "react";

import type { AnalysisProgress, ContentType, TargetLevel } from "@nihongonote/core";

import { createDocument, getAnalysisProgress } from "../api/client";
import type { MvpDocument } from "../lib/constants";

/**
 * 新建材料表单（M1.1 拆出的第 4 个 hook）。
 *
 * 职责：标题/原文/内容类型/解释等级与保存中状态，以及提交动作。
 *
 * 与 App 的边界：
 * - 建好的文章**不在这里落地**——通过 `onCreated` 交给上层去选中（会话状态归 useReadingSession）；
 * - 学习库刷新也由上层决定（`onLibraryChanged`），hook 之间不互相订阅。
 *
 * `onError` 收 `string | null`：传 null 表示"清空旧的错误横幅"。提交动作在开始时清错误、
 * 失败时写错误，两者都经过同一个回调，所以签名必须同时容纳 null。
 */
export interface ComposerController {
  title: string;
  setTitle: Dispatch<SetStateAction<string>>;
  sourceText: string;
  setSourceText: Dispatch<SetStateAction<string>>;
  contentType: ContentType;
  setContentType: Dispatch<SetStateAction<ContentType>>;
  targetLevel: TargetLevel;
  setTargetLevel: Dispatch<SetStateAction<TargetLevel>>;
  isSaving: boolean;
  /** 表单提交：校验 → 建文 → 取进度 → 交给上层 → 清空输入。 */
  submit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  /** 清空表单并复位默认类型（新建材料 / 切换文章时调用）。 */
  reset: () => void;
}

export interface UseComposerOptions {
  /** 建文成功后回调（带上初始进度，避免上层再请求一次）。 */
  onCreated: (document: MvpDocument, progress: AnalysisProgress | null) => void;
  onError: (message: string | null) => void;
  /** 建文成功后需要刷新学习库列表。 */
  onLibraryChanged: () => void;
}

export function useComposer(options: UseComposerOptions): ComposerController {
  const [title, setTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [contentType, setContentType] = useState<ContentType>("article");
  const [targetLevel, setTargetLevel] = useState<TargetLevel>("auto");
  const [isSaving, setIsSaving] = useState(false);

  // 回调统一用 ref 持有：调用方不必操心稳定性，submit 也不会因 props 变化而重建。
  const onCreatedRef = useRef(options.onCreated);
  onCreatedRef.current = options.onCreated;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const onLibraryChangedRef = useRef(options.onLibraryChanged);
  onLibraryChangedRef.current = options.onLibraryChanged;

  const reset = useCallback((): void => {
    setTitle("");
    setSourceText("");
    setContentType("article");
    setTargetLevel("auto");
  }, []);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (!sourceText.trim()) {
        onErrorRef.current("请先粘贴一段日语文章或对话");
        return;
      }

      setIsSaving(true);
      onErrorRef.current(null);
      try {
        const document = await createDocument({
          title: title.trim() || undefined,
          sourceText,
          contentType,
          targetLevel
        });
        const progress = await getAnalysisProgress(document.id);
        onCreatedRef.current(document, progress);
        onLibraryChangedRef.current();
        setTitle("");
        setSourceText("");
      } catch (reason: unknown) {
        onErrorRef.current(reason instanceof Error ? reason.message : "保存文章失败");
      } finally {
        setIsSaving(false);
      }
    },
    [title, sourceText, contentType, targetLevel]
  );

  return {
    title,
    setTitle,
    sourceText,
    setSourceText,
    contentType,
    setContentType,
    targetLevel,
    setTargetLevel,
    isSaving,
    submit,
    reset
  };
}
