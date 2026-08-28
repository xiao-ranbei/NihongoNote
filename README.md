# NihongoNote

NihongoNote 是一个面向个人使用的日语文章解析和听读工具。目前仓库已完成 P1 MVP 的本地交互闭环，后续继续完善完整范围标注、等级解释层和长期使用能力。

## 当前架构

```text
浏览器（React + Vite）
        │ /api 代理
本机 API（Fastify + TypeScript）
        ├── SQLite 文档库
        ├── 日语分句/分词适配层
        ├── LLM 结构化分析适配层
        └── TTS 音频适配层
```

目录结构：

```text
apps/
  api/       本机 API、SQLite、任务和 provider 边界
  web/       阅读器 UI
packages/
  core/      前后端共用的领域类型和 Zod schema
docs/        产品、需求、架构、路线和评估样本
```

## 开发环境

- Node.js 22+
- pnpm 10+

首次安装依赖：

```powershell
pnpm install
```

复制并编辑 API 配置（配置文件位于 API workspace）：

```powershell
Copy-Item apps\api\.env.example apps\api\.env
```

启动前端和本机 API：

```powershell
pnpm dev
```

- Web：<http://127.0.0.1:5173>
- API 健康检查：<http://127.0.0.1:8787/api/health>

当前 provider 默认为 `disabled`。DeepSeek OpenAI-compatible adapter、可取消分析 API 和 P1 MVP 阅读器已经实现，但需要在本机配置 API key 才会发起云端请求；Anthropic-compatible adapter 和 TTS 尚未实现。目标等级选择会保留为教学表达设置：基础事实分析只生成一份，等级只影响后续解释层。

启用 DeepSeek 文本分析：

```powershell
Copy-Item apps\api\.env.example apps\api\.env
# 编辑 apps\api\.env，设置 LLM_PROVIDER=deepseek 和 LLM_API_KEY
```

关键配置：

```env
LLM_PROVIDER=deepseek
LLM_PROTOCOL=openai
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
LLM_THINKING_TYPE=enabled
LLM_REASONING_EFFORT=high
LLM_DEBUG_LOGGING=false
LLM_DEBUG_LOG_FILE=./data/llm-debug.jsonl
LLM_API_KEY=your-api-key
```

保存文章后，点击“开始 AI 分析”。分析任务会按句段执行，结果通过 JSON schema 校验后保存；失败句段可以单独重试，取消时会中止当前云端请求并停止后续句段。
推理型模型可能需要更长等待时间；模板默认 `LLM_TIMEOUT_MS=300000`。`thinking` 和 `reasoning_effort` 只影响模型推理过程，不改变本地 token 边界或结果校验。
长句的结构化解析可能同时包含推理和 JSON 内容，模板将 `LLM_MAX_TOKENS` 设为 `32000`；如果供应商或账户限制更低，请按实际限制调小。

开发者排查请求时，可以在本机 `.env` 临时启用：

```env
LLM_DEBUG_LOGGING=true
LLM_DEBUG_LOG_FILE=./data/llm-debug.jsonl
```

每次调用会追加一行 JSON，包含实际发送的 endpoint、model、messages、thinking、reasoning_effort、response_format、token 边界、耗时和响应内容；Authorization header 和 API key 永远不会写入。由于 messages 会包含原文，调试完成后请关闭该选项或删除日志文件。

## 常用命令

```powershell
pnpm typecheck
pnpm build
```

## 设计约束

- API 默认只监听 `127.0.0.1`，第一版不暴露公网。
- API 密钥只放在本机服务端环境变量，前端不接触密钥。
- 原文由本地服务分句并生成稳定的 segment/token 位置，模型只负责结构化语义解释。
- LLM 和 TTS 通过 adapter 接入，避免阅读器绑定某一家供应商。
- 本地数据库和音频目录不进入 Git。

详细设计见[技术架构方案](docs/architecture.md)和[迭代路线图](docs/roadmap.md)。
