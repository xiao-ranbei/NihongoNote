import { defineConfig } from "vitest/config";

/*
 * 单元测试配置。
 *
 * 与 `scripts/verify-pipeline.ts` 的分工（见 docs/tech-stack-v2.md §4）：
 *   - verify  = 端到端自检：子进程崩溃补写、落盘时序、真实 kuromoji、provider 装配
 *   - vitest  = 细粒度单元测试：纯函数与边界，支持 watch；后续前端 hooks 测试也落在这里
 *
 * 关键点：源码按 NodeNext 解析，相对 import 一律写 ".js" 后缀（如 "./llm-budget.js"），
 * 但磁盘上是 ".ts"。这里用 alias 把后缀剥掉，交给 Vite 的 extensions 去找 .ts。
 * 非相对 import（如 "@nihongonote/core"）不匹配该规则，因此不受影响。
 */
export default defineConfig({
  resolve: {
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }]
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node"
  }
});
