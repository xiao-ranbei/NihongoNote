import { z } from "zod";

import type { AppDatabase } from "./db/database.js";
import type { GlossTranslator } from "./dictionary/content/translator.js";

/**
 * 译中（阶段 B）开关设置（设计文档 jmdict-integration-design.md §6.5）。
 *
 * 存储：app_settings 表（key-value，key="glossTranslation"，value=JSON `{ enabled }`）。
 * 优先级：db 覆盖 .env——db 里有值则用 db，否则回退 .env 的 CONTENT_DICT_TRANSLATE_ENABLED，
 * 再否则默认开。与 LLM / 内容词数据源设置平行存储、互不干扰。
 *
 * 译中仅本地 Ollama 推理、零云端费用；Ollama 未启动或翻译失败回退英文，不阻断分析。
 * 设置页保存后经 translator.setEnabled 热切换，无需重启。
 */
const SETTINGS_KEY = "glossTranslation";

const glossTranslationSettingsSchema = z.object({
  enabled: z.boolean()
});

export type GlossTranslationSettings = z.infer<typeof glossTranslationSettingsSchema>;
export type GlossTranslationSettingsInput = z.input<typeof glossTranslationSettingsSchema>;

/** 解析并收紧运行时输入；非法输入抛 ZodError，由路由转 400。 */
export function parseGlossTranslationSettings(value: unknown): GlossTranslationSettings {
  return glossTranslationSettingsSchema.parse(value);
}

/** 构造 GET 响应：当前开关 + Ollama 可用性（实时探活，不抛错）。 */
export async function glossTranslationState(
  translator: GlossTranslator
): Promise<{ enabled: boolean; available: boolean }> {
  const available = await translator.isAvailable();
  return { enabled: translator.isEnabled(), available };
}

/** 读取 db 中已保存的译中设置（损坏/缺失视为无 = 回退 env/默认开）。 */
export function loadGlossTranslationSettings(
  database: AppDatabase
): GlossTranslationSettings | null {
  const row = database.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = ?",
    [SETTINGS_KEY]
  );
  if (!row) {
    return null;
  }
  try {
    return glossTranslationSettingsSchema.parse(JSON.parse(row.value)) as GlossTranslationSettings;
  } catch {
    return null;
  }
}

/** 写库（覆盖式：先删后插，与 LLM / 内容词设置同款事务语义）。 */
export function saveGlossTranslationSettings(
  database: AppDatabase,
  settings: GlossTranslationSettings
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
