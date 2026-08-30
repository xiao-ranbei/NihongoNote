# 分析工具化与内置词典降本设计

**状态**：方案已定（2026-08-29 晚决策确认，待实现）
**日期**：2026-08-29 晚
**提出背景**：用户实测「场景1」（799 字、30 段）消耗 22.5 万 tokens（去重后输入 33,340 + 输出 192,052，medium 档），闲时价约 ¥0.91。用户要求：① 以后未经允许不发起 AI 解析；② 分析功能工具化（收敛为设置页式入口）；③ 内置词典优先解释助词/单词，长段才走 AI。

---

## 一、目标与边界

| 目标 | 说明 |
| --- | --- |
| 降低 AI 消耗 | 固定用法的助词/单词不再每次花 token 让 LLM 解释 |
| 触发显式化 | 任何 AI 解析都必须由用户在工具页手动确认，杜绝自动/验证触发 |
| 结果可追溯 | 词典命中的解释与 AI 解释可区分，用户知道每个词条来自哪里 |

**明确不做**（本设计阶段）：
- 不做公网部署、多用户；
- 不引入需要联网下载的大型词库（保持本地、离线）；
- 不改变现有 `analysisProgressSchema` / token 定位协议（词典结果必须兼容现有 token 结构）。

---

## 二、现状与问题分析

### 2.1 为什么现在贵（实测数据，medium 档）

| 项 | 数值 | 占比 |
| --- | --- | --- |
| 输入 tokens（去重后） | 37,329 | 14% |
| 输出 tokens（去重后） | 222,964 | 86% |
| 其中推理过程（估算，回归实测 72.8%） | ≈162,318 | 62% |
| 最终答案 | ≈60,646 | 24% |
| **合计** | **260,293** | 100% |

- 单段输出均值 6,622 tokens，其中约 4,800 是模型"思考过程"（reasoning）；
- 342 个词条每个都要输出 14 字段 JSON（读音/释义/类别/置信度等），JSON 序列化开销远大于内容本身；
- 长段语义判断（tone/impliedMeaning/replyReason）本身重，但助词类固定用法完全不需要。

### 2.2 成本构成拆解（助词是最大浪费点）

现有 342 个词条中 **particle 102 个（30%）**，全部由 LLM 生成解释。`の` 一个助词就出现 32 次，每次都是一段完整的 14 字段 JSON——这是最典型的"固定用法重复付费"。

---

## 三、方案设计（已决策）

### 3.1 总架构：三层解析链

```
用户点击「分析」→ 本地预处理（免费）
  ├─ ① 形态素分析（kuromoji.js，新增，免费）
  │     分词 + 词性 + 原形 + 读音（lemma/reading/partOfSpeech/conjugation 直接填）
  ├─ ② 解释缓存查表（新增，免费）
  │     命中 → 直接取 explanation/gloss（**固定用法库是唯一受信任来源**；用户运行时回填已取消）
  │     未命中 → 进入 AI 候选
  └─ ③ LLM 解释层（按量）——只处理 ② 未命中的 token + 句段级语义
        结果与词典结果合并为完整 segment 分析
```

**核心原则**：`tokenAnalysisSchema` 的 14 字段中，`lemma/reading/partOfSpeech/conjugation` 是**纯语言学事实**（本地确定，无需 LLM）；`gloss/explanation/particleFunction/grammarPoint` 是**解释层**（缓存优先，LLM 兜底）；句段级语义（tone/impliedMeaning/replyReason）是**理解层**（仍走 AI，见 3.4）。

### 3.2 形态素分析层（决策 1：kuromoji.js）

