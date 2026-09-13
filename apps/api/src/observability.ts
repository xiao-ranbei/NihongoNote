import fs from "node:fs";

/**
 * 可观测性事件日志（OBS-001..003 / PRIV-004，见 docs/architecture-v2.md §4.4）。
 *
 * 设计原则：
 * 1. **默认关闭**——观测性是可选能力，不能默认往用户磁盘写东西；
 * 2. **只写数值与分类**——事件里永远不出现原文、译文、API key（PRIV-004）；
 * 3. **永远不能拖垮业务**——写盘失败静默吞掉，分析照常。
 *
 * 写入格式：JSONL（一行一个事件），按事件发生时刻附加 ISO 时间戳。
 * 用 appendFileSync 而非追加流：分析事件频率低（每次分析个位数到几十条），
 * 每次打开-写入-关闭最简单，也不需要管理句柄生命周期。
 */
export class ObservabilityLogger {
  private filePath: string | null = null;

  public configure(enabled: boolean, filePath: string): void {
    this.filePath = enabled ? filePath : null;
  }

  public get enabled(): boolean {
    return this.filePath !== null;
  }

  public write(event: Record<string, unknown>): void {
    if (this.filePath === null) {
      return;
    }
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), ...event });
      fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
    } catch {
      // 观测性写失败（磁盘满/权限）静默吞掉——它永远不能影响分析
    }
  }
}

/**
 * 错误信息 → 分类（OBS-002 的 error_category）。
 * 纯启发式关键词匹配：只用于聚合统计，不用于程序分支，误分类可接受。
 * 顺序敏感：越靠前优先级越高（例如取消的报错里也常带 abort，必须先于 timeout 判定）。
 */
export type ErrorCategory =
  | "cancelled"
  | "auth"
  | "rate-limit"
  | "timeout"
  | "truncated"
  | "invalid-json"
  | "schema"
  | "service-unavailable"
  | "unknown";

/** 进程级单例：由 index.ts 启动时 configure（OBSERVABILITY_ENABLED，默认关闭）。 */
export const observability = new ObservabilityLogger();

const errorPatterns: Array<[ErrorCategory, RegExp]> = [
  ["cancelled", /abort/i],
  ["auth", /401|unauthorized|invalid[ _-]api[ _-]key|authentication/i],
  ["rate-limit", /429|rate[ _-]limit|too many requests/i],
  ["timeout", /timed? ?out|timeout/i],
  ["truncated", /finish[ _-]?reason|truncated|max_tokens/i],
  ["invalid-json", /invalid json|json parse|bad control character|unexpected token/i],
  ["schema", /did not match the schema|schema validation/i],
  ["service-unavailable", /econnrefused|enotfound|fetch failed|服务未启动|无法连接|not found/i]
];

export function classifyError(message: string): ErrorCategory {
  for (const [category, pattern] of errorPatterns) {
    if (pattern.test(message)) {
      return category;
    }
  }
  return "unknown";
}
