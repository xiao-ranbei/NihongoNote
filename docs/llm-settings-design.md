# LLM 设置页设计（设置入口：本地 / 云端切换）

**状态**：已确认（2026-08-30）。用户拍板三项：① 保存即热切换（无需重启）；② API key 明文存本机库；③ 顶栏第三个视图「设置」。

## 一、背景与目标

当前 LLM 配置全部在 `apps/api/.env`（启动时由 `config.ts` 解析为 `appConfig` 常量），切换本地 Ollama / 云端 DeepSeek 需要手动改文件并重启服务。目标：在 Web UI 内完成配置与切换。

**非目标**：不改 TTS 配置；不暴露 batchSize/batchConcurrency/timeoutMs（保留 .env 控制，MVP 收敛表单面）；不做多 profile 预设管理。

## 二、数据模型与存储

### 2.1 app_settings 表（schema.ts 新增）

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL        -- JSON 字符串
);
```

通用 key-value 表，先存一个 `llm` 键（未来 TTS 等可复用）。

### 2.2 LlmSettings 结构

```ts
interface LlmSettings {
  provider: "disabled" | "ollama" | "deepseek" | "openai" | "openai-compatible";
  baseUrl: string;
  apiKey: string | null;        // 存储为明文；响应回传 masked（sk-49a…be98，前 6 后 4）
  model: string;
  temperature: number;          // 0–2
  maxTokens: number;            // 1–32000
  segmentFields: "minimal" | "standard" | "full";
  thinkingType?: "enabled" | "disabled";        // 云端（deepseek 等）使用
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
}
```

### 2.3 配置优先级

`生效配置 = env 默认值 ∪ db 覆盖`——数据库有值的字段覆盖 .env，未设置过的字段回退 .env 默认（含 `LLM_THINKING_TYPE` 的 deepseek 特殊默认）。`.env` 仍是初始默认与「恢复出厂」语义：清空 db 设置即回到 .env。

## 三、API

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/llm/settings` | GET | 返回 `{ settings, source, provider }`：`settings` 为生效配置（apiKey 回传 masked，如 `sk-49a…be98`）；`source` 逐字段标记 `db`/`env`；`provider` 为当前实例信息（name/configured/model/isLocal）供 UI 展示 |
| `/api/llm/settings` | PUT | body 为 `LlmSettings`（apiKey 可选）。**key 回传保留规则**：body.apiKey 为空或等于当前 masked 值时视为「未修改」，保留库中原值。保存 → 校验（复用 config.ts 校验口径）→ 写库 → **重建 provider** → 立即生效 |

**校验口径**：baseUrl 必须 URL；temperature 0–2；maxTokens 1–32000；batchSize/batchConcurrency 不在此接口；thinkingType/reasoningEffort 仅枚举内。

## 四、provider 热重建（核心改造）

现状：`createProviderRegistry(config)` 启动时一次性建 provider，`AnalysisService` 持有 `private readonly provider`。

改造：

1. **可变容器**：registry 返回 `llm: { current: LlmProvider }`（holder）。`createProviderRegistry` 增加 `rebuildLlm(settings)` 内部方法，或由 settings 服务持有构建函数。
2. **AnalysisService 解耦**：构造参数从 `provider: LlmProvider` 改为 `providerHolder`（`{ get current(): LlmProvider }`），所有 `this.provider.*` 调用点改为 `this.providerHolder.current.*`（每批取一次，进行中的批次切换后自然用新 provider）。
3. **segmentFields 联动**：`AnalysisService` 的 `segmentFields` 改为可变字段；settings 保存后同步更新（档位切换立即作用于后续分析）。
4. **并发安全**：进行中的批次在下一个 batch 循环读到新 provider——语义为「切完即用新配置」，可接受；provider 重建不打断进行中的请求（旧引用仍在栈上）。

## 五、前端

### 5.1 视图与入口

`App.tsx` 的 `view` 增加 `"settings"`；顶栏新增「设置」按钮（与「分析工具」并列，三态切换）。

### 5.2 SettingsPanel 组件（新文件 `apps/web/src/settings.tsx`）

- **Provider 类型**：分组选择——「本地模型（Ollama）」= `ollama`；「云端 API（OpenAI 兼容，DeepSeek 等）」= `deepseek`（模型/URL 可填任意兼容端点，保留 `openai`/`openai-compatible` 选项）；「禁用」= `disabled`。
- **字段**：baseUrl（URL）、apiKey（password 输入，placeholder 显示 masked，留空=不修改）、model、temperature、maxTokens、segmentFields（minimal/standard/full，带费用提示）、thinkingType/reasoningEffort（仅云端显示，reasoningEffort 标注成本影响）。
- **保存**：`PUT` 成功后提示「已生效，无需重启」，刷新顶栏余额 pill（provider 信息变化）。
- **成本显性**（LLM-011 精神）：表单内注明「本地免费 / 云端按量计费」与 reasoningEffort 对 token 消耗的影响。

## 六、影响范围

| 模块 | 改动 | 风险 |
| --- | --- | --- |
| `apps/api/src/db/schema.ts` | 新增 `app_settings` 表 | 低——建表 IF NOT EXISTS，无迁移 |
| `apps/api/src/settings.ts`（新） | LlmSettings 类型 + 合并/校验/masked 工具 | 低 |
| `apps/api/src/providers/registry.ts` | 返回可变 holder + `rebuildLlm` | 中——热重建路径需冒烟 |
| `apps/api/src/services/analysis-service.ts` | provider → holder；segmentFields 可变 | 中——引用点 10+ 处 |
| `apps/api/src/routes/llm.ts` | 新增 GET/PUT settings | 低 |
| `apps/api/src/app.ts` | 装配设置服务与路由 | 低 |
| `apps/web/src/App.tsx` | view 三态 + 顶栏 + 余额刷新 | 中 |
| `apps/web/src/settings.tsx`（新） | 设置表单 | 中 |
| `apps/web/src/api/client.ts` | get/saveLlmSettings | 低 |
| verify-pipeline.ts | settings 合并/保留 key/热重建断言 | 低 |

## 七、验证

- typecheck 三包全绿；
- verify 新增：settings 合并优先级（db 覆盖 env）、apiKey masked 回传保留、holder 热切换后 current 变化、AnalysisService 经 holder 读 provider；
- curl 冒烟：GET 默认（env 生效）→ PUT 本地 ollama 配置 → GET 显示 db 覆盖 → 重建后 preview 的 provider 信息变化（零 LLM 请求）。
