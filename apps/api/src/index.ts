import "dotenv/config";

import type { FastifyInstance } from "fastify";

import { createApp } from "./app.js";
import { appConfig } from "./config.js";
import { observability } from "./observability.js";

// OBS-003：默认关闭；OBSERVABILITY_ENABLED=1 时写本机 JSONL（不含原文/译文/密钥）。
observability.configure(appConfig.observabilityEnabled, appConfig.observabilityLogFile);

let app: FastifyInstance | undefined;

try {
  app = await createApp(appConfig);
  await app.listen({
    host: appConfig.host,
    port: appConfig.port
  });
  app.log.info({
    provider: appConfig.llmProvider,
    protocol: appConfig.llmProtocol,
    model: appConfig.llmModel,
    thinkingType: appConfig.llmThinkingType ?? null,
    reasoningEffort: appConfig.llmReasoningEffort ?? null,
    maxTokens: appConfig.llmMaxTokens,
    batchSize: appConfig.llmBatchSize,
    batchConcurrency: appConfig.llmBatchConcurrency,
    timeoutMs: appConfig.llmTimeoutMs,
    debugLogging: appConfig.llmDebugLogging,
    debugLogFile: appConfig.llmDebugLogging ? appConfig.llmDebugLogFile : null
  }, "LLM provider runtime configuration");
} catch (error) {
  if (app) {
    app.log.error(error, "Unable to start NihongoNote API");
    await app.close();
  } else {
    console.error("Unable to start NihongoNote API", error);
  }
  process.exitCode = 1;
}
