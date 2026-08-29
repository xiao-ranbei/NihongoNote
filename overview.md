# NihongoNote 项目理解报告

**审阅日期**：2026-08-28
**审阅视角**：MVP 开发专家团（项目总监 - 大湾区靓仔）
**代码基线**：Git `e1b6d2d`，工作区干净，pnpm workspace 单仓库

---

## 一、一句话定位

NihongoNote 是一个**只在本机运行的日语精读工具**：粘贴日语原文 → 服务端确定性分句分词 → 用户手动触发云端 LLM 结构化分析 → 在**连续阅读框**中点击句子/词语查看解析。

核心产品判断（来自 `docs/product-decision.md`）：**P1 的核心价值不是"得到一段分析文字"，而是"文章仍然以文章形态阅读"**。因此明确否决了纯 Agent / 纯 skill 形态，选择本地 Web 应用。

---

## 二、技术栈（已落地，非规划）

| 层 | 选型 | 备注 |
| --- | --- | --- |
| 前端 | React 19 + TypeScript + Vite 6 | `apps/web/`，单页，无路由 |
| 后端 | Fastify 5 + TypeScript（tsx 运行） | `apps/api/`，仅监听 `127.0.0.1:8787` |
| 共用包 | `@nihongonote/core`（Zod schema + 类型） | `packages/core/`，前后端单一契约来源 |
| 数据库 | SQLite via `sql.js`（WASM） | 内存运行 + 写盘导出，规避 Windows 原生编译依赖 |
| LLM | DeepSeek OpenAI-compatible（官方 `openai` SDK） | 默认 `deepseek-v4-flash`，provider 可替换 |
| 分词 | Node `Intl.Segmenter`（ja / word） | 过渡方案，规划替换为 kuromoji.js |
| 包管理 | pnpm workspace | Node 22+ / pnpm 10+ |

**设计取舍的关键一条**：API 密钥只存在于 `apps/api/.env`，前端永不接触；数据库与音频目录不入 Git（`**/data/`、`*.db`、`.env` 均已忽略）。

---

## 三、架构与数据流

```text
浏览器 React 阅读器 (5173)
   │  /api 代理（vite proxy）
本机 Fastify API (8787)
   ├── SQLite（sql.js，写盘到 apps/api/data/nihongonote.db）
   ├── 分句层 segmentation.ts（说话人标签 + 句末标点 + 空行区块）
   ├── 分词层 tokenization.ts（Intl.Segmenter，生成稳定 UTF-16 偏移）
   ├── AnalysisService（batch 编排 + 中止 + 重试 + 校验）
   └── LlmProvider（adapter）
          ├── OpenAiCompatibleLlmProvider（已实现）
          ├── DisabledLlmProvider（默认）
          └── AnthropicMessagesLlmProvider（未实现）
```

**分析流水线（8 步）**：

1. 用户粘贴原文 → `POST /api/documents`
2. 服务端本地分句（`splitIntoSegments`）+ 自检（`assertSegmentsMatchSource`）
3. 区块类型检测（启发式，只作为建议，用户可覆盖）
4. 用户点击"开始 AI 分析" → `POST /:id/analyze`（手动触发，不自动烧钱）
5. `AnalysisService` 按 `LLM_BATCH_SIZE=3` / `LLM_BATCH_CONCURRENCY=2` 组批
6. Provider 发流式请求（`response_format: json_object` + `thinking` + `reasoning_effort`）
7. **双重校验**：provider 侧查 schema + 空内容/截断；service 侧逐条比对 segmentId、token 数量、token ID、offset、surface
8. 逐 segment 落盘；失败段标记为 `failed`，可单独重试

**取消语义**（这是本项目做得最扎实的一处）：`AbortController` 中止云端请求 → 已完成 segment 不回滚 → 未完成段回 `queued` → 重启 API 时 `recoverInterruptedAnalyses()` 把 `processing` 段重置为 `queued`，避免任务永久卡死。

---

## 四、数据模型（5 张表 + 1 个共用契约）

| 表 | 作用 |
| --- | --- |
| `documents` | 原文、标题、目标等级、内容类型 + 建议、状态（draft/analyzing/ready/failed） |
| `segments` | 句子，含 UTF-16 `start_offset`/`end_offset`、speaker、状态（queued/processing/completed/failed） |
| `segment_analyses` | AI 原始结果（provider/model/prompt_version/result_json/usage_json） |
| `analysis_revisions` | 人工修正覆盖层，**不覆盖 AI 原始结果** |
| `audio_assets` / `recordings` | TTS 预留，当前未使用 |

**ID 稳定性设计**（项目的架构地基）：
- Segment：`${documentId}:segment:${index}`
- Token：`${segmentId}:token:${index}`
- 前端渲染严格按 offset 区间切分，**禁止用字符串搜索定位**，避免重复词串位。

**CanonicalAnalysis / LevelExplanation 分层**（已设计，未实现）：
目前 `SegmentAnalysis` 是过渡载体，等级只作为教学表达参数传入 prompt。规划上要拆成"事实层"（唯一一份）+"等级解释层"（N5-N1 各一份缓存），切换等级不重新分词、不改变前端定位。

---

## 五、API 契约（10 个端点，全部已实现）

