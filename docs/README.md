# NihongoNote 产品文档

本目录记录 NihongoNote 的产品决策、需求、技术方案和迭代路线；连续阅读、分层标注、多材料区块和学习库交互的规格已在 2026-08-27 需求澄清中补充，P1 MVP 和等级解释层架构于 2026-08-28 确认。

## 文档索引

- [产品形态决策](product-decision.md)：为什么以本地 Web 应用为核心，以及 Agent/skill 的适用边界。
- [产品需求说明](requirements.md)：已确认的用户场景、功能需求、数据结构和验收标准。
- [技术架构方案](architecture.md)：前后端、AI 分析、TTS 接口预留、存储和隐私设计。
- [LLM 提示词与请求协议](llm-prompt.md)：当前 `systemPrompt` 的源码位置、OpenAI SDK 请求字段、响应校验和调试日志。
- [迭代路线图](roadmap.md)：分阶段交付范围、周期、进度快照、审阅记录和后续扩展。
- [2026-08-29 完整语料回归报告](regression-2026-08-29.md)：两篇样本 55 个句段的真实 LLM 端到端原始数据。
- [日语解析评估样本集](evaluation-corpus.md)：当前两篇真实商务对话、解析重点和回归检查项。
- [优化评审清单](optimization-review.md)：2026-08-28 深度评审——P0 缺陷、分词粒度、提示词矛盾、UI 偏差与修复顺序。
- [主题系统与设计 Token](theme-system.md)：六套主题、Token 分组、结构层维护规范与 `data-layout` 扩展方案。
- [UI 设计提案](ui-design-proposals.html)：六案设计画廊（已全部保留为可切换主题）。
- [项目理解报告](../overview.md)：2026-08-28 全量代码审阅的架构、数据模型与完成度评估。
- [项目根目录 README](../README.md)：本地开发环境、目录结构和启动命令。

## 当前结论

第一阶段采用**只在本机运行的 Web 应用**：

1. 在浏览器中粘贴日语课文、普通文章、新闻/说明文、笔记或对话。
2. P1 先交付 token + 句子两层 MVP：原文在一个连续阅读框中展示，句子和 token 可定位、点击查看 AI 解析；完整的语法范围、语气范围和四层循环交互保留为后续扩展。
3. 保存后先在本机完成区块、句段和 token 预处理；深度 AI 分析由用户手动启动，后端按区块和稳定句段分块分析和保存。取消必须中止当前云端请求并停止后续任务，已完成结果保留，失败句段可重试。
4. 支持同一篇文章中的混合区块；内容类型以用户手动选择为主，自动识别只提供建议；标题/注释默认保留原样，正文/日语例句默认解析。
5. 使用云端 LLM，API 密钥只保存在本机服务端。
6. P1 首先接入 DeepSeek 的 OpenAI-compatible API；Anthropic-compatible API 作为后续可插拔适配器。
7. 学习库可折叠：桌面端为窄侧栏/图标轨道，手机端为抽屉；首版先支持搜索和分析状态筛选，内容类型筛选后续加入。
8. Agent/skill 暂不作为主产品形态，后续可作为分析编排、批量处理或浏览器扩展的入口。
9. 保留目标等级选择，但等级只影响教学表达层；token、范围、语法事实和基础句意等统一基础分析只保留一份。

TTS provider 仅预留接口和后续标准朗读/播放方向，当前版本不生成音频，也不包含录音或跟读。

本目录既有产品决策来自 2026-08-26 的需求确认；连续阅读、分层标注、多材料区块和学习库交互于 2026-08-27 进一步澄清；P1 范围、取消语义、人工修正优先级和等级解释层于 2026-08-28 确认；2026-08-29 完成 UI 六提案评审（全部保留为主题）、样式 Token 化与主题系统落地，并产出深度优化评审。供应商价格和模型能力会变化，实施前应重新核对官方文档和定价。

当前代码状态：P1 MVP 已具备句子/token 两层阅读交互、可中止云端分析、内容类型手动选择与建议、首版标题/角色/解析字段修正，以及学习库搜索和分析状态筛选。DeepSeek provider 使用官方 OpenAI SDK，默认模型为 `deepseek-v4-flash`，推理参数（`thinking=enabled`、`reasoning_effort=minimal`）和 JSONL 调试日志可配置；2026-08-29 深夜新增余额查询（`GET /api/llm/balance`，服务端代理、只回传脱敏 key）与单次分析费用统计（随 progress 的 `usage`/`cost` 字段返回，内置 deepseek-v4-flash 高峰/闲时单价表）。样式层已完成 Token 化并落地六套可切换主题（`data-theme`），线型语言（实线/双线/虚线/波浪）与五类标注类别已按需求贯通，切换 UI 与主题微调待接入。完整范围标注仍属后续扩展。

本机环境已跑通：`pnpm install`、`pnpm typecheck`（core / api / web 全绿）、`pnpm dev`（API `:8787`、Web `:5173`）均已验证。P0 缺陷（说话人正则、数据库落盘策略）与分词/提示词问题已修复并回归，详见[优化评审](optimization-review.md)与[路线图第九节](roadmap.md#九进度审阅记录)。

自检与回归命令：

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | 三个包的类型检查（含 `apps/api/scripts`） |
| `pnpm --filter @nihongonote/api verify` | 20 条断言的分段/分词/落盘自检，不需要网络与 LLM |
| `cd apps/api && NIHONGO_DATA_DIR=./data/regression LLM_DEBUG_LOGGING=true ./node_modules/.bin/tsx scripts/regression-corpus.ts` | 用 `evaluation-corpus.md` 两篇完整样本跑真实 LLM 端到端回归，独立数据目录，输出 Markdown 报告 |
