import Fastify, { type FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { createDatabase } from "./db/database.js";
import { DocumentRepository } from "./repositories/document-repository.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerHealthRoutes } from "./routes/health.js";

export async function createApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true
  });
  const database = await createDatabase(config.databaseFile);
  const repository = new DocumentRepository(database);

  registerHealthRoutes(app, database);
  registerDocumentRoutes(app, repository);

  app.addHook("onClose", async () => {
    database.close();
  });

  return app;
}
