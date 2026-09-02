# LLM 设置页设计（设置入口：本地 / 云端切换 + 多配置管理）

**状态**：已确认（2026-08-30）。用户拍板三项：① 保存即热切换（无需重启）；② API key 明文存本机库；③ 顶栏第三个视图「设置」。同日追加「多配置管理」（第八章）：预置 DeepSeek 云端 + 本地 Ollama（qwen3.5:9b）双配置，可保存、可切换。

## 一、背景与目标

当前 LLM 配置全部在 `apps/api/.env`（启动时由 `config.ts` 解析为 `appConfig` 常量），切换本地 Ollama / 云端 DeepSeek 需要手动改文件并重启服务。目标：在 Web UI 内完成配置与切换，并支持预先保存多组模型配置随时切换。

**非目标**：不改 TTS 配置；不暴露 batchSize/batchConcurrency/timeoutMs（保留 .env 控制，MVP 收敛表单面）；不做配置导入/导出。

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
  profiles?: LlmProfile[];      // 多配置管理（2026-08-30）：全部已保存配置，可选（兼容旧数据）
  activeProfileId?: string;     // 当前激活（生效）的配置 id
}

// 一组完整的模型配置（多配置槽位）
interface LlmProfile {
  id: string;                   // 唯一标识（内置：profile-deepseek / profile-ollama；新建：profile-<ts>）
  name: string;                 // 用户可改的显示名，如「DeepSeek 云端」「本地 Ollama」
  provider: LlmProviderName;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  temperature: number;
  maxTokens: number;
  segmentFields: SegmentFieldProfile;
  thinkingType: LlmThinkingType | null;
  reasoningEffort: LlmReasoningEffort | null;
}
```

### 2.3 配置优先级

`生效配置 = env 默认值 ∪ db 覆盖`——数据库有值的字段覆盖 .env，未设置过的字段回退 .env 默认（含 `LLM_THINKING_TYPE` 的 deepseek 特殊默认）。`.env` 仍是初始默认与「恢复出厂」语义：清空 db 设置即回到 .env。

## 三、API

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/llm/settings` | GET | 返回 `{ settings, source, provider, profiles, activeProfileId }`：`settings` 为生效配置（apiKey 回传 masked，如 `sk-49a…be98`）；`source` 逐字段标记 `db`/`env`；`provider` 为当前实例信息（name/configured/model/isLocal）供 UI 展示；`profiles` 为全部已保存配置（apiKey masked）；`activeProfileId` 为当前激活配置 id |
| `/api/llm/settings` | PUT | body 为 `LlmSettings`（apiKey 可选，`profiles`/`activeProfileId` 可选）。**key 回传保留规则**：body.apiKey 为空或等于当前 masked 值时视为「未修改」，保留库中原值（逐 profile 同规则）。保存 → 校验（复用 config.ts 校验口径）→ 多配置归一化（`resolveSettingsSave`）→ 写库 → **重建 provider** → 立即生效 |

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

## 八、多配置管理（profiles，2026-08-30）

把「本地 / 云端二选一」升级为「多组配置可保存、可切换」。预置两组开箱即用的配置：

| 配置 | provider | baseUrl | model | apiKey |
| --- | --- | --- | --- | --- |
| **DeepSeek 云端**（`profile-deepseek`） | `deepseek` | `https://api.deepseek.com` | `deepseek-chat` | 空，由用户填写 |
| **本地 Ollama**（`profile-ollama`） | `ollama` | `http://127.0.0.1:11434` | `qwen3.5:9b` | 无（本地免 key） |

### 8.1 新增配置的字段

每个配置槽位 = `LlmProfile`（见 2.2）：`id`、`name`（显示名）、`provider`、`baseUrl`、`apiKey`、`model`、`temperature`、`maxTokens`、`segmentFields`、`thinkingType`、`reasoningEffort`。与单组设置完全同构，仅多出 `id`/`name` 两个槽位字段。

### 8.2 保存方式

- **存储**：仍是 `app_settings` 表 `llm` 键（一个 JSON），但值扩展为 `{ ...激活配置字段, profiles: LlmProfile[], activeProfileId }`——顶层字段始终等于激活配置的展开，保证「已保存配置」与「当前生效」不脱节。
- **apiKey 保留规则（逐 profile 生效）**：某 profile 回传空 / masked 值时保留库中原 key；新值才覆盖。Ollama 等本地配置无需 key。
- **旧数据迁移**（`ensureLlmProfiles`）：老版本单组数据（无 profiles）自动迁移为内置双配置；若用户已自定义连接参数，则保留为「自定义配置」并激活，同时补上内置双配置；已有 profiles 则原样保留。
- **兼容**：旧客户端发单组 PUT（无 profiles）仍可用——展开字段写回激活配置，语义不变。
- **热切换**：保存后重建 provider（`providerHolder.replace`）+ 更新 `segmentFields` 档位，进行中的分析继续用旧引用，下一批自动用新配置，无需重启。

### 8.3 界面切换交互（settings.tsx）

设置页顶部新增「0. 已保存配置」槽位区：

1. **配置卡片**：每个已保存配置一张卡片（名称 + provider 标签 + 模型名），当前激活的带绿色「当前」徽标；点击卡片即载入该配置进行编辑（切换编辑不会丢失当前未保存的修改，编辑内容先落回草稿）。
2. **＋ 新建配置**：复制当前编辑项为新槽位（连接参数保留、apiKey 留空、自动命名「新配置 2/3…」），方便在相似配置上演化。
3. **设为当前并立即生效**：把正在编辑的配置一键切换为激活项并**立即保存生效**（热切换，无需再点底部保存）——这是「随时快速切换」的主入口。
4. **删除该配置**：至少保留一个；激活中的配置不能直接删，需先切换到其他配置。
5. **底部「保存全部配置并立即生效」**：将全部槽位 + 激活项一次性落库并热切换。
6. **当前生效指示**：页顶状态条显示激活配置的名称 / 服务商 / 模型与「已就绪 / 未配置」徽标，保存后同步刷新顶栏余额 pill。

切换语义：**「设为当前」= 立即保存 + 热切换**；**「保存全部」= 整体落库 + 按当前激活项生效**。进行中的分析任务不受切换影响。

### 8.4 影响范围（相对第七章追加）

| 模块 | 改动 |
| --- | --- |
| `apps/api/src/settings.ts` | `LlmProfile` 类型 + `builtinLlmProfiles`（内置双配置）+ `ensureLlmProfiles`（迁移）+ `resolveSettingsSave`（PUT 归一化纯函数） |
| `apps/api/src/routes/llm.ts` | GET 返回 profiles/activeProfileId；PUT 走 `resolveSettingsSave` |
| `apps/web/src/api/client.ts` | `LlmProfile` 类型；`LlmSettingsState` 增 profiles/activeProfileId |
| `apps/web/src/settings.tsx` | 配置槽位区（卡片 / 新建 / 设为当前 / 删除）+ 表单编辑选中配置 |
| `apps/web/src/styles.css` | `.profile-tabs` 等槽位样式 |
| verify-pipeline.ts | 迁移 / 双配置预设 / PUT 归一化 / key 保留断言（87 项全绿） |
