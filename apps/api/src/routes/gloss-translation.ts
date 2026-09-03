import type { FastifyInstance } from "fastify";

import type { AppDatabase } from "../db/database.js";
import type { GlossTranslator } from "../dictionary/content/translator.js";
import {
  glossTranslationState,
  parseGlossTranslationSettings,
  saveGlossTranslationSettings,
  type GlossTranslationSettingsInput
} from "../gloss-translation-settings.js";

/**
 * 译中（阶段 B）开关端点（设计文档 jmdict-integration-design.md §6.5）。
 *
 * GET  /api/gloss-translation/settings：返回 { enabled, available }；
 *        available 为本地 Ollama 实时探活结果（不抛错），供设置页提示模型是否可用。
 * PUT  /api/gloss-translation/settings：收 { enabled }，写库后经 translator.setEnabled
 *        热切换，下次真实分析立即生效，无需重启（Ollama 未启动也不报错）。
 */
interface GlossTranslationRouteDeps {
  translator: GlossTranslator;
  database: AppDatabase;
}

function invalidInput(
  reply: { code: (code: number) => { send: (body: unknown) => unknown } },
  detail: unknown
) {
  return reply.code(400).send({
    error: "INVALID_GLOSS_TRANSLATION_SETTINGS",
    message: "译中设置校验失败",
    detail
  });
}

export function registerGlossTranslationRoutes(
  app: FastifyInstance,
  deps: GlossTranslationRouteDeps
): void {
  const { translator, database } = deps;

  app.get("/api/gloss-translation/settings", async (_request, reply) => {
    return reply.send(await glossTranslationState(translator));
  });

  app.put("/api/gloss-translation/settings", async (request, reply) => {
    let parsed;
    try {
      parsed = parseGlossTranslationSettings(request.body as GlossTranslationSettingsInput);
    } catch (reason: unknown) {
      return invalidInput(
        reply,
        reason instanceof Error ? reason.message : String(reason)
      );
    }

    // 写库 + 热切换（无需重启）
    saveGlossTranslationSettings(database, parsed);
    translator.setEnabled(parsed.enabled);

    return reply.send(await glossTranslationState(translator));
  });
}
