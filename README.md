# NihongoNote

NihongoNote 是一个面向个人使用的日语文章解析和听读工具。目前仓库处于基础架构阶段，目标是先建立可启动、可验证、可替换供应商的本地 Web 应用。

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

当前 provider 默认为 `disabled`。DeepSeek OpenAI-compatible adapter 和分析 API 已经实现，但需要在本机配置 API key 才会发起云端请求；Anthropic-compatible adapter 和 TTS 尚未实现。

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
LLM_MODEL=deepseek-v4-pro
LLM_API_KEY=your-api-key
```

保存文章后，点击“开始 AI 分析”。分析任务会按句段执行，结果通过 JSON schema 校验后保存；失败句段可以单独重试。
包含完整 token 解释的长句可能需要较高的 `LLM_MAX_TOKENS`；模板默认使用 `12000`，可根据实际响应长度调整。

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
