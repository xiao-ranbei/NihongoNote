import path from "node:path";
import { z } from "zod";

const optionalStringSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim().length === 0 ? undefined : value,
  z.string().min(1).optional()
);

const optionalPositiveNumberSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim().length === 0 ? undefined : value,
  z.coerce.number().positive().optional()
);

const optionalThinkingTypeSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim().length === 0 ? undefined : value,
  z.enum(["enabled", "disabled"]).optional()
);

const optionalReasoningEffortSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim().length === 0 ? undefined : value,
  // 默认 minimal：用户实测 medium 下 30 句段要 10–20 分钟（推理 token 占输出 72.8%），
  // 2026-08-29 深夜用户拍板降档；降档后的质量以两篇样本回归为准。
  z.enum(["minimal", "low", "medium", "high", "xhigh"]).default("minimal")
);

const optionalSegmentFieldProfileSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim().length === 0 ? undefined : value,
  // 段级语义字段档位（设计文档 3.8）：minimal 最省 / standard 默认 / full 全部 7 字段。
  z.enum(["minimal", "standard", "full"]).default("standard")
);

const booleanEnvironmentSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return value;
}, z.boolean().default(false));

const environmentSchema = z.object({
  NIHONGO_HOST: z.string().min(1).default("127.0.0.1"),
  NIHONGO_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  NIHONGO_DATA_DIR: z.string().min(1).default(path.resolve(process.cwd(), "data")),
  LLM_PROVIDER: z.string().min(1).default("disabled"),
  LLM_PROTOCOL: z.enum(["openai", "anthropic"]).default("openai"),
  LLM_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  LLM_API_KEY: optionalStringSchema,
  LLM_MODEL: z.string().min(1).default("deepseek-v4-flash"),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().max(32_000).default(12_000),
  LLM_BATCH_SIZE: z.coerce.number().int().min(1).max(10).default(3),
  LLM_BATCH_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(2),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(300_000),
  LLM_PROMPT_VERSION: z.string().min(1).default("analysis-v3"),
  LLM_THINKING_TYPE: optionalThinkingTypeSchema,
  LLM_REASONING_EFFORT: optionalReasoningEffortSchema,
  LLM_SEGMENT_FIELDS: optionalSegmentFieldProfileSchema,
  LLM_DEBUG_LOGGING: booleanEnvironmentSchema,
  LLM_DEBUG_LOG_FILE: optionalStringSchema,
  TTS_PROVIDER: z.string().min(1).default("disabled"),
  TTS_VOICE: optionalStringSchema,
  TTS_SPEED: optionalPositiveNumberSchema,
  TTS_FORMAT: optionalStringSchema,
  TTS_SSML_VERSION: optionalStringSchema
});

const environment = environmentSchema.parse(process.env);

export const appConfig = {
  host: environment.NIHONGO_HOST,
  port: environment.NIHONGO_PORT,
  dataDirectory: path.resolve(environment.NIHONGO_DATA_DIR),
  databaseFile: path.resolve(environment.NIHONGO_DATA_DIR, "nihongonote.db"),
  llmProvider: environment.LLM_PROVIDER,
  llmProtocol: environment.LLM_PROTOCOL,
  llmBaseUrl: environment.LLM_BASE_URL,
  llmApiKey: environment.LLM_API_KEY,
  llmModel: environment.LLM_MODEL,
  llmTemperature: environment.LLM_TEMPERATURE,
  llmMaxTokens: environment.LLM_MAX_TOKENS,
  llmBatchSize: environment.LLM_BATCH_SIZE,
  llmBatchConcurrency: environment.LLM_BATCH_CONCURRENCY,
  llmTimeoutMs: environment.LLM_TIMEOUT_MS,
  llmPromptVersion: environment.LLM_PROMPT_VERSION,
  llmThinkingType: environment.LLM_THINKING_TYPE
    ?? (environment.LLM_PROVIDER === "deepseek" ? "enabled" : undefined),
  llmReasoningEffort: environment.LLM_REASONING_EFFORT,
  llmSegmentFields: environment.LLM_SEGMENT_FIELDS,
  llmDebugLogging: environment.LLM_DEBUG_LOGGING,
  llmDebugLogFile: path.resolve(
    environment.LLM_DEBUG_LOG_FILE
      ?? path.resolve(environment.NIHONGO_DATA_DIR, "llm-debug.jsonl")
  ),
  ttsProvider: environment.TTS_PROVIDER,
  ttsVoice: environment.TTS_VOICE,
  ttsSpeed: environment.TTS_SPEED,
  ttsFormat: environment.TTS_FORMAT,
  ttsSsmlVersion: environment.TTS_SSML_VERSION
} as const;

export type AppConfig = typeof appConfig;