| 项 | 方案 |
| --- | --- |
| 选型 | **kuromoji.js**（本地词典，基于 IPADIC 数万词条） |
| 职责 | 分词 + 词性 + 原形 + 读音，确定性生成，替代/增强现有 `Intl.Segmenter` + 合并后处理 |
| 收益 | 4 个事实字段本地确定，砍约 30% 输出字段；顺带解决 T-1 分词碎片化残留问题（かって/どのよう/お時間 等） |
| 代价 | 词库 1–2MB（纯本地可接受）；IPADIC 对专名/新词覆盖一般 |
| 兜底 | 第 ③ 层 LLM 必须保留，专名/新词/未收录词走 AI |

> **实测决策（2026-08-29 实施步骤 2）**：kuromoji 对动词连用形/复合助动词系统性单飞
> （`毎日|日本語|を|勉強|し|て|い|ます`、`でしょ|う`），且 IPADIC 仍把「かって」「お」拆开，
> 不能单独满足 T-1 分词期望 → **并存的形态**：token 边界保留 `tokenization.ts` 的合并后处理，
> 新增 `morphology.ts`（kuromoji）只按偏移区间提供 4 个事实字段；边界不一致的 token
> 不填充（对齐前缀约束），交 LLM 兜底。verify 新增 9 条断言固化该决策（57/57 通过）。

### 3.3 解释缓存层（决策 2 调整：固定用法库是唯一受信任解释来源）

> **2026-08-29 晚调整**：原计划为「固定用法库起步 + 用户确认回填」，但用户回填的「确认」本身无法保证准确性，反而有把错误解释固化进缓存的风险。调整为：**固定用法库是唯一受信任解释来源**——所有缓存命中必须来自人工编辑的固定库（confidence=1.0），不允许用户运行时写入。
>
> 这也意味着「越用越省」的实现路径由「运行时用户回填」转为「离线扩充人工编辑的固定库」——每加一条人工校对条目，永久省一条 AI 解释的 token。

| 项 | 方案 |
| --- | --- |
| 来源 | **固定用法库（唯一来源）**——人工编辑的助词/功能词/句末模板 TS 表 |
| 固定用法库 | 预置助词（particle ~45 条：の/を/が/て/と/に/か/ね/は/まで/で/へ 等，覆盖实测 TOP）+ functional ~33 条 + 常见句末语气模板 ~16 条 |
| ~~用户确认回填~~ | ❌ **已取消**——用户回填的解释可能本身就有误，固化进缓存反而扩大错误面 |
| 数据格式 | 纯数据 TS/JSON 表；与 `TokenAnalysis` 对齐（surface/category/reading/explanation/gloss 等） |
| 置信度 | 全部命中 `confidence=1.0`、来源 `dictionary`（没有 0.9 用户回填档） |
| 版本 | `dictionaryVersion` 字段，与 promptVersion 并列，保证可追溯 |
| 扩充方式 | 离线 PR/手工补充条目 → 重新统计覆盖率 → 工具页自动显示新版本号 |

### 3.4 句段级语义（决策 4：仍走 AI + 词典化兜底）

| 字段 | 处理 |
| --- | --- |
| tone / impliedMeaning / replyReason / uncertaintyNote | **仍走 AI**——真正需要理解的部分，缓存替代不了 |
| grammarSummary | 仍走 AI（句段级概括） |
| 词典化兜底 | 固定用法库内置常见句末语气模板（～ますね/～でしょう/～そうです…），命中时提供**参考语气/礼貌度**给 prompt 或直接填充简单字段，覆盖有限但可省去整段对简单句的 AI 调用 |
| 仅词典模式 | 提供「仅词典分析」（不调 AI）独立模式，用户只想查词不想花钱时使用（见 3.5） |

### 3.5 分析工具化（设置页式入口）

