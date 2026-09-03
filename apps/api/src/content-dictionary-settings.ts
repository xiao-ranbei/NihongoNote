import { z } from "zod";

import type { AppDatabase } from "./db/database.js";
import {
  createContentDictionary,
  listContentDictionaryIds,
  type ContentDictionaryHolder,
  type ContentDictionaryProvider
} from "./dictionary/content/index.js";

/**
 * 内容词数据源设置（设计文档 jmdict-integration-design.md §6.5 阶段 A）。
 *
 * 存储：app_settings 表（key-value，key="contentDictionary"，value=JSON `{ id }`）。
 * 优先级：db 覆盖 .env——db 里有值则用 db，否则回退 .env 的 CONTENT_DICT_ID，再否则 none。
 * 与 LLM 设置（key="llm"）互不干扰、平行存储。
 *
 * 注意：fixture 是测试专用数据源，不暴露给设置页（前端下拉只列真实源）。
 */
const SETTINGS_KEY = "contentDictionary";

/** 设置页可见的真实数据源（排除测试用 fixture）。 */
export const VISIBLE_CONTENT_DICTIONARY_IDS = listContentDictionaryIds().filter(
  (id) => id !== "fixture"
);

const contentDictionarySettingsSchema = z.object({
  id: z.enum(
    // z.enum 需要字面量元组；用 as 收窄（id 来自注册表，运行时必然是合法值）
    VISIBLE_CONTENT_DICTIONARY_IDS as [string, ...string[]]
  )
});

export type ContentDictionarySettings = z.infer<typeof contentDictionarySettingsSchema>;
export type ContentDictionarySettingsInput = z.input<typeof contentDictionarySettingsSchema>;

/** 解析并收紧运行时输入；非法输入（未知 id）抛 ZodError，由路由转 400。 */
export function parseContentDictionarySettings(value: unknown): ContentDictionarySettings {
  return contentDictionarySettingsSchema.parse(value);
}

/** 设置页下拉项：{ id, label }（label 来自 provider 静态字段，不触发索引加载）。 */
export function availableContentDictionaries(): Array<{ id: string; label: string }> {
  return VISIBLE_CONTENT_DICTIONARY_IDS.map((id) => ({
    id,
    label: createContentDictionary(id).label
  }));
}

/** 单个 provider 的轻量状态（用于 GET 响应；current 已初始化，stats 实时可读）。 */
export interface ContentDictionarySourceState {
  id: string;
  label: string;
  ready: boolean;
  stats: ReturnType<ContentDictionaryProvider["stats"]>;
}

/** 构造 GET 响应：current（已初始化的 holder.current）+ available（静态列表）。 */
export function contentDictionaryState(
  holder: ContentDictionaryHolder
): {
  current: ContentDictionarySourceState;
  available: Array<{ id: string; label: string }>;
} {
  const current = holder.current;
  return {
    current: {
      id: current.id,
      label: current.label,
      ready: current.ready(),
      stats: current.stats()
    },
    available: availableContentDictionaries()
  };
}

/** 读取 db 中已保存的数据源设置（损坏/缺失视为无 = 回退 env/none）。 */
export function loadContentDictionarySettings(
  database: AppDatabase
): ContentDictionarySettings | null {
  const row = database.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = ?",
    [SETTINGS_KEY]
  );
  if (!row) {
    return null;
  }
  try {
    return contentDictionarySettingsSchema.parse(JSON.parse(row.value)) as ContentDictionarySettings;
  } catch {
    return null;
  }
}

/** 写库（覆盖式：先删后插，与 LLM 设置同款事务语义）。 */
export function saveContentDictionarySettings(
  database: AppDatabase,
  settings: ContentDictionarySettings
): void {
  const payload = JSON.stringify(settings);
  database.transaction(() => {
    database.run("DELETE FROM app_settings WHERE key = ?", [SETTINGS_KEY]);
    database.run(
      "INSERT INTO app_settings (key, value) VALUES (?, ?)",
      [SETTINGS_KEY, payload]
    );
  });
}
