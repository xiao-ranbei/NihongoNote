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
}).extend({
  // 多配置管理（2026-08-30）：一组可保存、可切换的模型配置。
  // 均为可选——旧数据（单组设置）没有这两个字段也能通过 parse，由 ensureLlmProfiles 迁移。
  profiles: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: z.enum(llmProviderNames),
    baseUrl: z.string().url(),
    apiKey: z.string().nullish(),
    model: z.string().min(1),
    temperature: z.coerce.number().min(0).max(2).default(0.2),
    maxTokens: z.coerce.number().int().min(1).max(32_000).default(12_000),
    segmentFields: z.enum(segmentFieldProfiles).default("standard"),
    thinkingType: z.enum(thinkingTypes).nullish(),
    reasoningEffort: z.enum(reasoningEfforts).nullish()
  })).optional(),
  activeProfileId: z.string().optional()
});

export type LlmSettings = z.infer<typeof llmSettingsSchema>;
export type LlmSettingsInput = z.input<typeof llmSettingsSchema>;

/** 一组完整的模型配置（多配置管理中的一个槽位）。 */
export type LlmProfile = NonNullable<LlmSettings["profiles"]>[number];

/** 解析并收紧运行时输入；unknown 输入（db 旧数据）也要能通过。 */
export function parseLlmSettings(value: unknown): LlmSettings {
  return llmSettingsSchema.parse(value);
}

/* ---------------- 多配置管理（profiles） ---------------- */

/** 内置配置的固定 id，迁移/预设时复用。 */
export const BUILTIN_PROFILE_IDS = {
  deepseek: "profile-deepseek",
  ollama: "profile-ollama"
} as const;

/**
 * 内置双配置：DeepSeek 云端 + 本地 Ollama（qwen3.5:9b）。
 * 新用户（无 db 设置）与旧数据迁移都会得到这两组，开箱即用。
 * apiKey 一律为 null，由用户在设置页填写（Ollama 本地无需 key）。
 */
export function builtinLlmProfiles(): LlmProfile[] {
  return [
    {
      id: BUILTIN_PROFILE_IDS.deepseek,
      name: "DeepSeek 云端",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: null,
      model: "deepseek-chat",
      temperature: 0.2,
      maxTokens: 12_000,
      segmentFields: "standard",
      thinkingType: "enabled",
      reasoningEffort: "minimal"
    },
    {
      id: BUILTIN_PROFILE_IDS.ollama,
      name: "本地 Ollama",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: null,
      model: "qwen3.5:9b",
      temperature: 0.2,
      maxTokens: 12_000,
      segmentFields: "standard",
      thinkingType: null,
      reasoningEffort: null
    }
  ];
}

/**
 * 迁移旧数据 / 兜底 profiles：
 * - 已有 profiles → 原样返回，activeProfileId 无效时回退到第一个；
 * - 无 profiles（旧单组数据或全新用户）→ 生成内置双配置：
 *   · 当前 provider 匹配内置预设，且 baseUrl/model 仍是内置默认值（用户未自定义）→
 *     直接激活对应内置配置（并把 db 中已有 apiKey 迁移过去）；
 *   · 否则把当前生效配置保留为「自定义配置」并激活，同时补上内置双配置。
 */
export function ensureLlmProfiles(
  stored: Partial<LlmSettings>
): { profiles: LlmProfile[]; activeProfileId: string } {
  const defaults = builtinLlmProfiles();
  if (Array.isArray(stored.profiles) && stored.profiles.length > 0) {
    const activeProfileId = stored.profiles.some((p) => p.id === stored.activeProfileId)
      ? stored.activeProfileId!
      : stored.profiles[0]!.id;
    return { profiles: stored.profiles, activeProfileId };
  }

  const matched = defaults.find((p) => p.provider === stored.provider);
  const usesBuiltinDefaults = matched !== undefined
    && stored.baseUrl === matched.baseUrl
    && stored.model === matched.model;
  const hasCustomConnection = Boolean(stored.baseUrl && stored.model) && !usesBuiltinDefaults;

  if (!hasCustomConnection) {
    const active = matched ?? defaults[0]!;
    const profiles = defaults.map((p) => (
      p.id === active.id && stored.apiKey ? { ...p, apiKey: stored.apiKey } : p
    ));
    return { profiles, activeProfileId: active.id };
  }

  const current: LlmProfile = {
    id: "profile-current",
    name: "自定义配置",
    provider: stored.provider ?? "openai-compatible",
    baseUrl: stored.baseUrl!,
    apiKey: stored.apiKey ?? null,
    model: stored.model!,
    temperature: stored.temperature ?? 0.2,
    maxTokens: stored.maxTokens ?? 12_000,
    segmentFields: stored.segmentFields ?? "standard",
    thinkingType: stored.thinkingType ?? null,
    reasoningEffort: stored.reasoningEffort ?? null
  };
  return { profiles: [current, ...defaults], activeProfileId: current.id };
}

