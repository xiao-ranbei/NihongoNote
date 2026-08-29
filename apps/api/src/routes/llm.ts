import type { FastifyInstance } from "fastify";

import type { LlmProvider } from "../providers/types.js";

/**
 * LLM 相关的只读端点。
 *
 * GET /api/llm/balance：由本机服务端代理 DeepSeek `/user/balance`。
 * 响应只含脱敏 key（sk-49af…be98），完整 key 不出服务端（见 provider 的 fetchBalance）。
 * 未配置 provider → 503；查询失败（网络/鉴权/非 2xx）→ 502，前端都显示「余额未知」而非崩溃。
 */
export function registerLlmRoutes(app: FastifyInstance, provider: LlmProvider): void {
  app.get("/api/llm/balance", async (_request, reply) => {
    if (!provider.configured) {
      return reply.code(503).send({
        error: "LLM_NOT_CONFIGURED",
        message: "尚未配置可用的 LLM。请在 apps/api/.env 中设置 LLM_PROVIDER 和 LLM_API_KEY"
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
