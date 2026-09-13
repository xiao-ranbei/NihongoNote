import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";

import { listDocuments } from "../api/client";
import type { LibraryStatus, MvpDocumentSummary } from "../lib/constants";
import { isLibraryStatus, libraryStorageKeys, storedValue } from "../lib/storage";

/**
 * 学习库（M1.1 从 App.tsx 拆出的第 2 个 hook）。
 *
 * 职责：列表加载（搜索词 220ms 防抖）、搜索/状态筛选、折叠状态，以及三者的本机持久化。
 *
 * 与 App 的边界：本 hook 不认识「当前打开的文章」，也不主动刷新——
 * 分析结束、保存文章等时机由调用方显式调用 `refreshLibrary()`，
 * 这样避免了 hook 之间相互订阅导致的循环依赖。
 */
export interface LibraryController {
  documents: MvpDocumentSummary[];
  isLibraryLoading: boolean;
  isLibraryOpen: boolean;
  setIsLibraryOpen: Dispatch<SetStateAction<boolean>>;
  librarySearch: string;
  setLibrarySearch: Dispatch<SetStateAction<string>>;
  libraryStatus: LibraryStatus;
  setLibraryStatus: Dispatch<SetStateAction<LibraryStatus>>;
  /** 按当前搜索词与状态重新拉取列表。 */
  refreshLibrary: () => Promise<void>;
}

export interface UseLibraryOptions {
  /** 读取失败时上报（App 统一渲染错误横幅）。 */
  onError: (message: string) => void;
}

export function useLibrary({ onError }: UseLibraryOptions): LibraryController {
  const [documents, setDocuments] = useState<MvpDocumentSummary[]>([]);
  const [isLibraryLoading, setIsLibraryLoading] = useState(false);
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

  // onError 用 ref 持有：调用方不必操心「回调是否稳定」，加载 effect 也不会因此重跑。
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refreshLibrary = useCallback(async (): Promise<void> => {
    const documentList = await listDocuments({
      search: librarySearch,
      status: libraryStatus === "all" ? undefined : libraryStatus
    });
    setDocuments(documentList);
  }, [librarySearch, libraryStatus]);

  // 搜索/筛选变化时自动加载；只有非空搜索词才防抖，避免清空时多等 220ms。
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
            onErrorRef.current(reason instanceof Error ? reason.message : "读取学习库失败");
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

  return {
    documents,
    isLibraryLoading,
    isLibraryOpen,
    setIsLibraryOpen,
    librarySearch,
    setLibrarySearch,
    libraryStatus,
    setLibraryStatus,
    refreshLibrary
  };
}
