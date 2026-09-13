# 技术栈选型 v2

**版本**：v2 · 2026-09-12
**文档集**：配套 [系统架构方案 v2](architecture-v2.md) · [需求文档](requirements-v2.md) · [项目规划](roadmap-v2.md)

---

## 一、选型原则

1. **能自己写的就不引依赖**：本机单人项目，依赖越少，环境越不容易烂（已有教训：`better-sqlite3` 的原生编译就是被这条原则挡掉的）。
2. **新增依赖必须能回答「为什么不自己写」**：写不出来就不引。
3. **不为了架构美观引入运行时**：SSR、状态管理库、ORM 都在此列。
4. **关键路径的依赖必须可替换**：LLM、TTS、分词器、数据库都通过接口隔离，换实现不改上层。
5. **成本敏感优先本地**：本地能做的（分词、形态素、词典、译中、TTS）不放到云端（LLM-011 的延伸）。

---

## 二、现状栈（保持不变，P1 已跑通）

| 层 | 选型 | 版本 | 选它的理由 | 代价 |
| --- | --- | --- | --- | --- |
| 包管理 | pnpm workspace | 10 | 三包 monorepo（api / web / core）硬隔离 | 无 |
| 语言 | TypeScript（ESM，strict） | 5.7 | 契约即类型，前后端共用 | ESM + `createRequire` 的少量胶水 |
| 前端 | React + Vite | 19 / 6 | 启动快、无 SSR 负担 | 无 |
| 样式 | 自写 CSS + CSS 变量 Token + `data-theme` | — | 六套主题、72 个语义 Token 已落地并机器校验 | 需要自己维护样式规范 |
| 后端 | Fastify | 5 | 轻、插件化、自带 pino 日志 | 无 |
| 契约 | Zod（`packages/core`） | 3 | 同一份 schema 前后端共用，杜绝契约漂移 | 运行时开销可忽略 |
| 数据库 | sql.js（WASM） | 1.13 | **免原生编译**，Windows 零摩擦 | 无增量落盘，需延迟批量写 + 原子替换（见 §4） |
| 分句 | 自写 `segmentation.ts` | — | 说话人标签 + 句末标点规则高度定制 | 正则误判代价高，已用用例守住 |
| 分词 | `Intl.Segmenter` + 自写碎片合并 | 内置 | 零依赖、确定性、实测 475 token 零差异 | 对敬语活用会切碎，靠后处理合并补 |
| 形态素 | kuromoji（IPADIC） | 0.1.2 | 本地免费产出 lemma/reading/POS/活用 | 维护停滞、字典体积大（见 §5） |
| LLM SDK | openai | 7.x | 官方 SDK，覆盖所有 OpenAI 兼容端点 | 自动重试需显式关闭 |
| LLM 后端 | DeepSeek（云端）/ Ollama 原生 `/api/chat`（本地） | — | 云端要质量、本地要零费用 | 本地 9B 段耗 30-80s |

---

## 三、v2 新增：需要引入的东西

**结论：v2 不新增任何生产依赖。** 流式相关的三块都自己写，原因如下。

| 能力 | 方案 | 为什么不用现成库 |
| --- | --- | --- |
| SSE 服务端推送 | Fastify `reply.raw` 手写 `text/event-stream`（约 60 行） | `@fastify/sse` 等插件只是封装响应头与心跳；事件格式本身极简，引入后反而受其抽象限制 |
| SSE 客户端解析 | `fetch` + `ReadableStream` 手写行解析（约 80 行） | 不能用 `EventSource`（需要 POST + 自定义 body）；`eventsource-parser` 可省，格式就是 `data: xxx\n\n` |
| 流式 JSON 闭合对象扫描 | 自写状态机 `json-stream-scanner.ts`（约 100 行） | `stream-json` 面向完整流式解析、不支持「半截容错」；我们要的是「只认闭合对象、非前缀即回退重扫」 |
| 增量上屏动效 | CSS `transition` + `ResizeObserver`（约 30 行） | `motion` / `flowtoken` 体积远大于收益；我们的粒度是**段**不是词，不需要逐词动画 |
| 可观测性事件日志 | 复用 Fastify 自带 pino + 自写 JSONL 追加（约 40 行） | 已内置 pino，不需要新依赖 |

---

## 四、待评估的技术升级（有真实收益，但要先验证）

