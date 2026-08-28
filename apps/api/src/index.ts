import "dotenv/config";

import type { FastifyInstance } from "fastify";

import { createApp } from "./app.js";
import { appConfig } from "./config.js";

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
