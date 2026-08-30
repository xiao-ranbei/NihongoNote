# Ollama 本地模型真实链路验证报告（2026-08-30）

> 对应请求：「使用本地 llm 进行测试」。提交 `3e5d8d8`，与设计文档 §3.9（决策 6 实测修订）配套。

## 一、结论

- **真实链路端到端跑通**：qwen3.5:9b 冒烟 **9/9 段全绿**，无截断、无服务崩溃。
- **成本对比**（同 9 段、standard 档）：

| 指标 | Ollama 本地（qwen3.5:9b） | DeepSeek 云（deepseek-v4-flash） |
| --- | --- | --- |
| 总 token | **96** | ~59,598（6,622/段） |
| 单段耗时 | ~45s | ~1s |
| 费用 | **¥0（本地算力）** | 按量计费 |

## 二、关键实测发现（决定协议选型）

1. **OpenAI 兼容层（/v1/chat/completions）不可用于本场景**：
   - 强制 `num_ctx=4096`（顶层/`options.num_ctx` 均被忽略，`usage.total_tokens` 卡 4096）→ prompt 占 ~2K 后输出必然截断；
   - 无法关闭 qwen3.5 系 thinking（`think:false`/`thinking:false`/`options.think` 均无效，仅 `reasoning_effort:"none"` 有效）→ 思考吃光 max_tokens、content 为空。
2. **原生 `/api/chat` 两个问题均不存在**：`options.num_ctx` 实测扩到 16K+、`think:false` 实测有效。

## 三、内存预算（防 OOM，实测校准）

- KV cache ≈ 590KB/token（qwen3.5 9B 量级）；`num_ctx=40K` → KV ~23GB > 16GB VRAM → **服务崩溃（实测）**。
- 最终：`completionTokenBudget = min(LLM_MAX_TOKENS, 8192)`、`num_ctx = 预算 + 4096`（≈12288）→ KV ~7GB + 权重 ~6.6GB ≈ 13.6GB，安全。
- 单批实际输出 ~3~6K tokens，8K 预算留有余量；`planBatches` 按预算装箱，超预算长句段自动单独成批（不截断）。

## 四、环境层问题与修复（模型「消失」）

- 症状：`/api/tags` 返回 `[]`，`ollama list` 报错，磁盘模型（D:\Ollama\Models）完整无损。
- 根因：Ollama 0.33.2 新版 app.exe 的 UI 设置存于 `C:\Users\xiao_\AppData\Local\Ollama\db.sqlite` 的 `settings` 表；`models` 字段被写死为空的默认路径 `C:\Users\xiao_\.ollama\models`，app.exe 启动 server 时用 UI 配置**覆盖**环境变量。
- 修复：
  1. `setx OLLAMA_MODELS "D:\Ollama\Models"`（持久化用户级环境变量，CLI serve 生效）；
  2. 备份 db.sqlite 后更新 `settings.models = 'D:/Ollama/Models'`（app.exe 生效）。
- 验证：app.exe 重启后日志 `OLLAMA_MODELS:D:/Ollama/Models`、`total blobs: 4`、`models=1`。

## 五、产出

- `apps/api/src/providers/ollama.ts`：OllamaProvider（原生 /api/chat 流式 NDJSON 解析、think:false、内存预算、截断报错）。
- `analysis-service.ts`：进程级自动重试一次（provider 整批异常兜底，间隔 1s，最多 2 次尝试）。
- prompt 加固：字符串值内容内禁用 ASCII 引号（防本地模型损坏 JSON）。
- verify-pipeline 新增 4 条 OllamaProvider 离线断言 → **75/75**。
- `.env.example` / docs §3.9、§6-7、决策 6 同步更新。
- 临时冒烟脚本与测试数据已清理。
