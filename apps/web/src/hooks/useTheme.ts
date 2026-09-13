import { useEffect, useState } from "react";

import {
  isThemePreference,
  resolveThemeName,
  storedValue,
  themeStorageKey
} from "../lib/storage";

/**
 * 主题偏好（M1.1 从 App.tsx 拆出的第一个 hook，零耦合）。
 *
 * 职责：读取本机偏好 → 应用到 `data-theme` → 持久化；`auto` 时跟随系统深色模式。
 * 拆出来的直接影响：主题相关的读写不再参与 App 本体的状态编排。
 */
export interface ThemeController {
  themePreference: string;
  setThemePreference: (next: string) => void;
}

export function useTheme(): ThemeController {
  const [themePreference, setThemePreference] = useState<string>(() => {
    const value = storedValue(themeStorageKey);
    return isThemePreference(value) ? value : "auto";
  });

  /*
   * 主题持久化 + 系统深色跟随（I-14）。
   * auto 时仍监听媒体查询，系统切换深色即刻生效，无需刷新。
   */
  useEffect(() => {
    const applyTheme = (): void => {
      document.documentElement.dataset.theme = resolveThemeName(themePreference);
    };
    applyTheme();
    window.localStorage.setItem(themeStorageKey, themePreference);
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themePreference]);

  return { themePreference, setThemePreference };
}
