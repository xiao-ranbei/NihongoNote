# LLM 提示词与请求协议

**状态**：当前实现说明
**提示词版本**：`analysis-v5`
**首个 provider**：DeepSeek OpenAI-compatible API
**当前模型默认值**：`deepseek-v4-flash`
**当前推理默认值**：`thinking=enabled`、`reasoning_effort=minimal`（2026-08-29 深夜由 medium 降档，用户拍板）
**当前输出上限**：`LLM_MAX_TOKENS=24000`，实际按批次估算自适应，最高 32000（见第五节）
**当前批量默认值**：`LLM_BATCH_SIZE=3`（现为"最多几段"的上限，实际按成本装箱）、`LLM_BATCH_CONCURRENCY=2`

## 一、提示词在哪里

当前没有独立的 `.prompt` 文件。提示词的单一事实来源是：

- [OpenAI-compatible provider](../apps/api/src/providers/openai-compatible.ts) 中的 `systemPrompt`；
- 同文件的 `requestPayload()` 负责把系统提示词和本次句段输入组装成 `messages`。

修改提示词时，应同时更新 `LLM_PROMPT_VERSION`，这样保存的分析结果可以追溯到对应版本。

## 二、请求如何组装

`OpenAiCompatibleLlmProvider.analyze()` 使用官方 OpenAI SDK：

```text
new OpenAI({
  apiKey,
  baseURL,
  timeout,
  maxRetries: 0
})

client.chat.completions.create(requestBody, { signal })
```

分析服务会把多个待分析 segment 合并为受控 batch；短对话默认可以在一个请求中完成，长文则**按估算成本装箱**
（见 [llm-budget.ts](../apps/api/src/llm-budget.ts)），并以 `LLM_BATCH_CONCURRENCY` 控制同时运行的 batch 数量，
避免为每个句子重复支付固定 prompt 和推理开销。`LLM_BATCH_SIZE` 退化为"一个批次最多几段"的上限。

发送到 DeepSeek 的请求包含：

```text
model
messages:
  system: systemPrompt
  user: JSON.stringify({
    contentType,
    targetLevel,
    surroundingContext,
    segments,
    tokenBoundaries
  })
max_tokens
response_format: { type: "json_object" }
thinking: { type: "enabled" | "disabled" }
reasoning_effort
stream: true
stream_options: { include_usage: true }
```

当 `thinking.type=enabled` 时，不发送 `temperature`；关闭 thinking 时才发送配置中的温度。这与 DeepSeek 当前推理模型示例的请求形式保持一致。SDK
返回的 stream 会逐块拼接 `delta.content`，直到收到完整 JSON 和 finish reason；usage 通过
`stream_options.include_usage` 读取。

## 三、system prompt 的约束

当前 `systemPrompt` 要求模型：

1. 只返回 JSON，顶层只有 `analyses`；
2. 对每个输入 segment 返回一个同 `segmentId` 的分析；
3. 返回自然中文译文、语法结构、语气、礼貌程度、潜台词、对话接话理由和不确定性；
4. 对每个本地提供的 token 返回一项分析；
5. 原样保留 `tokenId`、`startOffset`、`endOffset` 和 `surface`；
6. `category` 只能是 `word`、`particle`、`functional`、`adverb` 或 `grammar`；
7. **每个 token 的全部 14 个字段都必须输出、不得省略**——`confidence` 对每个 token 都是必填的 0–1 数字，不得缺失、不得是字符串或单词（v4 起，实测 reasoning 模式下模型会整段省略它认为"不重要"的字段）；
8. **每个 analysis 的全部 9 个顶层字段都必须输出、不得省略**——`translation` / `grammarSummary` / `tone` / `politeness` 等即使觉得平淡也要给出（v5 起，实测 politeness 被整段省略导致 29 个正确字段一起作废）；
9. 把偏移理解为相对于句段文本的 JavaScript UTF-16 偏移；
10. 不补造上下文，无法判断时使用 `null` 或 `uncertaintyNote`；
11. 遵守 JSON Output，并参考 prompt 中的 JSON 结构示例。

`contentType` 被当作用户选择的权威类型；`targetLevel` 只影响解释措辞，不能改变 token 边界、词汇事实或语法事实。

## 四、响应校验和保存

provider 先检查 SDK 返回的 completion：

- completion choice 是否存在；
- `finish_reason` 是否为 `length`；
- `message.content` 是否为空；
- content 是否为合法 JSON（若含模型输出的裸控制字符，会先转义字符串字面量内部的控制字符再解析一次，
  并把这个事件记为 `llm.json.invalid`；实测一次坏响应会让整批 3 个 segment 一起失败）；
- JSON 是否符合 `segmentAnalysisSchema`（v4 起 `tokenAnalysisSchema.confidence` 带 `default(null)`：
  模型整段省略 confidence 时降级为"无置信度"，不再报 `Required` 拖垮整段；显式 `null` / 数字字符串还原 /
  越界拒绝等原行为不变，均有离线断言覆盖）；
- v5 起 `segmentAnalysisSchema` 的 7 个内容字段（translation / grammarSummary / tone / politeness /
  impliedMeaning / replyReason / uncertaintyNote）统一带 `default(null)`：单字段缺失降级为"未提供"
  （UI 显示「未提供」），不再让整段作废；`segmentId` 与 `tokens` 保持 Required（定位依据与分析核心不可降级）。

随后 [AnalysisService](../apps/api/src/services/analysis-service.ts) 继续检查：

- 返回的 `segmentId` 是否等于本地 segment；
- token 数量是否与本地边界一致；
- token ID 是否全部来自本次请求；
- token 的 offset 和 surface 是否与本地 `Intl.Segmenter` 结果完全一致。