| 项 | 方案 |
| --- | --- |
| 入口位置 | 侧栏/顶部「分析工具」页（与设置页同级），非正文内嵌按钮 |
| 职责 | 设置页管全局配置（provider/模型/档位/词典开关/预算上限）；工具页只做「选文章 → 预览 → 确认 → 看进度」单一动作 |
| 功能 | ① 选择文章（支持多选批量）；② 预览词典/AI 混合策略（词典覆盖多少 token、AI 只处理哪些）；③ 费用预览（按余额与闲时/高峰估算）；④ 明确按钮「开始 AI 分析」+ **成本确认弹窗**（预计 token/费用/时长/词典覆盖，确认才发请求，落实 LLM-011） |
| 模式 | 「完整分析」（词典 + AI）与「仅词典分析」（零费用）两种模式可选 |
| 取消/重试 | 复用现有分析进度与取消机制，工具页展示进度 |
| 档位 | 工具页可临时选择 reasoning_effort（默认 minimal，来自配置）；**段级语义字段档位**（minimal/standard/full，见 3.8）在模式选择区切换并自动重算预览 |

### 3.6 数据流变化

```
[保存文章] → 本地分段/形态素分析（免费，立即完成，产出事实字段）
[工具页选择文章 + 确认]
  ├─ 完整分析 → 缓存命中 token 直接落库（source=dictionary）
  │            未命中 token + 句段级语义走 LLM batch
  │            合并写入 segment_analyses
  └─ 仅词典分析 → 全部走缓存，零调用 LLM
```

### 3.7 schema 扩展（决策 3：瘦身存储）

- `TokenAnalysis` 增加 `source?: "dictionary" | "llm"`（可选，向后兼容）；
- **瘦身存储**：词典/缓存命中的 token 只存必要字段——`tokenId + category + surface + explanation + source`（+ 固定用法库的 reading/gloss），**不存恒定 null 的 14 字段宽表**；未命中的 token 才走完整宽表；
- `segmentAnalysisSchema` 增加 `dictionaryCoverage?: { matched: number; total: number }`（预览与结果都可展示覆盖率）；
- 落库 `segment_analyses` 沿用 result_json 内 source 字段；
- JSON 内嵌 `schemaVersion`（见 issues I-7，随本方案一并实施）。

### 3.8 段级语义字段档位（决策 5：档位制 + 键级省略）

**背景**：段级固定开销 ≈3,500 输出 tokens/段，其中约 72.8% 是模型思考过程——字段越多，模型要斟酌的内容越多。7 个字段里 `replyReason`（仅对话段有意义）、`impliedMeaning`（多数为 null）、`tone`/`politeness`（可合并）对普通叙述文价值有限。

**方案**：档位只改 systemPrompt 的字段要求，schema/存储/UI 完全兼容（缺失字段经 `default(null)` 降级，旧数据照常可读，无需迁移）。

| 档位 | 要求模型输出的段级字段 | 预估输出/段 | 场景1（30 段）段级估算 |
| --- | --- | --- | --- |
| `full` | 全部 7 字段（历史行为） | ~3,500 | ~105,000 tokens |
| `standard`（默认） | translation + grammarSummary + **register**（tone/politeness 合并）+ uncertaintyNote | ~2,200 | ~66,000 tokens |
| `minimal` | translation + grammarSummary | ~1,500 | ~45,000 tokens |

- **键级省略**（standard 起）：可选字段（register/uncertaintyNote）无值时不输出键——模型不为写 `null` 而思考，省序列化与思考 token；
- **register 字段**：`segmentAnalysisSchema` 新增 `register`（nullable，向后兼容）；UI 展示 register 优先、tone/politeness 兜底（旧数据）；
- **档位透传**：`LLM_SEGMENT_FIELDS` env 设默认档位（默认 standard）；工具页模式选择区可切换并自动重算预览（零 LLM）；预览估算（`previewCoefficientsByProfile`）与实际分析（`buildSystemPrompt(profile)`）用同一档位，费用估算口径一致；
- **预览系数**：full 3,500/段 + 400/未命中 token（历史标定）；standard 2,200 + 320；minimal 1,500 + 300；输入侧三档同值（prompt 长短差异极小）。

### 3.9 Ollama 本地模型支持（决策 6）

