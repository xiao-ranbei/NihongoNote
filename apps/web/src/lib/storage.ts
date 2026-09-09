import type { LibraryStatus } from "./constants";

/**
 * 本机偏好持久化（S0 拆分自 App.tsx）。
 *
 * 学习库折叠态 / 搜索词 / 状态筛选与主题偏好都存 localStorage，
 * 刷新或重开应用后保持（需求 1.3）。读写都做了「非浏览器环境」保护，
 * 便于将来做 SSR 或单测时不炸。
 */

const libraryStorageKeys = {
  open: "nihongonote.library.open",
  search: "nihongonote.library.search",
  status: "nihongonote.library.status"
} as const;

export { libraryStorageKeys };

export function storedValue(key: string): string | null {
  return typeof window === "undefined" ? null : window.localStorage.getItem(key);
}

export function isLibraryStatus(value: string | null): value is LibraryStatus {
  return value === "draft"
    || value === "analyzing"
    || value === "ready"
    || value === "failed";
}

/* ---------------- 主题（设计文档 theme-system.md，issues I-14） ---------------- */

export const themeStorageKey = "nn-theme";

/**
 * 六套主题对应六个 UI 提案（theme-system.md 第二节）。
 * `auto` 不是主题名，而是「跟随系统深色偏好」的偏好标记。
 */
export const themeOptions: Array<{ value: string; label: string }> = [
  { value: "auto", label: "主题：跟随系统" },
  { value: "paper", label: "纸感（默认）" },
  { value: "night", label: "夜间" },
  { value: "minimal", label: "极简" },
  { value: "magazine", label: "杂志" },
  { value: "workbench", label: "工作台" },
  { value: "notebook", label: "手帐" }
];

const themeNames = new Set(
  themeOptions.filter((option) => option.value !== "auto").map((option) => option.value)
);

/** 类型守卫：窄化后调用方可直接把 localStorage 值当作有效偏好使用。 */
export function isThemePreference(value: string | null): value is string {
  return value !== null && (value === "auto" || themeNames.has(value));
}

/** auto → 跟随 `prefers-color-scheme`；其余返回主题名（非法值回退 paper）。 */
export function resolveThemeName(preference: string): string {
  if (preference !== "auto") {
    return themeNames.has(preference) ? preference : "paper";
  }
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "paper";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "paper";
}
