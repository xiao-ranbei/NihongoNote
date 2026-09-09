import type { ContentType, DocumentDetail, LlmBalance } from "@nihongonote/core";

import { contentTypeLabels } from "./constants";

/**
 * 纯格式化与浏览器副作用工具（S0 拆分自 App.tsx）。
 *
 * 全部为无状态函数，不依赖 React，便于单测与复用。
 */

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function statusLabel(
  status: DocumentDetail["status"] | DocumentDetail["segments"][number]["status"]
): string {
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

export function contentTypeLabel(value: ContentType | null | undefined): string {
  return value ? contentTypeLabels[value] : "未选择类型";
}

/** 余额取第一个币种条目展示（当前 DeepSeek 只返回 CNY）。 */
export function balanceSummary(balance: LlmBalance | null): string | null {
  const entry = balance?.entries[0];
  return entry ? `${entry.currency} ${entry.totalBalance}` : null;
}

/** 金额很小（一次分析通常不足 1 元），小额显示 4 位小数，大额显示 2 位。 */
export function formatCost(cost: number): string {
  return cost >= 1 ? `¥${cost.toFixed(2)}` : `¥${cost.toFixed(4)}`;
}

/** 去掉文件系统非法字符，避免 Windows/macOS 下载失败；空标题回退默认名。 */
export function safeFileStem(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\r\n\t]/gu, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "nihongonote";
}

export function fileStamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** 浏览器端触发下载；用完立即释放 object URL，避免长会话内存泄漏。 */
export function downloadFile(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 空串归一为 null：编辑表单里「清空」要真的清掉，而不是存一个空字符串。 */
export function optionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