/** PUT 保存的归一化结果。 */
export interface ResolvedSettingsSave {
  /** 写入 db 的完整设置（顶层字段 = 激活配置；含 profiles/activeProfileId）。 */
  settings: LlmSettings;
  /** 全部已保存配置（apiKey 已按保留规则收紧）。 */
  profiles: LlmProfile[];
  /** 当前激活的配置 id。 */
  activeProfileId: string;
}

/**
 * 多配置保存归一化（routes/llm.ts PUT 的核心逻辑，抽为纯函数便于验证）：
 * - 逐 profile 处理 apiKey（空 / masked = 保留库中原值）；
 * - 激活配置 = 请求指定（且存在）→ 用它；否则回退存储的激活项 / 第一个；
 * - 顶层生效字段始终以激活配置为准，保证「已保存配置」与「当前生效」不脱节；
 * - 兼容旧单组请求（无 profiles）：展开字段写回激活配置（profiles[0]），保持单组保存语义。
 */
export function resolveSettingsSave(
  parsed: LlmSettings,
  stored: Partial<LlmSettings>
): ResolvedSettingsSave {
  const { profiles: storedProfiles, activeProfileId: storedActiveId } = ensureLlmProfiles(stored);
  const hasIncomingProfiles = Array.isArray(parsed.profiles) && parsed.profiles.length > 0;
  const baseProfiles: LlmProfile[] = hasIncomingProfiles ? parsed.profiles! : storedProfiles;

  const profiles: LlmProfile[] = baseProfiles.map((profile) => {
    const prev = storedProfiles.find((p) => p.id === profile.id);
    return {
      ...profile,
      apiKey: resolveApiKey({ apiKey: profile.apiKey ?? undefined }, prev ?? {})
    };
  });

  let activeProfileId = profiles.some((p) => p.id === parsed.activeProfileId)
    ? parsed.activeProfileId!
    : storedProfiles.some((p) => p.id === storedActiveId)
      ? storedActiveId
      : profiles[0]!.id;
  let active = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]!;

  if (!hasIncomingProfiles) {
    // 兼容旧单组请求：展开字段写回激活配置（profiles[0]），并处理顶层 apiKey 保留
    const topApiKey = resolveApiKey(parsed, stored);
    const base = profiles[0]!;
    const target: LlmProfile = {
      id: base.id,
      name: base.name,
      provider: parsed.provider,
      baseUrl: parsed.baseUrl,
      model: parsed.model,
      temperature: parsed.temperature,
      maxTokens: parsed.maxTokens,
      segmentFields: parsed.segmentFields,
      thinkingType: parsed.thinkingType ?? null,
      reasoningEffort: parsed.reasoningEffort ?? null,
      apiKey: topApiKey ?? null
    };
    activeProfileId = target.id;
    profiles.splice(0, 1, target);
    active = target;
  }

  const settings: LlmSettings = {
    provider: active.provider,
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
    temperature: active.temperature,
    maxTokens: active.maxTokens,
    segmentFields: active.segmentFields,
    thinkingType: active.thinkingType ?? null,
    reasoningEffort: active.reasoningEffort ?? null,
    profiles,
    activeProfileId
  };
  return { settings, profiles, activeProfileId };
}

/** 设置页不暴露的字段（batchSize/concurrency/timeoutMs 等保持 .env 控制，不在 LlmSettings 中）。 */

export interface LlmSettingsContext {
  /** 由 .env 推导的默认设置（含 deepseek 的 thinkingType 特殊默认）。 */
  defaults: LlmSettings;
  /** db 中已保存的部分字段（未设置的字段为 undefined）。 */
  stored: Partial<LlmSettings>;
  /** 逐字段来源：db / env（profiles/activeProfileId 不计入）。 */
  source: Record<keyof LlmSettings, "db" | "env">;
  /** 全部已保存配置（apiKey 已 masked）。 */
  profiles: LlmProfile[];
  /** 当前激活的配置 id。 */
  activeProfileId: string;
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
    if (key === "profiles" || key === "activeProfileId") {
      continue; // 多配置字段不参与 db/env 来源标记
    }
    const storedValue = stored[key];
    source[key] = storedValue !== undefined && storedValue !== null ? "db" : "env";
  }
  const { profiles, activeProfileId } = ensureLlmProfiles(stored);
  return {
    defaults,
    stored,
    source,
    profiles: profiles.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey ?? null) })),
    activeProfileId
  };
}

/** 保存前处理 apiKey：空 / masked 值视为「未修改」，保留库中原值。input 只需含 apiKey 字段（顶层或 profile 级均可用）。 */
export function resolveApiKey(
  input: { apiKey?: string | null | undefined },
  stored: Partial<LlmSettings>
): string | null {
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