| 候选 | 现状 | 收益 | 风险 / 前置验证 | 建议阶段 |
| --- | --- | --- | --- | --- |
| **`node:sqlite` 替代 sql.js** | WASM，每次写要整库 `export()` | 真正的增量写盘、原生性能、去掉 9.3MB WASM 与延迟落盘逻辑 | Node 内置模块仍在演进（API 稳定性需按目标 Node 版本确认）；迁移需重写 `db/database.ts` 适配层（好在只影响一个文件） | M3 评估，M4 决定 |
| ~~**vitest**~~ **已引入（2026-09-13）** | 原只有 `verify-pipeline.ts` 脚本 | watch 模式、细粒度单元测试、失败定位更细；前端 hooks 测试的唯一可行途径 | 已落地：`apps/api/vitest.config.ts` + `tests/`，`pnpm test`（根/包都可跑）。`NodeNext` 要求的 `.js` 后缀由 vite alias 剥除。分工见 §七 |
| **ESLint 9（flat config）** | 无 | 统一风格、提前发现未使用导出与 `any` 泄漏 | 与 5 个包配置需协调 | M3 |
| **`@sglkc/kuromoji` 或其他 fork** | kuromoji 0.1.2 长期未更新 | 安全性、可能的字典优化 | 需验证输出与现有一致（`morphology.ts` 已隔离，替换面小） | 有维护风险时再说 |
| **词典索引从 JSON 转到 SQLite FTS** | 9.3MB JSON 全量载入内存 | 索引再扩大时内存可控、支持模糊查询 | 当前 9.3MB 完全可接受，属于过度优化 | 暂不做，设阈值（>50MB 再评估） |
| **`@tanstack/react-virtual`** | 学习库全量渲染 | 文章数上千时列表滚动性能 | 当前文章数远未到瓶颈 | 出现卡顿时再引 |

---

## 五、TTS 选型（P3，当前只有接口）

现状：`TtsProvider` 接口 + `TTS_*` 配置已预留，registry 直接抛「未实现」。

| 候选 | 离线 | 费用 | 日语质量 | 评价 |
| --- | --- | --- | --- | --- |
| **VOICEVOX（本机）** | ✅ | 免费 | 高（日语专用） | **首选**。与 Ollama 同构：本机进程 + 本地推理，零费用、零隐私外泄，符合项目成本原则 |
| edge-tts（微软） | ❌ | 免费但非官方端点 | 高 | 备选。走网络 + 依赖非官方接口，稳定性与合规性都需确认 |
| Gemini TTS / 商用 API | ❌ | 按量计费 | 高 | 不优先，违反「本地免费优先」 |
| 浏览器 `speechSynthesis` | ✅ | 免费 | 差（日语机械音） | 仅作最终降级兜底 |

**建议**：P3 先做 VOICEVOX provider，`TTS_PROVIDER=voicevox`；`speechSynthesis` 作为兜底而非主路径。

---

## 六、刻意不引入清单

| 不引入 | 理由 |
| --- | --- |
| Next.js / SSR / RSC | 本机单用户应用，SSR 只增加构建与心智负担 |
| Tailwind CSS | 已有 72 个语义 Token + 六主题 + CSS 变量体系；迁移等于重写整个主题层 |
| 组件库（全量 shadcn / Ant Design） | 与既有主题 Token 体系冲突，且会带入大量未用样式 |
| 状态管理库（Redux / Zustand / Jotai） | 拆分 hooks 后状态天然分层；引入库会让「谁是状态源」变模糊 |
| ORM（Prisma / Drizzle） | 手写 SQL 共 8 张表，规模远未到需要 ORM；已有迁移函数与审计脚本依赖原生 SQL |
| 动效库（motion / flowtoken） | 段级粒度用不上逐词动画 |
| 队列 / 任务框架（BullMQ 等） | 单进程内存队列 + DB 状态机已够；引入 Redis 会毁掉「零外部依赖」 |
| 图表库 | 成本预览用纯文本表格，够用 |
| 埋点 SDK（Umami 等） | 本机自用，事件写本地 JSONL 即可，不需要第三方统计 |

---

## 七、版本与工程约束

| 项 | 约定 |
| --- | --- |
| Node | 22 LTS 起（当前环境 22 / 24 均可用）；数据库迁移评估时以 22 LTS 为准 |
| 包管理 | pnpm 10；`pnpm-lock.yaml` 入库 |
| 类型检查门槛 | `pnpm typecheck` 必须全绿（含 `apps/api/scripts` 与 `apps/api/tests`） |
| 测试分层 | `pnpm test`（vitest）= 纯函数与边界的细粒度单元测试，支持 watch；`verify` = 端到端自检（子进程崩溃补写、落盘时序、真实 kuromoji、provider 装配）。两者都保留，核心路径**有意重复覆盖** |
| 提交前自检 | `pnpm typecheck` + `pnpm test` + `pnpm --filter @nihongonote/api verify` |
| CI | 无（本机自用）；上述三条作为人工门槛 |
| 密钥 | 只在 `.env` 与数据库 `app_settings`；两者都不入 Git |
| 大文件 | `data/jmdict-common-index.json`（9.3MB）不入库，由 `build:jmdict-index` 重建 |
| 新增依赖流程 | ① 说清「为什么不自己写」② 评估体积与维护状态 ③ 通过接口隔离，保证可替换 |
