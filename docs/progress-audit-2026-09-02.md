# 项目进展审计（2026-09-02）

对照 `requirements.md` / `roadmap.md` / `issues.md` / `analysis-tools-design.md` 逐项核对 `apps/api`、`apps/web`、`packages/core` 的实际代码，得出当前完成度与未实现清单。

核对手段：源码关键词检索 + 端点枚举 + 跑 `verify-pipeline`（93/93）与 `dictionary-coverage`（纯本地，零 token）。

---

## 一、总体判断

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| **P0 验证和骨架** | ✅ 完成 | 骨架、provider 抽象、schema 校验、取消/重试、落盘 |
| **P1 MVP 交互式解析** | ✅ 完成 | 两层定位、类型选择、可中止分析、修正、学习库搜索+状态筛选 |
| **P1 后续增强** | ❌ 基本未动 | 范围标注、四层点击、等级解释层、内容类型筛选全部缺 |
| **P2 自用质量** | 🟡 部分完成 | 词典降本链路已落地；导出/缓存/Anthropic/vitest 未做 |
| **P3 扩展** | ❌ 未开始 | TTS 仅类型与配置预留，registry 直接抛「not implemented yet」 |

一句话：**能用的学习闭环已经跑通，且成本治理（词典降本 + 本地模型）做得比原计划更深；但所有「让阅读体验真正好用」的 P1 后续增强一层未动。**

代码健康度良好：`verify-pipeline` 93/93、typecheck 干净、源码内几乎没有 TODO 残留，唯一明确的未实现标记是 `registry.ts:97` 的 TTS。

---

## 二、已完成机能

### 2.1 后端（`apps/api`）

| 能力 | 落点 |
| --- | --- |
| 文档 CRUD（含重命名/删除） | `routes/documents.ts`：`GET/POST/GET one/PATCH/DELETE /api/documents` |
| 分段 · 说话人识别 · UTF-16 偏移 | `segmentation.ts`（A-2 正则缺陷已修） |
| 分词 + 形态素事实字段 | `tokenization.ts` + `morphology.ts`（kuromoji） |
| 三层解析链（词典命中不进 LLM） | `segment-preparation.ts` + `services/analysis-service.ts` |
| 分析启动 / 取消 / 进度 / 单段重试 | `routes/analysis.ts` + `analysis-service.ts` |
| 成本预览 + 批量分析 + 仅词典零费模式 | `analysis-preview.ts` + `routes/analysis.ts` |
| 人工修正（标题/角色/解析字段，保留 AI 原版） | `PATCH /api/segments/:id`、`PATCH /api/segments/:id/analysis`（含 tokenId 校验 + `userRevision` 版本） |
| LLM 设置页后端 + 多配置 profiles + 热切换 | `settings.ts` + `routes/llm.ts` |
| 余额查询 + 费用统计 | `routes/llm.ts` + `llm-pricing.ts`（高峰/闲时单价表） |
| DeepSeek / OpenAI 兼容 / Ollama 原生 / 禁用 | `providers/`（ollama 走 `/api/chat`，非兼容层） |
| JSON 解析三层修复链 | `providers/openai-compatible.ts`（含 `repairStrayQuotes()`） |
| 段级字段档位制（minimal/standard/full） | `core/domain.ts` + `buildSystemPrompt(profile)` |

### 2.2 前端（`apps/web`）

| 能力 | 落点 |
| --- | --- |
| 连续阅读框（句子层 + token 层） | `App.tsx` |
| 五类词标注 + 线型语言（实线/双线/虚线/波浪） | `styles.css` + `tokenCategorySchema`（含 `functional`） |
| 三个视图：阅读 / 分析工具 / 设置 | `App.tsx:831` |
| 分析工具页（多选 → 预览 → 成本确认 → 进度） | `analysis-tools.tsx`（落实 LLM-011） |
| 设置页（本地/云端/禁用 + profiles 标签页） | `settings.tsx` |
| 六套主题 Token（72 个语义 Token，零硬编码颜色） | `styles.css` |
| 学习库折叠 + 搜索 + 分析状态筛选 + localStorage 持久化 | `App.tsx` |

