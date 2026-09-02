# 「分析失败」调查报告（2026-09-01）

> 调查对象：`apps/api` 分析流水线中句段落 `failed` 状态的成因。
> 诊断手段：本地 Ollama（`qwen3.5:9b`，本机推理，**零云端费用**）。全程未调用任何云端 LLM。
> 结论状态：8 条历史失败记录已全部归因，其中 2 条当前仍可 100% 复现。

---

## 一、排查范围界定

明确本次排查的是**「句段级 LLM 分析」链路**，不是分词/预处理链路。完整流水线与失败落点：

| # | 阶段 | 位置 | 是否失败源 | 说明 |
| --- | --- | --- | --- | --- |
| ① | 本地分词（边界计算） | `tokenization.ts` / kuromoji | **否** | 确定性、零 LLM；8 条失败记录所在段 boundary 均正常产出 |
| ② | 词典/形态素预处理 | `segment-preparation.ts` | **否** | 零 LLM；实测段 7 命中 10/35、段 9 命中 8/19，正常 |
| ③ | 请求校验 | `validateRequest()` | 否 | 偏移量/ID 一致性校验，本次无触发 |
| ④ | **LLM 调用（HTTP + 流式读取）** | `ollama.ts` | **是（根因 1、3）** | 超时、服务不可用在此抛出 |
| ⑤ | **JSON 解析** | `parseJsonResponse()` | **是（根因 2）** | 模型输出非法 JSON 在此抛出 |
| ⑥ | 逐段 schema 校验 | `segmentAnalysisSchema` | 历史（已修复） | 旧版 `confidence`/`politeness` 缺失，prompt v5 后未再出现 |
| ⑦ | 合并本地 + LLM 结果 | `mergeAnalysis()` | 否 | 无触发 |
| ⑧ | 落库 | `document-repository.ts` | — | 只是记录失败信息 |

**失败信息落点**：`analysis-service.ts:456`（整批异常）与 `:525`（逐段校验失败），经
`document-repository.ts:714/790` 归一化后写入 `segments.error_message`；
句段全 failed 时文档置 `failed`。UI 在 `App.tsx:822` 显示「本句分析失败」。

---

## 二、排查步骤与发现

### 步骤 1：定位失败记录（DB 直查）

`apps/api/data/nihongonote.db` 全库统计：

```
segments  : completed 95 / failed 8
documents : ready 2 / failed 2
```

8 条失败记录按错误类型归类：

| 时间 (UTC) | 文档 | 段 | 错误信息 | 归类 |
| --- | --- | --- | --- | --- |
| 08-29 04:35 | (f3ef5b40) | 1,2 | `LLM response was truncated at the token limit` | 输出截断（**已修复**） |
| 08-29 04:43 | (27e8f559) | 0,1,2 | `schema (tokens.0.confidence: Expected number, received string)` | schema 不匹配（**已修复**） |
| 08-29 10:11 | 场景1 | 23 | `schema (politeness: Required)` | schema 不匹配（**已修复**） |
| 08-30 15:26 | 场景2 | 9 | `LLM returned invalid JSON: Expected ',' or '}' … position 1296 (line 38 column 41)` | **JSON 解析失败（现存）** |
| 08-30 15:36 | 场景2 | 7 | `LLM request timed out after 60000ms` | **请求超时（现存）** |

> 前 6 条属 08-29 旧版本（自适应 token 上限 + prompt v5 前的缺陷），已由后续迭代修复，
> 本次不重复处理。真正需要修的是后 2 条。

### 步骤 2：检查输入数据格式

对两个失败段跑本地预处理（零 LLM）：

| 段 | 字符 | boundary | 词典命中 | 送 LLM | 已记录错误 |
| --- | --- | --- | --- | --- | --- |
| 7 | 90 | 35 | 10 | 25 | 超时 60000ms |
| 9 | 50 | 19 | 8 | 11 | JSON 位置 1296 / L38 |

**输入数据格式完全正常**——分词边界、偏移量、词典命中均无异常，问题不在输入侧。

### 步骤 3：确认本地模型调用与参数配置

配置优先级为 **db（`app_settings` 表 `llm` 键）覆盖 `.env`**：

| 参数 | 生效值 | 来源 |
| --- | --- | --- |
| provider | `ollama` | db |
| baseUrl | `http://127.0.0.1:11434` | db |
| model | `qwen3.5:9b` | db |
| temperature | 0.2 | db |
| maxTokens | 12000 → 实际 8192（Ollama 内存保护封顶） | db |
| segmentFields | `standard` | db |
| **timeoutMs** | **60000** | **.env（设置页不暴露）** |
| batchSize / concurrency | 1 / 1 | .env |
| debugLogging | **false** | .env |

发现三个配置问题：