**背景**：成本敏感用户可能希望零 API 费用跑本地模型（家用显卡/CPU）。现有 provider 抽象已统一走 OpenAI 兼容层，Ollama `/v1` 端点天然对齐。

**方案**：

| 项 | 方案 |
| --- | --- |
| 配置 | `LLM_PROVIDER=ollama`、`LLM_BASE_URL=http://127.0.0.1:11434/v1`、`LLM_MODEL=qwen3.5:9b`（示例；实现通用，模型可换）；**无需 `LLM_API_KEY`** |
| configured | ollama 恒为 true（无 key 也算配置完成，localhost 免鉴权） |
| client | 用占位 key `"ollama"` 构造 OpenAI SDK client（SDK 只要求非空字符串，Ollama 忽略 Authorization header） |
| 余额 | `fetchBalance()` 对 ollama 直接返回 null（无 `/user/balance` 端点）→ 前端「余额未知」 |
| 价格 | 模型不在内置价格表 → 预览费用显示「**本地免费（零 API 费用）**」（`preview.provider.isLocal=true`），而不是误导性的「价格未知」 |
| JSON 模式 | ollama 不发 `response_format`（Ollama 兼容层对 JSON 模式支持不稳定），靠 prompt「Return raw JSON only」约束 |
| thinking | 非 deepseek 默认不发 thinking/reasoning_effort（config 已有逻辑），本地模型直接输出 |

**风险**：本地模型遵循 JSON 指令的能力决定可靠性（qwen3 系较好）；速度远慢于云端 API（时长估算按输出 token 速率已体现）；显存不足会 OOM（需用户自选合适量化档）。

---

## 四、技术栈

| 层 | 现状 | 变更 |
| --- | --- | --- |
| 后端 API | Fastify 5 + TS | 新增 `dictionary-service` + 词典数据文件 + kuromoji 集成；`analysis-service` 集成三层链路 |
| 共享契约 | packages/core（Zod） | 扩展 schema（source 字段、coverage、瘦身 token） |
| 前端 | React 19 + Vite 6 | 新增「分析工具」页面（路由级），复用现有进度/取消组件 |
| 存储 | sql.js | 无新增表（复用 segment_analyses，source 入 JSON） |
| 依赖 | **新增 1 个**：kuromoji | 其余零新增（词典为纯数据文件） |

---

## 五、影响范围

| 模块 | 影响 | 风险 |
| --- | --- | --- |
| `packages/core/domain.ts` | TokenAnalysis source 字段 + 瘦身 token 形态（部分字段 optional） | 低——向后兼容，旧数据不受影响 |
| `apps/api/src/tokenization.ts` | 边界保留（实测 kuromoji 单飞连用形，不能替换）；新增 `morphology.ts` 并存做字段 | 低——并存不动现有切分，verify 断言兜底 |
| `apps/api/services/analysis-service.ts` | 三层链路（形态素 → 缓存 → LLM）+ 合并逻辑 | 中——合并需保持 token 顺序与 ID 稳定 |
| `apps/api/repositories/document-repository.ts` | 瘦身 token 落库路径 | 低——沿用现有写入 |
| `apps/api/routes/*` | 新增词典预览/覆盖率端点 | 低 |
| `apps/web/src/App.tsx` | 新增工具页路由 + 导航 | 中——路由结构调整 |
| `apps/web/src/api/client.ts` | 新端点客户端 | 低 |
| 验证管线 | verify-pipeline.ts 新增词典断言（查表命中、未命中降级、瘦身格式） | 低 |

**不影响的**：LLM provider adapter（不改协议）、token 定位协议（offset/ID 不变）、费用估算（llm-pricing 不变，词典命中无 usage 自然不计费）。

---

## 六、实施顺序（决策已定，按此执行）