### 2.3 成本治理（超出原计划的完成度）

| 项 | 数据 |
| --- | --- |
| 固定用法库 | 助词 45 + 功能词 33 + 句末模板 16 |
| 词典覆盖率（场景 1 实测） | **39.7%**，省下 363 次 AI 解释调用 |
| 仍需 AI 兜底 | 551 个 token / 91 个段 |
| 本地模型实测 | qwen3.5:9b 约 64 tok/s，零 API 费用 |
| 段级档位节省（standard） | 约 37%（场景 1：¥0.47 → ¥0.31） |

---

## 三、未实现机能清单

### 3.1 P1 后续增强（需求已定义，代码零实现）

| # | 机能 | 依据 | 代码现状 |
| --- | --- | --- | --- |
| 1 | **范围标注层 `AnnotationRange`**（语法/语气跨词范围、背景叠加、波浪线） | 需求 1.1「后续范围层」 | 全仓库 0 命中 |
| 2 | **四层点击循环**（句子结构 → 词语/助词/副词 → 多词语法 → 语气/态度） | 需求 1.1「后续完整交互层级」 | `App.tsx` 无层级/循环逻辑 |
| 3 | **桌面锚点卡片自动换位** | 需求 1.1 | 无 |
| 4 | **移动端解析卡抽屉**（窄屏） | 需求 1.1 / I-12 | 无 `drawer` 实现 |
| 5 | **移动端学习库改为覆盖式抽屉** | 需求 1.3 / I-12 | 当前为堆叠 |
| 6 | **区块 / 分句 / 范围编辑**（选中文本调分句、合并拆分区块） | 需求 1.3 | 只有段级修正，无范围编辑 |
| 7 | **等级解释层 `LevelExplanation` / `CanonicalAnalysis` 拆分** | 需求 1.4 + 路线图 P1 增强第 1 项 | 全仓库 0 命中；`targetLevel` 只作为 prompt 参数传入 |
| 8 | **学习库内容类型筛选** | 需求 1.3 + 路线图 P1 增强第 6 项 | 只有搜索 + 分析状态 |
| 9 | **对话标签/强度/evidence range/可展开关系箭头** | 路线图 P1 增强第 5 项 | 只有自由文本 `tone` |

### 3.2 P2 自用质量

| # | 机能 | 依据 | 代码现状 |
| --- | --- | --- | --- |
| 10 | **导出 JSON 与原文** | 路线图 P2 | 无端点、无前端入口 |
| 11 | **分析缓存** | 路线图 P2 | AI 解释缓存已由决策 2 取消，改为离线扩充固定库；无请求级缓存 |
| 12 | **prompt 版本管理** | 路线图 P2 | 只有 `prompt_version` 列 + `schemaVersion` 字段 |
| 13 | **Anthropic-compatible adapter** | 路线图 P2 | 仅 `LlmProtocol` 枚举，无 adapter |
| 14 | **扩展搜索 / 标签 / 批量管理** | 路线图 P2 | 只有标题+原文搜索与状态筛选 |
| 15 | **`toneEvidence` 字段**（解析能指出原文证据） | I-9（验收要求） | 未落地 |
| 16 | **`politenessLevel` 五档枚举** | I-10 | 自由文本 |
| 17 | **`usage_json` 历史数据缓存字段回填** | I-5 | 无迁移脚本；旧 42 条按「未命中」计价 |
| 18 | **`App.tsx` 拆分** | I-13 | 现 **1611 行**（记录时 1444 行，仍在膨胀） |
| 19 | **vitest 引入** | I-21 | 未引入；自研断言脚本已 93 项 |
| 20 | **ESLint** | I-22 | 未引入 |
| 21 | **provider 限流 / 断点续跑** | 路线图 P2 | 有单段重试与中断恢复，无限流 |

### 3.3 P3 扩展

