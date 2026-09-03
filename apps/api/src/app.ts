import Fastify, { type FastifyInstance } from "fastify";

import type { AppConfig } from "./config.js";
import { createDatabase } from "./db/database.js";
import { createProviderRegistry } from "./providers/registry.js";
import { createContentDictionaryHolder } from "./dictionary/content/index.js";
import { OllamaGlossTranslator } from "./dictionary/content/translator.js";
import { DocumentRepository } from "./repositories/document-repository.js";
import { AnalysisService } from "./services/analysis-service.js";
import { registerAnalysisRoutes } from "./routes/analysis.js";
import { registerContentDictionaryRoutes } from "./routes/content-dictionary.js";
import { registerGlossTranslationRoutes } from "./routes/gloss-translation.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerLlmRoutes } from "./routes/llm.js";
import { loadContentDictionarySettings } from "./content-dictionary-settings.js";
import { loadGlossTranslationSettings } from "./gloss-translation-settings.js";

export async function createApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true
  });
  const providers = createProviderRegistry(config);
  const database = await createDatabase(config.databaseFile);
  const repository = new DocumentRepository(database);
  repository.recoverInterruptedAnalyses();
  const contentDictionarySettings = loadContentDictionarySettings(database);
  const contentDictionary = await createContentDictionaryHolder(
    contentDictionarySettings?.id ?? null,
    config.contentDictId
  );
  // 译中器（阶段 B）：内容词英文释义 → 中文，仅本地 Ollama，零云端成本。
  // 默认开；Ollama 未启动或翻译失败时调用方回退英文，不阻断分析。
  const glossTranslator = new OllamaGlossTranslator({
    database,
    baseUrl: config.contentDictTranslateBaseUrl,
    model: config.contentDictTranslateModel,
    debugLogging: config.llmDebugLogging,
    debugLogFile: config.llmDebugLogFile,
    enabled: config.contentDictTranslateEnabled
  });
  // db 设置覆盖 .env：若用户曾保存过译中开关，以 db 为准（优先级：db > env > 默认开）。
  const glossTranslationSettings = loadGlossTranslationSettings(database);
  if (glossTranslationSettings) {
    glossTranslator.setEnabled(glossTranslationSettings.enabled);
  }
  const analysisService = new AnalysisService(
    repository,
    providers.llm,
    contentDictionary,
    glossTranslator,
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
  registerContentDictionaryRoutes(app, {
    holder: contentDictionary,
    database
  });
  registerGlossTranslationRoutes(app, {
    translator: glossTranslator,
    database
  });

  app.addHook("onClose", async () => {
    await analysisService.close();
    database.close();
  });

  return app;
}
