import path from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  NIHONGO_HOST: z.string().min(1).default("127.0.0.1"),
  NIHONGO_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  NIHONGO_DATA_DIR: z.string().min(1).default(path.resolve(process.cwd(), "data")),
  LLM_PROVIDER: z.string().min(1).default("disabled"),
  TTS_PROVIDER: z.string().min(1).default("disabled")
});

const environment = environmentSchema.parse(process.env);

export const appConfig = {
  host: environment.NIHONGO_HOST,
  port: environment.NIHONGO_PORT,
  dataDirectory: path.resolve(environment.NIHONGO_DATA_DIR),
  databaseFile: path.resolve(environment.NIHONGO_DATA_DIR, "nihongonote.db"),
  llmProvider: environment.LLM_PROVIDER,
  ttsProvider: environment.TTS_PROVIDER
} as const;

export type AppConfig = typeof appConfig;
