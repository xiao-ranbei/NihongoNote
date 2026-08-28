# LLM 提示词与请求协议

**状态**：当前实现说明
**提示词版本**：`analysis-v1`
**首个 provider**：DeepSeek OpenAI-compatible API
**当前模型默认值**：`deepseek-v4-flash`

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
stream: false
```

当 `thinking.type=enabled` 时，不发送 `temperature`；关闭 thinking 时才发送配置中的温度。这与 DeepSeek 当前推理模型示例的请求形式保持一致。

## 三、system prompt 的约束

当前 `systemPrompt` 要求模型：

1. 只返回 JSON，顶层只有 `analyses`；
2. 对每个输入 segment 返回一个同 `segmentId` 的分析；
3. 返回自然中文译文、语法结构、语气、礼貌程度、潜台词、对话接话理由和不确定性；
4. 对每个本地提供的 token 返回一项分析；
5. 原样保留 `tokenId`、`startOffset`、`endOffset` 和 `surface`；
6. `category` 只能是 `word`、`particle`、`adverb` 或 `grammar`；
7. 把偏移理解为相对于句段文本的 JavaScript UTF-16 偏移；
8. 不补造上下文，无法判断时使用 `null` 或 `uncertaintyNote`；
9. 遵守 JSON Output，并参考 prompt 中的 JSON 结构示例。

`contentType` 被当作用户选择的权威类型；`targetLevel` 只影响解释措辞，不能改变 token 边界、词汇事实或语法事实。

## 四、响应校验和保存

provider 先检查 SDK 返回的 completion：

- completion choice 是否存在；
- `finish_reason` 是否为 `length`；
- `message.content` 是否为空；
- content 是否为合法 JSON；
- JSON 是否符合 `segmentAnalysisSchema`。

随后 [AnalysisService](../apps/api/src/services/analysis-service.ts) 继续检查：

- 返回的 `segmentId` 是否等于本地 segment；
- token 数量是否与本地边界一致；
- token ID 是否全部来自本次请求；
- token 的 offset 和 surface 是否与本地 `Intl.Segmenter` 结果完全一致。

只有通过这些检查的结果才会保存为 completed。人工修改保存在 revision 中，不覆盖 `originalAnalysis`。

## 五、当前性能边界

当前分析服务按句段串行调用 provider，每个句段单独请求一次。这样可以独立保存成功结果和重试失败句段，但长对话总耗时约为各句段请求耗时之和。

`thinking=enabled` 和较高的 `reasoning_effort` 会增加推理时间；当前配置允许通过 `.env` 调整模型、推理等级、`max_tokens` 和 timeout。OpenAI SDK 自动重试已关闭，避免隐藏的重复请求和额外费用。

## 六、开发者调试日志

临时启用：

```env
LLM_DEBUG_LOGGING=true
LLM_DEBUG_LOG_FILE=./data/llm-debug.jsonl
```

日志每次追加 JSONL 事件，包含：

- endpoint、provider、protocol、model；
- 完整 `body`，包括 `messages`、`tokenBoundaries`、`response_format`、`thinking` 和 `reasoning_effort`；
- request ID、耗时、finish reason、响应内容、usage；
- 失败时的错误名称、错误消息和 HTTP 状态。

Authorization header 和 API key 永远不会写入。因为 body 和 messages 包含原文，排查完成后应关闭日志并删除 `data/llm-debug.jsonl`。

## 七、后续演进边界

当前 `SegmentAnalysis` 是兼容现有 MVP 的过渡载体。后续拆分为 `CanonicalAnalysis` 与 `LevelExplanation` 时：

- system prompt 和请求协议应继续通过 provider adapter 隔离；
- canonical token、范围、语法事实和 evidence 不得因目标等级复制；
- `LevelExplanation` 只改变面向学习者的表达深度；
- 前端继续使用稳定 segment/token ID，不改用模型返回的 Markdown 位置。
