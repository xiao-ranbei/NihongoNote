# 产品形态决策

**状态**：需求访谈版决策（已更新供应商策略）
**日期**：2026-08-27
**目标用户**：个人日语学习者（自用）

## 一、结论

选择**本地 Web 应用 + 云端 LLM 适配层**作为核心方案。

不建议把纯 Agent 或纯 skill 作为第一阶段产品，因为 P1 的核心价值不是“得到一段分析文字”，而是：

- 文章仍然以文章形态阅读；
- 句子、词语、助词、功能词、副词和多词语法可以在原文中定位；分句可以作为分析范围，但不单独使用色块；
- 句子色块作为最宽的底层，普通词/助词/功能词/副词使用较浅分类色块，语法色块覆盖对应范围；下划线/波浪线表达语言角色，背景允许按层叠加；
- 鼠标悬浮只高亮当前范围；点击后出现对应层级的解析卡片，桌面端为锚点卡片，移动端为底部抽屉或侧边面板；
- 课文、普通文章、新闻/说明文、笔记和对话可以在同一阅读器中处理，混合区块可单独调整；
- 文章和分析结果可以关联保存；
- 学习库可折叠、可搜索和筛选，不挤占连续阅读区；
- 长文章可以分段处理并恢复。

这些能力需要浏览器 DOM、持久化存储和可控的任务状态。Agent/skill 可以很好地提供分析能力，但不能自然地替代这层产品界面。

## 二、LLM 供应商和协议决策

### 决策

第一阶段选择 **DeepSeek 作为首个 LLM 候选**，先实现它的 **OpenAI-compatible API**。Anthropic-compatible API 保留为第二个适配器，不作为 P1 的阻塞条件。

这不是把产品永久绑定到 DeepSeek，而是选择一条最短的验证路径：

- DeepSeek 官方同时提供 OpenAI 和 Anthropic 兼容入口；
- OpenAI-compatible 方式有 JSON Output，适合本项目的结构化解析；
- 使用一个通用的 OpenAI-compatible adapter，可以复用到 OpenAI 和其他兼容服务；
- 后端内部仍使用 NihongoNote 自己的 `LlmProvider` 和 JSON schema，供应商协议不泄漏到前端；
- 等真实样本验证日语解析质量后，再决定是否需要第二种协议或更换模型。

### DeepSeek 官方入口

| 协议 | Base URL | 主要请求形式 | 本项目计划 |
| --- | --- | --- | --- |
| OpenAI-compatible | `https://api.deepseek.com` | `/chat/completions` | P1 首先实现 |
| Anthropic-compatible | `https://api.deepseek.com/anthropic` | `/messages` | 后续适配器 |

DeepSeek 官方文档：

