import type { FastifyInstance } from "fastify";

import type { AppDatabase } from "../db/database.js";
import {
  createContentDictionary,
  initializeContentDictionary,
  type ContentDictionaryHolder
} from "../dictionary/content/index.js";
import {
  contentDictionaryState,
  parseContentDictionarySettings,
  saveContentDictionarySettings,
  type ContentDictionarySettingsInput
} from "../content-dictionary-settings.js";

/**
 * 内容词数据源设置端点（设计文档 jmdict-integration-design.md §6.5 阶段 A）。
 *
 * GET  /api/content-dictionary/settings：返回 current（已初始化的 holder.current，含实时 stats）
 *        + available（设置页可见的真实源 {id,label}）。不加载未启用的索引，零开销。
 * PUT  /api/content-dictionary/settings：收 { id }，写库后 holder.replace(next) 热切换，
 *        下次分析即用新源，无需重启（沿用 LlmProviderHolder 同款模式）。
 */
interface ContentDictionaryRouteDeps {
  holder: ContentDictionaryHolder;
  database: AppDatabase;
}

function invalidInput(
  reply: { code: (code: number) => { send: (body: unknown) => unknown } },
  detail: unknown
) {
  return reply.code(400).send({
    error: "INVALID_CONTENT_DICTIONARY_SETTINGS",
    message: "内容词典设置校验失败",
    detail
  });
}

export function registerContentDictionaryRoutes(
  app: FastifyInstance,
  deps: ContentDictionaryRouteDeps
): void {
  const { holder, database } = deps;

  app.get("/api/content-dictionary/settings", async (_request, reply) => {
    return reply.send(contentDictionaryState(holder));
  });

  app.put("/api/content-dictionary/settings", async (request, reply) => {
    let parsed;
    try {
      parsed = parseContentDictionarySettings(request.body as ContentDictionarySettingsInput);
    } catch (reason: unknown) {
      return invalidInput(
        reply,
        reason instanceof Error ? reason.message : String(reason)
      );
    }

    // 写库
    saveContentDictionarySettings(database, parsed);

    // 热切换：重建并初始化新 provider（加载索引），替换 holder.current。
    // 初始化失败由 initializeContentDictionary 静默回落 Null（AC-05），分析不中断。
    const next = await initializeContentDictionary(createContentDictionary(parsed.id));
    holder.replace(next);

    return reply.send(contentDictionaryState(holder));
  });
}
