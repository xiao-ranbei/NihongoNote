import { z } from "zod";

import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db/database.js";

/**
 * LLM 设置（设计文档 llm-settings-design.md）。
 *
 * 存储：app_settings 表（key-value，key="llm"，value=JSON）。
 * 优先级：db 覆盖 .env——.env 提供初始默认值，db 里有值的字段覆盖之；
 * 清空 db 设置（删除 llm 键）即回到 .env 行为。
 */

export const llmProviderNames = [
  "disabled",
  "ollama",
  "deepseek",
  "openai",
  "openai-compatible"
] as const;

export type LlmProviderName = (typeof llmProviderNames)[number];

export const segmentFieldProfiles = ["minimal", "standard", "full"] as const;

const thinkingTypes = ["enabled", "disabled"] as const;
const reasoningEfforts = ["minimal", "low", "medium", "high", "xhigh"] as const;

/** 与 config.ts 校验口径一致（LLM_TEMPERATURE 0-2、LLM_MAX_TOKENS 1-32000）。 */
const llmSettingsSchema = z.object({
  provider: z.enum(llmProviderNames),
  baseUrl: z.string().url(),
  apiKey: z.string().nullish(),
  model: z.string().min(1),
  temperature: z.coerce.number().min(0).max(2).default(0.2),
  maxTokens: z.coerce.number().int().min(1).max(32_000).default(12_000),
  segmentFields: z.enum(segmentFieldProfiles).default("standard"),
  thinkingType: z.enum(thinkingTypes).nullish(),
  reasoningEffort: z.enum(reasoningEfforts).nullish()
});

export type LlmSettings = z.infer<typeof llmSettingsSchema>;
export type LlmSettingsInput = z.input<typeof llmSettingsSchema>;

/** 解析并收紧运行时输入；unknown 输入（db 旧数据）也要能通过。 */
export function parseLlmSettings(value: unknown): LlmSettings {
  return llmSettingsSchema.parse(value);
}

/** 设置页不暴露的字段（batchSize/concurrency/timeoutMs 等保持 .env 控制，不在 LlmSettings 中）。 */

export interface LlmSettingsContext {
  /** 由 .env 推导的默认设置（含 deepseek 的 thinkingType 特殊默认）。 */
  defaults: LlmSettings;
  /** db 中已保存的部分字段（未设置的字段为 undefined）。 */
  stored: Partial<LlmSettings>;
  /** 逐字段来源：db / env。 */
  source: Record<keyof LlmSettings, "db" | "env">;
}

/** 从 AppConfig 推导 env 默认设置。 */
export function settingsDefaultsFromConfig(config: AppConfig): LlmSettings {
  return {
    // config.llmProvider 来自 env（宽松 string），运行时必然是合法 provider 名
    // （buildLlmProvider 对未知 provider 会抛错），此处窄化为枚举。
    provider: config.llmProvider as LlmProviderName,
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey ?? null,
    model: config.llmModel,
    temperature: config.llmTemperature,
    maxTokens: config.llmMaxTokens,
    segmentFields: config.llmSegmentFields,
    thinkingType: config.llmThinkingType ?? null,
    reasoningEffort: config.llmReasoningEffort ?? null
  };
}

/** db 覆盖 env：stored 有值的字段覆盖 defaults。 */
export function mergeLlmSettings(defaults: LlmSettings, stored: Partial<LlmSettings>): LlmSettings {
  // 泛型 key 索引赋值会让 TS 把目标类型算成交集（never），
  // 因此用 unknown 中间态逐字段写入，最后一次性收口。
  const merged = { ...defaults } as Record<keyof LlmSettings, unknown>;
  for (const key of Object.keys(stored) as Array<keyof LlmSettings>) {
    const value = stored[key];
    if (value !== undefined && value !== null) {
      merged[key] = value;
    }
  }
  return merged as LlmSettings;
}

function maskApiKey(key: string | null): string | null {
  if (!key || key.length <= 8) {
    return key;
  }
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** 构造 GET 响应：apiKey 回传 masked，并附逐字段来源。 */
export function settingsContext(
  config: AppConfig,
  database: AppDatabase
): LlmSettingsContext {
  const defaults = settingsDefaultsFromConfig(config);
  const row = database.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = ?",
    ["llm"]
  );
  let stored: Partial<LlmSettings> = {};
  if (row) {
    try {
      stored = parseLlmSettings(JSON.parse(row.value)) as Partial<LlmSettings>;
    } catch {
      // 损坏的 db 设置视为不存在，回到 .env
    }
  }
  const merged = mergeLlmSettings(defaults, stored);
  const source = {} as Record<keyof LlmSettings, "db" | "env">;
  for (const key of Object.keys(merged) as Array<keyof LlmSettings>) {
    const storedValue = stored[key];
    source[key] = storedValue !== undefined && storedValue !== null ? "db" : "env";
  }
  return { defaults, stored, source };
}

/** 保存前处理 apiKey：空 / masked 值视为「未修改」，保留库中原值。 */
export function resolveApiKey(input: LlmSettingsInput, stored: Partial<LlmSettings>): string | null {
  const raw = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  if (raw.length === 0) {
    return stored.apiKey ?? null;
  }
  const existing = stored.apiKey ?? null;
  if (existing && raw === maskApiKey(existing)) {
    return existing;
  }
  return raw;
}

export interface SettingsStore {
  load(): Partial<LlmSettings>;
  save(settings: LlmSettings): void;
}

export function createSettingsStore(database: AppDatabase): SettingsStore {
  return {
    load(): Partial<LlmSettings> {
      const row = database.get<{ value: string }>(
        "SELECT value FROM app_settings WHERE key = ?",
        ["llm"]
      );
      if (!row) {
        return {};
      }
      try {
        return parseLlmSettings(JSON.parse(row.value)) as Partial<LlmSettings>;
      } catch {
        return {};
      }
    },
    save(settings: LlmSettings): void {
      const payload = JSON.stringify(settings);
      database.transaction(() => {
        database.run("DELETE FROM app_settings WHERE key = ?", ["llm"]);
        database.run("INSERT INTO app_settings (key, value) VALUES (?, ?)", ["llm", payload]);
      });
    }
  };
}

export { maskApiKey };