| # | 机能 | 代码现状 |
| --- | --- | --- |
| 22 | **TTS 标准朗读**（按句播放/暂停/继续/语速/缓存） | 仅 `TtsProvider` 接口 + `TTS_*` 配置 + `DisabledTtsProvider`；非 disabled 直接抛错 |
| 23 | Agent / skill | 未开始 |
| 24 | 浏览器扩展 | 未开始 |
| 25 | 多设备同步 / 公网部署 | 未开始（产品决策明确「不做」） |

### 3.4 UI 与主题

| # | 机能 | 代码现状 |
| --- | --- | --- |
| 26 | **主题切换 UI**（下拉 + localStorage + `prefers-color-scheme`） | 六套 `[data-theme=...]` 已落地，但 `App.tsx` 无切换入口，只能靠 DevTools 手改 |
| 27 | 非 `paper` 主题对比度微调 | 未做 |
| 28 | 无障碍（`prefers-reduced-motion` / 焦点环 / 深色跟随） | 未做 |

---

## 四、⚠️ 文档与实现已脱节（建议优先修正）

`issues.md` 的优先级汇总表**严重过时，会误导决策**。以下条目实际已完成，但文档仍标「待实施 / 待做」：

| Issue | 文档状态 | 实际状态 |
| --- | --- | --- |
| I-6 `result_json` 宽表瘦身 | 待做 | ✅ 已做（命中 token `source=dictionary` 瘦身落库） |
| I-7 JSON 内缺 `schemaVersion` | 待做 | ✅ 已做（`analysis-service.ts:84` 明确附加） |
| I-11 说话人修正无前端入口 | 待做 | ✅ 已有（`App.tsx:684` 编辑模式 + speaker 输入） |
| I-16 kuromoji 形态素 | 待实施 | ✅ 已实施（`morphology.ts`） |
| I-17 命中 token 瘦身存储 | 待实施 | ✅ 已实施 |
| I-18 句段语义 + 仅词典模式 | 待实施 | ✅ 已实施（`startDictionaryOnly()`） |
| I-19 分析工具页 | 待实施 | ✅ 已实施（`analysis-tools.tsx`，独立页） |
| I-20 用户确认回填 | 待实施 | ❌ **已取消**（决策 2 调整：避免错误解释固化）→ 改为离线扩充固定库 |
| I-21 vitest（「现有 39 项断言」） | 未处理 | 仍成立，但数字应更新为 **93 项** |
| 优先级汇总表 | 把 I-16~I-20 列为「进入实施队列」 | 仅剩「离线扩充固定库」这一条真实待办 |

**结论**：I-16~I-19 四项应从待办队列移除，I-20 应标记为「已取消」，否则会让人误以为降本方案还没做，而实际上它已经是项目里完成度最高的部分。

---

## 五、建议的下一步（按性价比排序）

| 优先级 | 事项 | 理由 |
| --- | --- | --- |
| **高** | 修正 `issues.md` 与 `roadmap.md` 的进度快照 | 零成本，避免后续基于错误前提排期 |
| **高** | 扩充固定用法库（覆盖率 39.7% → 目标 55%+） | 纯本地、零 token；每加一条永久省钱；当前 551 token 仍需 AI 兜底 |
| **高** | 主题切换 UI 接入（I-14） | 六套主题已就绪，只差一个下拉；收益立竿见影 |
| **中** | 导出 JSON/原文（P2） | 本地数据的安全感缺口，实现成本低 |
| **中** | `App.tsx` 拆分（I-13，现 1611 行） | 做范围标注前必须先拆，否则不可控 |
| **中** | `toneEvidence` + `politenessLevel` 枚举 | 补验收缺口，schema 层改动小 |
| **低** | 范围标注 / 四层点击 / 等级解释层 | 需求已定义但工作量大，建议先拆组件再动 |
| **低** | vitest / ESLint | 93 项自研断言已兜住核心逻辑，属工程锦上添花 |

> 涉及云端 LLM 的实测（回归、质量验证）需另行征得同意，遵守 LLM-011。