- [OpenAI API 兼容说明](https://api-docs.deepseek.com/guides/openai_api)
- [Anthropic API 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api)
- [JSON Output 说明](https://api-docs.deepseek.com/guides/json_mode)
- [模型和价格](https://api-docs.deepseek.com/quick_start/pricing/)

“兼容”不表示所有字段完全等价。Anthropic 入口会忽略或不支持部分 Anthropic 专有字段，因此第一版只依赖基础文本消息、系统提示、模型、token 上限、温度、流式输出和工具/结构化结果所需的最小字段。

### 结构化输出约束

DeepSeek JSON Output 需要：

- 请求设置 `response_format: { "type": "json_object" }`；
- system 或 user prompt 中明确要求输出 JSON；
- 提供期望 JSON 结构示例；
- 设置足够的 `max_tokens`；
- 处理偶发的空内容和因长度截断导致的不完整 JSON。

JSON Output 只解决“格式是 JSON”的问题，不保证助词、语气或对话关系解释正确。因此仍必须执行本地 schema 校验、原文 ID 校验和不确定性标记。

### 当前实现状态

DeepSeek OpenAI-compatible adapter 和分析 API 已经落地：

- [LLM Provider 接口](../apps/api/src/providers/types.ts)提供业务层统一的 `analyze()`；
- [OpenAI-compatible adapter](../apps/api/src/providers/openai-compatible.ts)负责请求、JSON Output、响应解析和错误分类；
- [Provider Registry](../apps/api/src/providers/registry.ts)支持 `deepseek`、`openai` 和 `openai-compatible`；
- [API 配置](../apps/api/src/config.ts)支持 API key、base URL、协议、模型、温度、token 上限和超时；
- [分析服务](../apps/api/src/services/analysis-service.ts)负责句段任务、上下文、原文 ID/offset 校验、保存和重试；
- [分析路由](../apps/api/src/routes/analysis.ts)提供启动、进度和失败句段重试。

默认仍是 `LLM_PROVIDER=disabled`。启用 DeepSeek 时，需要在 `apps/api/.env` 设置 `LLM_PROVIDER=deepseek` 和 `LLM_API_KEY`；没有 key 时 API 会明确返回未配置错误。Anthropic-compatible adapter 仍是后续工作。

## 三、方案比较

| 方案 | 交互适配 | 首个可用版本 | 持续成本 | 完善程度上限 | 适合用途 |
| --- | --- | --- | --- | --- | --- |
| 纯 Agent | 低。结果主要是对话消息，难以稳定实现原文内悬浮、历史和文章交互 | 1-3 天 | 模型调用或订阅费用 | 中 | 快速验证分析提示词、临时问答 |
| 纯 skill | 低到中，取决于宿主平台是否提供 UI 和文件能力 | 0.5-2 天 | 宿主平台或模型费用 | 中 | 复用分析规则、统一输出格式、批处理 |
| 本地 Web 应用 | 高。可完整控制阅读器、分析结果和历史 | 1-2 周可用 MVP；3-6 周打磨 | 本地基础设施接近零；按量支付 LLM 费用 | 高 | 当前自用目标，推荐 |
| 公网 Web 应用 | 高，但需要账号、部署、数据库、监控、隐私和并发治理 | 4-8 周起步 | 云主机、数据库、流量、LLM 和运维 | 最高 | 将来分享给朋友或公开发布 |

周期是假设由一名熟悉 TypeScript 的开发者、借助 AI 辅助完成的估算，不包含反复试验模型提示词的时间。

## 四、为什么不是先做 Agent/skill

### Agent 的优势

- 最快验证“AI 是否能解释日语语法、语气和对话上下文”。
- 不需要先搭建前端、数据库和历史存储。
- 可以先用几篇真实材料评估输出质量。

### Agent 的限制

- 不适合在原文上稳定做逐句、逐词定位。
- 不容易管理长文章的分块、重试和进度。
- 历史搜索和文章级复习体验需要额外系统。
- 受宿主平台的模型、上下文和 UI 能力约束，迁移成本较高。

### skill 的定位

skill 应作为**可复用的分析协议**，而不是主产品：

- 定义词汇、助词、语法、语气和接话理由的输出结构；
- 约束模型返回可校验的 JSON；
- 将来可以被 Agent、Web 后端或批处理脚本复用；
- 可提供“把当前句子发给 Agent 深入解释”的快捷入口。

这样既保留 skill 的复用价值，也不牺牲 Web 阅读器的核心体验。

## 五、成本策略

### 固定成本

- 本地 Web 应用：不需要服务器、域名或公网数据库。
- 开发阶段：可以先不做账号、支付、监控和多租户。

### 按量成本

主要变量是：

1. LLM 输入和输出 token 数；
2. 长文章分段后的调用次数；
3. 是否为同一段内容重复生成分析。

建议在服务端保留 provider adapter，不把模型名称和价格写死在前端。默认策略：

- 分析结果按文章版本缓存；
- 同一段文字、同一模型和同一提示词版本不重复生成；
- 长文先显示预计段数和调用状态；
- 失败时只重试失败的段，不重跑整篇；

### 供应商选择

第一版不做永久性的单一供应商绑定，但采用“DeepSeek 先验证、adapter 保持可替换”的策略。实现时应对 LLM 做真实样本 A/B 测试：

- LLM：先用 DeepSeek OpenAI-compatible API 验证结构化 JSON、长上下文和日语能力；必要时再对比其他 provider。

实施前重新核对官方页面：

- [OpenAI API pricing](https://platform.openai.com/docs/pricing)
- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [Google Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Anthropic API pricing](https://www.anthropic.com/pricing#api)

价格页面会变化，因此本文不把某个时点的单价当作长期承诺。

## 六、完善程度路线

### 第一阶段：可长期自用

- 粘贴课文、普通文章、新闻/说明文、笔记或对话，并自动识别、手动调整内容区块；
- 一个连续阅读框中的句子底色、词语类别色块和语法色块，以及词语/助词/副词/语法/语气的线型标注；
- 悬浮只高亮当前范围、不显示弹窗；桌面端点击打开靠近文字的锚点卡片，移动端打开底部抽屉或侧边面板，并按句子结构 → 词语 → 语法 → 语气四层循环；没有对应解析时跳过该层；
- 句子翻译、结构、态度、礼貌程度、潜台词和有依据的对话相邻关系；
- 用户手动启动的长文分析、取消后续跑和失败重试；
- 区块、分句、标注范围和解析字段的人工修正，并保留 AI 原始版本；
- 可折叠、可搜索和可筛选的学习库；

### 后续阶段

- 标准日语 TTS 朗读和播放，支持合理停顿、语速调整和清晰发音；不包含录音或跟读。
- 浏览器扩展；
- Agent/skill 快捷调用；
- 多设备同步或公网部署。

## 七、主要风险和缓解方式

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 模型把助词或语气解释错 | 学习者形成错误理解 | 使用结构化输出、保留原文证据、标记不确定性，并允许用户反馈 |
| 长文超出上下文或调用过多 | 成本和等待时间上升 | 句子分段、上下文窗口、缓存、断点续跑 |
| 兼容 API 的字段行为不完全一致 | 换供应商或协议时出现隐性错误 | 只使用适配器声明的最小字段；对供应商响应做显式转换和 schema 校验 |
| JSON 输出为空或被截断 | 分析任务失败或保存半截结果 | 检查 finish reason 和空内容；失败段落可重试，不能写入完成状态 |
| 自动分词不准确 | 词语悬浮范围错误 | 采用日语形态素分析器，允许按句子退化显示 |
| API 密钥泄漏 | 费用和账号风险 | 密钥只读本机服务端环境变量，前端永不接触 |

## 八、不可妥协的取舍

1. 优先保证解释正确、可追溯和可复习，而不是一次生成无法验证的花哨效果。
2. 保持前端与 LLM 解耦，未来更换供应商不需要重做阅读器。
3. 第一版只服务单个本机用户，不提前引入账号、权限和公网运维。