1. **`LLM_TIMEOUT_MS=60000` 是硬编码在 `.env` 的旧值**，代码默认值是 300000ms；
   设置页无法修改（`settings.ts:241` 注释明确 timeoutMs 不在 `LlmSettings` 中）。
2. **`LLM_DEBUG_LOGGING=false`** → 08-30 15:24 之后的两次失败没有原始响应留存，
   排查时只能重跑复现。
3. **db 中 `profile-current` 配置串味**：`provider=deepseek` + `model=qwen3.5:9b`
   ——切到该配置会拿本地模型名去打云端 API，必然 `model not found` 失败（潜在失败源）。

### 步骤 4：错误类型定位（实测复现）

检查本地服务时发现 **Ollama 进程未运行**（`127.0.0.1:11434` 连接被拒绝）。
模型文件完整（`D:\Ollama\Models`，`qwen3.5:9b` Q4_K_M / 9.7B / context 262144）。
启动服务后用真实样本复现：

| 段 | 复现配置 | 结果 |
| --- | --- | --- |
| 7 | timeout 60s | **✗ 60014ms → `timed out after 60000ms`**（与历史记录一致） |
| 7 | timeout 600s | **✓ 78135ms，输出 4995 tokens，63.9 tok/s** |
| 9 | timeout 60s | **✗ 37175ms → `invalid JSON … position 1227 (line 38 column 34)`** |

---

## 三、失败根因

### 根因 1：`LLM_TIMEOUT_MS=60000` 低于本地模型实际所需时间（确定性失败）

- 段 7 实测需 **78.1 秒**，超时阈值 **60 秒** → 必然失败。
- 现有「自动重试一次」机制对此**完全无效**：重试仅等待 1 秒，超时上限不变，
  第二次必然同样超时（`analysis-service.ts:428-462`）。
- 因此这不是偶发抖动，而是**配置性永久失败**，重试次数再多也救不回来。
- 按实测速率外推：60s 内约可生成 3834 输出 tokens，对应**送 LLM 的 token 数上限 ≈ 19**。
  全篇扫描（场景 2，25 段）确认只有段 7（25 tokens）越线，其余 24 段安全。

### 根因 2：本地 9B 模型稳定退化全角闭引号为 ASCII 双引号（确定性失败）

抓到段 9 原始输出的第 37 行：

```json
"grammarPoint": "数量词，与“1"组成“1 つ”，表示单数或一个单位",
```

开启引号用的是全角 `“`（U+201C），**闭合时写成了 ASCII `"`（U+0022）**——
JSON 字符串在此被提前终止。全篇共 **12 处**同类错误，且两次运行出错位置几乎相同
（position 1296 vs 1227，同为 line 38），证明是**确定性触发而非随机抖动**。

- 现有 prompt 规则（「Inside the text of a string value, never place an ASCII double quote」）
  对 9B 模型**无效**——生成长文本时无法稳定遵守。
- 现有 `parseJsonResponse()` 只处理裸控制字符，**不处理此类引号退化**。
- 重试机制同样无效：相同输入大概率产出相同错误模式。

### 根因 3：Ollama 服务未常驻时静默失败

`OllamaProvider.configured` 恒为 `true`（本地免鉴权设计），因此服务不在时
provider 仍判定「可用」，每次分析都发起请求再 `fetch failed`，
所有句段被标记为 failed。UI 只显示「本句分析失败」，不提示「本地模型服务未启动」。

### 已修复的历史问题（供对照）

| 错误 | 修复手段 |
| --- | --- |
| `confidence: Expected number, received string` | prompt v5 强化 confidence 规则 + schema default |
| `politeness: Required` | schema default(null) 降级 |
| `truncated at the token limit` | `llm-budget.ts` 自适应 token 上限 + `planBatches` 按预算装箱 |

---

## 四、修复方案

### P0 — 修 JSON 引号退化（根治根因 2，改动小、收益最高）

在 `providers/openai-compatible.ts` 增加 `repairStrayQuotes()`，
在 `parseJsonResponse()` 的 `JSON.parse` 失败后、**在放弃之前**插入一层修复：

逐字符扫描并跟踪 `inString` 状态；当处于字符串内部遇到 `"` 时，
向前跳过空白看下一个字符：

- 若为 `,` `}` `]` `:` 或已到末尾 → 是合法的**结构闭合引号**，保留；
- 否则 → 是**字符串内部的迷途引号**，替换为全角闭引号 `”`（U+201D）。

**已实测验证**（对段 9 原始输出 `data/raw-capture-segment-9.txt`）：

```
原始        : ✗ Expecting ',' delimiter: line 37 column 36
修复后      : ✓ JSON 合法
schema 校验 : ✓ PASS（11/11 tokens，confidence 全为数字）
内容质量    : ✓ 翻译「我想确认一件事，商谈历史的数据库是否应该让销售以外的部门也能查阅？」
```

