import Fastify, { type FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { createDatabase } from "./db/database.js";
import { createProviderRegistry } from "./providers/registry.js";
import { createContentDictionaryHolder } from "./dictionary/content/index.js";
import { DocumentRepository } from "./repositories/document-repository.js";
import { AnalysisService } from "./services/analysis-service.js";
import { registerAnalysisRoutes } from "./routes/analysis.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerLlmRoutes } from "./routes/llm.js";

export async function createApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true
  });
  const providers = createProviderRegistry(config);
  const database = await createDatabase(config.databaseFile);
  const repository = new DocumentRepository(database);
  repository.recoverInterruptedAnalyses();
  const contentDictionary = await createContentDictionaryHolder(config.contentDictId);
  const analysisService = new AnalysisService(
    repository,
    providers.llm,
    contentDictionary,
    config.llmPromptVersion,
    config.llmBatchSize,
    config.llmBatchConcurrency,
    config.llmSegmentFields
  );

  registerHealthRoutes(app, database);
  registerDocumentRoutes(app, repository, analysisService);
  registerAnalysisRoutes(app, analysisService, providers.llm);
  registerLlmRoutes(app, {
    providerHolder: providers.llm,
    config,
    database,
    analysisService
  });

  app.addHook("onClose", async () => {
    await analysisService.close();
    database.close();
  });

  return app;
}
