import path from "node:path";
import { z } from "zod";

const optionalSecretSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim().length === 0 ? undefined : value,
  z.string().min(1).optional()
);

const environmentSchema = z.object({
  NIHONGO_HOST: z.string().min(1).default("127.0.0.1"),
  NIHONGO_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  NIHONGO_DATA_DIR: z.string().min(1).default(path.resolve(process.cwd(), "data")),
  LLM_PROVIDER: z.string().min(1).default("disabled"),
  LLM_PROTOCOL: z.enum(["openai", "anthropic"]).default("openai"),
  LLM_BASE_URL: z.string().url().default("https://api.deepseek.com"),
  LLM_API_KEY: optionalSecretSchema,
  LLM_MODEL: z.string().min(1).default("deepseek-v4-pro"),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().max(32_000).default(4_000),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(60_000),
  LLM_PROMPT_VERSION: z.string().min(1).default("analysis-v1"),
  TTS_PROVIDER: z.string().min(1).default("disabled")
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
  llmTimeoutMs: environment.LLM_TIMEOUT_MS,
  llmPromptVersion: environment.LLM_PROMPT_VERSION,
  ttsProvider: environment.TTS_PROVIDER
} as const;

export type AppConfig = typeof appConfig;