该修复同时惠及云端 provider，且对合法 JSON 零副作用（只在解析失败时触发）。

**配套（可选）**：把 prompt 里的引号示例从 `“…”` 改为 `「…」`——
`「」` 与 ASCII 无混淆路径，可从源头降低退化概率。

### P1 — 放开超时（根治根因 1）

`.env` 中 `LLM_TIMEOUT_MS` 从 `60000` 恢复到 `300000`（代码默认值）。
本地模型单段实测 37–78 秒，300s 有充足余量。

同时建议补两处改进：

1. **重试前验证重试价值**：当前「重试一次」对超时类失败是纯浪费（必然再失败）。
   建议超时错误直接落 failed，不重试；只对连接类/5xx 错误重试。
2. **超时提示带上实测建议**：错误信息里附上「该段预估需 N 秒」，
   而不是一句干巴巴的 `timed out after 60000ms`。

### P2 — 服务不可用的快速失败与提示（根治根因 3）

`OllamaProvider` 在 `analyze()` 开始前先探活 `/api/tags`，
拿不到响应就抛 `ProviderConfigurationError("本地模型服务未启动：…")`，
让 UI 显示可操作的指引，而不是让每个句段都跑一遍 60 秒超时。

### P3 — 排查可观测性

`.env` 的 `LLM_DEBUG_LOGGING` 保持 `true`（本地推理不产生费用），
并在 `llm.json.invalid` 事件中记录完整原文（当前上限 8000 字符，
长响应可能截断了真正的出错位置）。

### 清理 db 中的串味配置

`app_settings.llm.profiles` 里 `profile-current` 是 `provider=deepseek` + `model=qwen3.5:9b`，
建议在设置页删除或修正为本地模型对应的 provider，避免误切导致必然失败。

---

## 四之二、修复落地记录（2026-09-01 已实施）

| 项 | 改动 | 验证 |
| --- | --- | --- |
| **P0** | `providers/openai-compatible.ts` 新增 `repairStrayQuotes()`；`parseJsonResponse()` 改为三级修复链：原样解析 → 控制字符转义 → 引号修复 | verify 新增 5 条用例全 PASS；**实机复跑段 9 成功**（38.3s，输出 2412 tokens） |
| **P1** | `apps/api/.env`：`LLM_TIMEOUT_MS` 60000 → **300000**（附注释说明实测依据） | **实机复跑段 7 成功**（82.8s，输出 4915 tokens）；全篇超时风险段 1 → **0** |
| **P2** | `providers/ollama.ts`：`analyze()` 前 `assertServerReady()` 探活 `/api/tags`，区分「服务未启动」「模型未安装」 | verify 新增 1 条用例 PASS：连未监听端口抛 `ProviderConfigurationError`，消息含「未启动或无法连接…请先启动 Ollama」 |
| **P3** | `apps/api/.env`：`LLM_DEBUG_LOGGING` false → **true**（附注释） | 已生效；诊断脚本原先写死 `false`，一并把 `llmDebugLogging` 改回跟随 `.env` |
| 诊断脚本 | `diagnose-failures.ts` 的 `llmDebugLogging` 改为 `appConfig.llmDebugLogging`（原先写死 false，与真实服务不一致，导致实测不落日志） | 阶段 0 打印确认 `debugLogging = true` |

回归结果：**`verify-pipeline` 93/93 通过**（原 87 + 新增 6 条），
`tsc -p tsconfig.scripts.json --noEmit` 干净。

### 实机复跑结果（修复后）

```
provider=ollama model=qwen3.5:9b timeout=300000ms budget=8192
✓ 段 7 成功 82819ms | 输出 4915 tokens (59.3 tok/s) | 解析 1 | 失败 0
✓ 段 9 成功 38277ms | 输出 2412 tokens (63.0 tok/s) | 解析 1 | 失败 0
```

两个原失败段全部救回。注意段 9 这次是**模型照样吐出退化引号、由 P0 修复层救回**——
修复的是解析层，不是模型行为，因此对该类确定性缺陷是长期有效的兜底。

### 遗留项处理（2026-09-01 后续，两项均已闭环）

#### ① db 中 `profile-current` 串味配置 —— 已删除

该配置形如 `provider=deepseek` + `baseUrl=http://127.0.0.1:11434` + `model=qwen3.5:9b`，
切到它会拿本地模型名打云端 API，必然 `model not found`。

成因已定位：`ensureLlmProfiles()` 迁移旧单组设置时，`.env` 里
`LLM_PROVIDER` 仍是 `deepseek`（未改），而 `LLM_BASE_URL` / `LLM_MODEL` 已指向本地 Ollama，
于是「自定义配置」把两边拼在了一起。属迁移产物，**不是用户手工创建的**
（前端新建配置用的是 `profile-${Date.now()}`，见 `apps/web/src/settings.tsx:206`）。