只有通过这些检查的结果才会保存为 completed。人工修改保存在 revision 中，不覆盖 `originalAnalysis`。

## 五、当前性能边界

当前分析服务按受控 batch 调用 provider；一个 batch 包含多个 segment，并在完整流结束后分别校验和保存每个结果。
batch 内仍保持稳定 ID 和独立失败状态，后续重试只重新提交失败 segment 所在的 batch。

**装箱策略（2026-08-29 改）**：早期版本按固定段数切批，结果三个长句段凑一批会打满输出上限（样本 2 因此丢掉 3 个句段）。现改为按估算成本装箱：

```text
估算 completion ≈ 3500 × 段数 + 230 × 原文字符
装箱预算 = 32000 × 0.77 = 24640
```

系数来自两篇样本 19 次真实请求的回归：实测 completion 是原文字符数的 200 ~ 500 倍（均值 294），
取 19 个样本点的上界，宁可高估——高估只让批次变小，低估会让整批截断。
单个句段即使超预算也单独成批，保证不重不漏。代价是批次数从 19 增至 27，但批次更小、总墙钟时间持平。

**输出上限自适应**：`max_tokens = min(max(LLM_MAX_TOKENS, 估算 × 1.3), 32000)`。
多给不会多花钱（`max_tokens` 只是上限，计费按实际生成量），截断才会白跑一次。

当前默认使用 `thinking=enabled`、`reasoning_effort=minimal`；配置允许通过 `.env`
调整模型、推理等级、batch 大小、输出上限和 timeout。OpenAI SDK 自动重试已关闭，避免隐藏的重复请求和额外费用。
流式响应主要改善首字节和进度体验；总计算量仍由模型推理 token 和 batch 内容决定。

**已知代价**：开启思考后推理 token 占输出高达 **72.8%**（medium 档实测 prompt 52831 + completion 385570）。
`reasoning_effort` 是成本、速度和截断率共同的杠杆；2026-08-29 深夜用户直接拍板降为 `minimal`，
降档后是否影响解析质量需以两篇样本回归为准（回归安排在降档切换之后）。

## 六、余额与费用统计（2026-08-29 深夜新增）

**余额查询**：由本机服务端代理 DeepSeek `GET {baseUrl}/user/balance`（`Authorization: Bearer <KEY>`），
对外暴露 `GET /api/llm/balance`。响应只含脱敏 key（`sk-49af…be98`）、模型名、base URL 和
`entries`（`total_balance` / `granted_balance` / `topped_up_balance`，字符串，后两者可为 null）。
完整 key 不出服务端；未配置 provider 返回 503，查询失败（网络/鉴权/非 2xx）返回 502，前端均显示「余额未知」而非崩溃。

**费用统计**：`OpenAiCompatibleLlmProvider.analyze()` 从 usage 中提取 DeepSeek 特有的
`prompt_cache_hit_tokens`（缓存命中），随输入/输出/总 token 一并写入 `segment_analyses.usage_json`。
费用计算在 [llm-pricing.ts](../apps/api/src/llm-pricing.ts)：

```text
deepseek-v4-flash 单价（元/百万 tokens，已核对官方定价页）：
  输入（缓存命中）  闲 0.05 / 峰 0.10
  输入（未命中）    闲 1.5  / 峰 3.0
  输出             闲 4.5  / 峰 9.0
高峰 = 北京时区（UTC+8）周一至周五 9:00–12:00、14:00–18:00，其余为闲时
费用 = 命中/未命中/输出 token 分别 × 单价后求和
```

- 统计口径：按文章聚合 `usage_json`（同批次的 usage 完全一致，聚合时去重，避免一个 batch 的用量被其 N 个句段重复计算）；
- 计费时刻取估算发起时刻的高峰/闲时档；跨高峰边界的批次会有微小误差，属于可接受的近似；
- 模型不在内置价格表内（或尚无用量数据）时 `cost=null`，前端显示「价格未知」，不编数；
- 费用随分析进度接口返回：`analysisProgressSchema` 扩展 `usage`（input/output/total/cachedInputTokens）与
  `cost`（model/currency/tier/token 明细/inputCost/outputCost/totalCost）两个字段，前端在进度区直接展示。

## 七、开发者调试日志

临时启用：

```env
LLM_DEBUG_LOGGING=true
LLM_DEBUG_LOG_FILE=./data/llm-debug.jsonl
```

日志每次追加 JSONL 事件，包含：

- endpoint、provider、protocol、model；
- 完整 `body`，包括 `messages`、batch segment IDs、`tokenBoundaries`、`response_format`、`thinking`、
  `reasoning_effort`、`stream` 和 `stream_options`；
- request ID、耗时、finish reason、响应内容、usage；
- 流式过程中的 chunk 数量和累计 content 长度；
- 失败时的错误名称、错误消息和 HTTP 状态。

Authorization header 和 API key 永远不会写入。因为 body 和 messages 包含原文，排查完成后应关闭日志并删除 `data/llm-debug.jsonl`。

## 八、后续演进边界

当前 `SegmentAnalysis` 是兼容现有 MVP 的过渡载体。后续拆分为 `CanonicalAnalysis` 与 `LevelExplanation` 时：

- system prompt 和请求协议应继续通过 provider adapter 隔离；
- canonical token、范围、语法事实和 evidence 不得因目标等级复制；
- `LevelExplanation` 只改变面向学习者的表达深度；
- 前端继续使用稳定 segment/token ID，不改用模型返回的 Markdown 位置。