```text
GET    /api/health
POST   /api/documents                          创建 + 本地分句
GET    /api/documents?q=&status=                学习库搜索/筛选
GET    /api/documents/:id
PATCH  /api/documents/:id                       改标题/类型/等级
DELETE /api/documents/:id                       删除（先取消分析任务）
POST   /api/documents/:id/analyze               启动分析（202）
POST   /api/documents/:id/analyze/cancel        取消（中止云端请求）
GET    /api/documents/:id/progress              进度轮询（前端 800ms）
POST   /api/segments/:id/retry                  单段重试
PATCH  /api/segments/:id                        改说话人
PATCH  /api/segments/:id/analysis               人工修正（写入 revision）
```

前端 `client.ts` 对每个响应都用 core 的 Zod schema 做运行时校验，**前后端共用同一套类型契约**，这一点工程质量很高。

---

## 六、完成度评估

### 已完成（P0 + P1 MVP 闭环）

| 能力 | 状态 |
| --- | --- |
| 连续阅读框（句子层 + token 层定位与点击解析） | 完成 |
| 手动启动 / 取消 / 单段重试 | 完成 |
| 内容类型手动选择 + 自动建议 | 完成 |
| 标题、角色、解析字段人工修正（保留 AI 原版） | 完成 |
| 学习库折叠持久化 + 搜索 + 状态筛选 | 完成 |
| DeepSeek adapter（batch + stream + 调试日志） | 完成 |
| 真实 key 连通性验证 | 3/3 segment 成功（单个样本，非完整回归） |

### 明确未完成（按 roadmap）

- **完整范围标注**：`AnnotationRange`、语法/语气波浪线、四层循环点击
- **等级解释层**：`CanonicalAnalysis` / `LevelExplanation` 拆分与缓存
- **编辑能力**：区块、分句、标注范围编辑
- **TTS**：仅有接口与表结构，未实现
- **Anthropic-compatible adapter**：未实现
- **完整质量/费用回归**：只有 1 个样本的基线，未跑固定评估集

---

## 七、门禁检查结果（专家团 P0 规则 + 工程规范）

| 检查项 | 结果 |
| --- | --- |
| P0-1 禁止 emoji 作为功能图标 | **通过**（全仓扫描 0 命中，图标用 `×` 文本与 CSS 实现） |
| P0-2 禁止紫粉渐变 | **通过**（配色为米白/棕/绿和风纸感，无 Indigo→Pink 渐变） |
| P0-3 禁止硬编码颜色 | **不通过**（`styles.css` 有 136 处 hex 硬编码，0 个 CSS 变量） |
| 单文件 ≤ 300 行 | **不通过**（App.tsx 1444 行 / repository 778 行 / provider 438 行 / styles.css 1269 行） |
| 自动化测试 | **缺失**（0 个测试文件，无 vitest/jest，无 CI，无 ESLint/Prettier） |
| 依赖安装 | **未安装**（当前环境无 `node_modules`，pnpm 在沙箱内报 safe-delete 错误） |
| `.env` / data 目录 | **不存在**（项目尚未在本机实际运行过） |

### 关键发现：`docs/annotation-prototype.html` 已经做好了 Token 化

视觉原型里已经定义了一套完整的 CSS 变量（`--ink` / `--paper` / `--sentence-fill` / `--particle-line` / `--adverb-fill` 等），但**生产代码 `styles.css` 完全没有采用**，全部是散落的 hex。这是现成的、零设计成本的迁移来源——把原型的 `:root` 变量搬进生产样式即可同时解决 P0-3 和主题一致性。

---

## 八、优先级建议（不阻塞，供决策）

| 优先级 | 事项 | 理由 |
| --- | --- | --- |
| P0 | 装依赖 + 跑通 `pnpm dev` 与 `pnpm typecheck` | 当前代码未在本机验证过，一切结论都还是纸面的 |
| P0 | 用 `evaluation-corpus.md` 的 2 篇样本做完整回归 | roadmap 明确要求，当前只有 1 个样本的部分验证 |
| P1 | `styles.css` 迁移到 CSS 变量（直接复用原型 token） | 成本极低，同时修复 P0-3 与后续主题切换能力 |
| P1 | 引入 vitest，先补 `segmentation.ts` / `analysis-service.ts` 校验逻辑测试 | 分句偏移和 token 校验是全项目最容易静默出错的地方 |
| P2 | 拆分 `App.tsx`（1444 行）为阅读器 / 学习库 / 解析面板 / 编辑器 | 为后续范围标注与四层点击铺路 |
| P3 | Canonical / Level 分层、TTS、Anthropic adapter | roadmap 已排期，不阻塞 MVP |

---

## 九、总体判断

这是一个**文档密度和工程质量都高于平均水平**的个人项目：需求、架构、路线、评估样本、提示词协议全部落盘，前后端共用 Zod 契约，取消/重试/校验的边界考虑得很细，没有"看起来能跑"的糊弄。

主要风险不在设计而在**验证与规范**：
1. 代码尚未在本机跑起来，真实质量未知；
2. 零自动化测试，分句偏移这类静默错误缺少护栏；
3. 样式层没有 Token 化，与已有的视觉原型脱节，后续做范围标注和主题切换会持续还债。

建议下一步先完成"能跑 + 有回归样本 + 有测试护栏"三件事，再进入 roadmap 的完整范围标注阶段。