处理：删除该项，保留内置双配置（`profile-deepseek` / `profile-ollama`），
`activeProfileId` 维持 `profile-ollama`，顶层生效字段保持
`ollama / http://127.0.0.1:11434 / qwen3.5:9b` 不变。
删前已备份 `data/nihongonote.db.bak-20260902-084940`。

删除而非修正的理由：修正后它与 `profile-ollama` 的 provider/baseUrl/model 完全一致，
仅 `maxTokens`(24000 vs 12000) 与 thinking 字段不同，而这两项对 Ollama 无效——
`OllamaProvider` 把 `maxTokens` 压到 `min(maxTokens, 8192)`（`ollama.ts:104`），
且走原生 `/api/chat` 时 `think` 恒为 false。也就是说删掉它在运行时零损失，
只少了一个「点进去就失败」的坑。

#### ② `.env` 的 `LLM_BATCH_SIZE` / `LLM_BATCH_CONCURRENCY` —— 结论是不改，维持 1/1

原先考虑放宽到默认 3 / 2 提速，核查后**该提速路径对本地模型不存在**：

`analysis-service.ts:553` 的装箱预算是
`provider.completionTokenBudget × packingSafetyRatio` = `min(maxTokens, 8192) × 0.77` = **6308**；
`planBatches()` 用 `estimateCompletionTokens`（`3,500/段 + 230/字符`，DeepSeek 标定）累加，
**两个 1 字段落的最小开销就是 `2×3500 + 2×230 = 7460 > 6308`**。
即本地模型下批次恒为 1 段，`LLM_BATCH_SIZE` 调到多少都是空转。

唯一真正的并行杠杆是 `LLM_BATCH_CONCURRENCY=2`（同时发两个请求），但按
`num_ctx=12288 → KV ≈7GB`、权重 ≈6.6GB 的实测标定，两路并发约需 20.6GB > 16GB VRAM，
Ollama 会把第二个请求排队而非真并行，收益接近于零，却要承担此前 40K `num_ctx`
OOM 崩溃同类的显存风险。故**维持 1/1**。

> 附带结论：`estimateCompletionTokens` 对本地模型高估约 4.8 倍（见下方标定数据），
> 方向是「宁可高估」，只让批次变小、请求变多，不影响正确性，暂不改动。
> 若日后要为本地模型做真正的批量提速，正确的做法是先给 provider 加一个
> `estimateOutputTokens` 钩子按本地标定估算，而不是简单调大 `LLM_BATCH_SIZE`。

## 五、附：诊断工具（已落盘，可复用）

| 脚本 | 用途 | 命令 |
| --- | --- | --- |
| `apps/api/scripts/diagnose-failures.ts` | 配置体检 + 服务探活 + 本地预处理 + 全篇超时风险扫描 + LLM 实测复现 | `npx tsx scripts/diagnose-failures.ts` <br> `… --llm` <br> `… --llm --generous-timeout` |
| `apps/api/scripts/capture-raw-output.ts` | 抓取单段模型原始输出并定位非法字符 | `npx tsx scripts/capture-raw-output.ts 9` |

两个脚本默认**零 LLM 调用**（只有加 `--llm` 或 capture 脚本才调本地模型），
均通过 `tsc -p tsconfig.scripts.json --noEmit` 类型检查。
目标文档/段可用 `DIAG_DOCUMENT_ID` / `DIAG_INDICES` 环境变量覆盖。

### 实测标定数据（供后续容量规划）

`qwen3.5:9b`，`num_ctx=12288`，`num_predict=8192`，`think:false`，`temperature=0.2`：

| 段 | 送 LLM tokens | 输出 tokens | 耗时 | 速率 |
| --- | --- | --- | --- | --- |
| 7（90 字符 / 35 boundary） | 25 | 4995 | 78.1s | 63.9 tok/s |
| 9（50 字符 / 19 boundary） | 11 | 2388 | 37.4s | 63.8 tok/s |

线性拟合：`outputTokens ≈ 340 + 186 × n`（n = 送 LLM 的 token 数），速率约 **64 tok/s**。
据此可预估任意段在本机的耗时，进而设定合理的 `LLM_TIMEOUT_MS`。

> 注意：`llm-budget.ts` 的 `estimateCompletionTokens`（3,500/段 + 230/字符）是
> **按 DeepSeek thinking 模式标定的**，对本地无思考模型严重高估（段 7 估 24,200，实测 4,995，
> 高估约 4.8 倍）。该估算只影响装箱与预览费用，不影响正确性，但用它推算本地耗时会得出错误结论。