1. **词典数据 + 查表服务**（纯后端，可离线验证）：固定用法库初始表 + `lookupToken()` + verify 断言；
2. **kuromoji 集成**：✅ 已完成（2026-08-29）——新增 `morphology.ts`（kuromoji 封装 + pos→category 映射 + alignMorphology 偏移对齐）；实测对比后决策**并存**：边界保留现有合并后处理，kuromoji 只做事实字段；verify 9 条断言固化（57/57）；
3. **analysis-service 三层链路**：✅ 已完成（2026-08-29）——core schema 扩展（TokenAnalysis.source / 解释字段 optional 瘦身 / segmentAnalysis.schemaVersion / dictionaryCoverage）；`prepareSegmentTokens()`（形态素+词典命中不进 LLM）+ `mergeAnalysis()`（按边界顺序合并、不重不漏、附加 coverage）；mock provider 端到端断言「LLM 只收到未命中 token」+ 瘦身落库（verify 62/62）；
4. **工具页**：✅ 已完成（2026-08-29）——`POST /api/analysis/preview`（纯本地统计词典覆盖 + 估算 token/闲时高峰费用/时长，零 LLM）+ `POST /api/analysis/start`（批量，full / dictionary-only 双模式）；`AnalysisService.startDictionaryOnly()`（仅词典零费用落库，瘦身 token + 段级字段 null + 来源标记 dictionary）；前端「分析工具」页（顶栏切换，多选文章 → 模式选择 → 策略/费用预览 → 成本确认弹窗 → 唯一触发按钮 → 进度轮询），落实 LLM-011/LLM-013；`prepareSegmentTokens` 独立为 `segment-preparation.ts` 供服务与预览共用（避免循环依赖）；verify 新增 8 条断言（70/70）；
5. ~~**回填沉淀**：用户在解析卡上「确认这条解释」→ 沉淀为缓存条目~~ → ❌ **已取消**（决策 2 调整）：用户回填的解释本身可能就有误，固化进缓存反而扩大错误面。改为「**离线扩充人工编辑的固定用法库**」作为「越用越省」的实现路径——每加一条人工校对条目，永久省一条 AI 解释的 token；
6. **回归（需用户批准）**：用现有两篇样本跑词典覆盖率统计（纯本地查表可先行，不消耗 token）；AI 路径回归在用户许可后执行。
7. **段级字段档位制 + Ollama 支持**：✅ 已完成（2026-08-30）——core 新增 `segmentFieldProfileSchema`（minimal/standard/full）与 `segmentAnalysisSchema.register`；prompt 档位化（`buildSystemPrompt`，standard 起键级省略）；`LLM_SEGMENT_FIELDS` env；预览系数按档位取值（full 3500 / standard 2200 / minimal 1500 每段）；工具页档位切换自动重算预览；Ollama provider 放行（无 key 视为 configured、余额不可用、预览显示「本地免费」、不发 response_format）；verify 新增档位系数断言。

---

## 七、决策记录（2026-08-29 晚）

| 决策 | 结论 | 对应 issues |
| --- | --- | --- |
| 决策 1：形态素分析器 | **kuromoji.js** | I-16 |
| 决策 2：解释缓存来源 | **固定用法库是唯一受信任解释来源**（2026-08-29 晚调整，砍掉「用户确认回填」以避免错误解释固化） | I-20 |
| 决策 3：命中 token 存储 | **瘦身存储**（只存必要字段 + source，不存宽表） | I-17 |
| 决策 4：句段级语义 | **仍走 AI + 词典化兜底**（句末语气模板）；提供「仅词典分析」模式 | I-18 |
| 决策 5：段级字段档位（2026-08-30） | **档位制 + 键级省略**——minimal/standard/full 三档，默认 standard；合并 tone+politeness → register、可选字段无值不输出键；只改 prompt，schema/存储零迁移 | I-21 |
| 决策 6：本地模型（2026-08-30） | **Ollama 支持**——registry 放行 provider 名，复用 OpenAI 兼容抽象；无 key 视为 configured、余额不可用、预览费用显示「本地免费」、不发 response_format | — |
| 工具页形态（I-19） | 独立页面（倾向），实施时与设置页一并确认 | I-19 |

