import type {
  ContentType,
  DocumentDetail,
  DocumentSummary,
  TargetLevel,
  TokenCategory
} from "@nihongonote/core";

/**
 * 阅读器通用常量与类型（S0 拆分自 App.tsx）。
 *
 * 只放「数据」与极小的派生函数，不放组件、不放状态：
 * 任何模块都可以安全依赖这里，不会形成循环引用。
 */

export type LibraryStatus = "all" | DocumentDetail["status"];
export type MvpDocument = DocumentDetail;
export type MvpDocumentSummary = DocumentSummary;

/** 单个句段视图类型（含 analysis / originalAnalysis / userRevision）。 */
export type Segment = DocumentDetail["segments"][number];

export const levelOptions: Array<{ value: TargetLevel; label: string }> = [
  { value: "auto", label: "自动判断" },
  { value: "n5", label: "N5" },
  { value: "n4", label: "N4" },
  { value: "n3", label: "N3" },
  { value: "n2", label: "N2" },
  { value: "n1", label: "N1" }
];

export const contentTypeOptions: Array<{ value: ContentType; label: string }> = [
  { value: "lesson", label: "课文" },
  { value: "article", label: "普通文章" },
  { value: "dialogue", label: "对话" },
  { value: "news_expository", label: "新闻 / 说明文" },
  { value: "note", label: "笔记" },
  { value: "other", label: "其他" }
];

export const contentTypeLabels: Record<ContentType, string> = {
  lesson: "课文",
  article: "普通文章",
  dialogue: "对话",
  news_expository: "新闻 / 说明文",
  note: "笔记",
  other: "其他"
};

export const tokenCategoryLabels: Record<TokenCategory, string> = {
  word: "词语",
  particle: "助词",
  functional: "功能词",
  adverb: "副词",
  grammar: "语法"
};

/** 导出格式标记：日后 schema 变更时，导入/迁移脚本可据此自判。 */
export const exportFormatVersion = 1;

export function documentContentType(document: MvpDocument): ContentType {
  return document.contentType;
}
