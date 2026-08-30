import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import {
  buildLlmProvider,
  type LlmBuildConfig,
  type LlmProviderHolder
} from "../providers/registry.js";
import type { AnalysisService } from "../services/analysis-service.js";
import {
  maskApiKey,
  mergeLlmSettings,
  parseLlmSettings,
  resolveApiKey,
  settingsDefaultsFromConfig,
  type LlmSettings,
  type LlmSettingsInput
} from "../settings.js";

/**
 * LLM 只读与设置端点。
 *
 * GET /api/llm/balance：由本机服务端代理 DeepSeek `/user/balance`。
 * 响应只含脱敏 key（sk-49a…be98），完整 key 不出服务端（见 provider 的 fetchBalance）。
 * 未配置 provider → 503；查询失败（网络/鉴权/非 2xx）→ 502，前端都显示「余额未知」而非崩溃。
 *
 * GET/PUT /api/llm/settings：设置页读写（设计文档 llm-settings-design.md）。
 * 保存即热切换：写库 → 重建 provider（holder.replace）→ 更新档位，无需重启。
 */

interface LlmRouteDeps {
  providerHolder: LlmProviderHolder;
  config: AppConfig;
  database: AppDatabase;
  analysisService: AnalysisService;
}

function invalidInput(reply: { code: (code: number) => { send: (body: unknown) => unknown } }, detail: unknown) {
  return reply.code(400).send({
    error: "INVALID_SETTINGS",
    message: "设置校验失败",
    detail
  });
}

export function registerLlmRoutes(app: FastifyInstance, deps: LlmRouteDeps): void {
  const { providerHolder, config, database, analysisService } = deps;

  function readStored(): Partial<LlmSettings> {
    const row = database.get<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = ?",
      ["llm"]
    );
    if (!row) {
      return {};
    }
    try {
      return parseLlmSettings(JSON.parse(row.value)) as Partial<LlmSettings>;
    } catch {
      return {};
    }
  }

  function currentState() {
    const defaults = settingsDefaultsFromConfig(config);
    const stored = readStored();
    const merged = mergeLlmSettings(defaults, stored);
    const source = {} as Record<keyof LlmSettings, "db" | "env">;
    for (const key of Object.keys(merged) as Array<keyof LlmSettings>) {
      const storedValue = stored[key];
      source[key] = storedValue !== undefined && storedValue !== null ? "db" : "env";
    }
    return {
      settings: {
        ...merged,
        apiKey: maskApiKey(merged.apiKey ?? null)
      },
      source,
      provider: {
        name: providerHolder.current.name,
        configured: providerHolder.current.configured,
        model: providerHolder.current.model,
        isLocal: providerHolder.current.name === "ollama"
      }
    };
  }

  app.get("/api/llm/settings", async (_request, reply) => {
    return reply.send(currentState());
  });

  app.put("/api/llm/settings", async (request, reply) => {
    let parsed: LlmSettings;
    try {
      parsed = parseLlmSettings(request.body as LlmSettingsInput);
    } catch (reason: unknown) {
      // parseLlmSettings 对非法输入抛 ZodError，必须转成 400 而不是 500
      return invalidInput(
        reply,
        reason instanceof Error ? reason.message : String(reason)
      );
    }
    const stored = readStored();
    const settings: LlmSettings = {
      ...parsed,
      apiKey: resolveApiKey(parsed, stored)
    };

    // 写库
    const payload = JSON.stringify(settings);
    database.transaction(() => {
      database.run("DELETE FROM app_settings WHERE key = ?", ["llm"]);
      database.run("INSERT INTO app_settings (key, value) VALUES (?, ?)", ["llm", payload]);
    });

    // 热切换：重建 provider（batchSize/concurrency/timeout 等未暴露字段沿用 env）
    const buildConfig: LlmBuildConfig = {
      llmProvider: settings.provider,
      llmProtocol: "openai",
      llmBaseUrl: settings.baseUrl,
      llmApiKey: settings.apiKey ?? undefined,
      llmModel: settings.model,
      llmTemperature: settings.temperature,
      llmMaxTokens: settings.maxTokens,
      llmTimeoutMs: config.llmTimeoutMs,
      llmThinkingType: settings.thinkingType ?? undefined,
      // 设置未指定档位时回退到 env 默认（LLM_REASONING_EFFORT 有默认 minimal）
      llmReasoningEffort: settings.reasoningEffort ?? config.llmReasoningEffort,
      llmDebugLogging: config.llmDebugLogging,
      llmDebugLogFile: config.llmDebugLogFile
    };
    providerHolder.replace(buildLlmProvider(buildConfig));
    analysisService.updateSegmentFields(settings.segmentFields);

    return reply.send(currentState());
  });

  app.get("/api/llm/balance", async (_request, reply) => {
    const provider = providerHolder.current;
    if (!provider.configured) {
      return reply.code(503).send({
        error: "LLM_NOT_CONFIGURED",
        message: "尚未配置可用的 LLM。请在设置页选择本地 Ollama 或云端 API 并保存"
      });
    }
    try {
      const balance = await provider.fetchBalance();
      if (!balance) {
        return reply.code(404).send({
          error: "BALANCE_UNAVAILABLE",
          message: "当前 provider 不支持余额查询"
        });
      }
      return reply.send(balance);
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : "未知错误";
      return reply.code(502).send({
        error: "BALANCE_FETCH_FAILED",
        message: `查询余额失败：${message}`
      });
    }
  });
}