---

## 八、成本预期（估算）

- 助词类固定用法约占当前 token 的 30%（102/342 词条）；词典化助词 + 形态素填充事实字段，AI 输出可望减少 **40–50%**（4 事实字段本地化 + 助词缓存双管齐下，具体以词典覆盖率实测为准，纯本地可先行统计）；
- 词典查表与形态素分析零 token、零费用；
- 句段级语义（tone/replyReason）仍走 AI，是词典无法替代的部分；
- `reasoning_effort=minimal` 已生效，进一步压缩推理 token；
- **段级字段档位**（3.8）：standard 档将段级输出从 ~3,500 降到 ~2,200/段（省约 37%），minimal 档 ~1,500/段（省约 57%）；档位同时压缩模型「思考内容」，实际节省通常好于字段比例；场景 1（30 段）段级估算费用从 ¥0.47 降到 standard ¥0.31 / minimal ¥0.20（闲时）；
- **Ollama 本地模型**（3.9）：零 API 费用，只消耗本地算力与时间，适合高频低预算场景。

---

## 九、设计评审补充（2026-08-29 晚，设计师视角）

### 9.1 工具化的 UX 补充

- **成本确认弹窗**：点「开始分析」后弹窗展示预计 token / 费用（闲时与高峰）/ 时长 / 词典覆盖，用户确认才发请求——把 LLM-011「人工许可才解析」落地为产品交互而非口头约定；
- **设置页与分析工具页职责拆分**：设置页管全局配置（provider / 模型 / 档位 / 词典开关 / 预算上限），分析工具页只做「选文章 → 预览 → 确认 → 看进度」单一动作；
- **批量分析队列**：多选文章 → 统一预览总费用 → 一次确认 → 队列执行，降低高频使用摩擦，预算更可控。

### 9.2 JSON 格式盘点与优化（现状分析）

**现有 7 套 JSON（职责各异，非冗余）**：

| # | 格式 | 位置 | 写入者 | 字段 | Schema |
| --- | --- | --- | --- | --- | --- |
| 1 | content_blocks_json | documents | 本地分段器 | 9 | contentBlockSchema |
| 2 | content_type_suggestion_json | documents | 本地启发式 | 4 | contentTypeSuggestionSchema |
| 3 | result_json | segment_analyses | LLM | 9 顶层 + tokens[]×14 | segmentAnalysisSchema |
| 4 | usage_json | segment_analyses | SDK 用量 | 3（缺缓存） | LlmUsage |
| 5 | analysis_revisions | analysis_revisions | 用户修正 | 3 | analysisRevisionSchema |
| 6 | API 请求/响应体 | 传输层 | 前后端 | — | documentDetailSchema 等 |
| 7 | LLM 原始响应 + 调试日志 | 内存/JSONL | provider | batch analyses[] | 无 |

**为何多套**：每个写入者一个格式（分段器/启发式/LLM/用户各管各的）；sql.js 无原生 JSON 类型，一列一 JSON；Zod 契约与 DB 持久化分离。这是合理边界，不是缺陷。

**4 个优化点**：
1. **usage_json 缺缓存字段**（最该修）：42 条历史数据全部只有 3 字段，缓存字段（offPeakCached/offPeakUncached）后加未缓存字段为空，影响费用估算。修法：一次性迁移脚本，旧数据按未命中处理；
2. **result_json 宽表瘦身**：14 字段每 token 必填，恒定 null 也占 token。词典/形态素命中的 token 只存必要字段（见 3.7），未命中的才走完整宽表；schema 非必填字段改 optional，向后兼容；
3. **JSON 内缺 schemaVersion**：版本只挂在 prompt_version 列，result_json 自身无版本号，建议内嵌 `schemaVersion: 1` 便于迁移；
4. **原始响应与规范化结果分离**（已做对）：provider 层已拆分，保持现状不合并。
