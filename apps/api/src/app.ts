import Fastify, { type FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { createDatabase } from "./db/database.js";
import { createProviderRegistry } from "./providers/registry.js";
import { DocumentRepository } from "./repositories/document-repository.js";
import { AnalysisService } from "./services/analysis-service.js";
import { registerAnalysisRoutes } from "./routes/analysis.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerHealthRoutes } from "./routes/health.js";

export async function createApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true
  });
  const providers = createProviderRegistry(config);
  const database = await createDatabase(config.databaseFile);
  const repository = new DocumentRepository(database);
  repository.recoverInterruptedAnalyses();
  const analysisService = new AnalysisService(repository, providers.llm, config.llmPromptVersion);

  registerHealthRoutes(app, database);
  registerDocumentRoutes(app, repository, analysisService);
  registerAnalysisRoutes(app, repository, analysisService, providers.llm);

  app.addHook("onClose", async () => {
    analysisService.cancelAll();
    database.close();
  });

  return app;
}
