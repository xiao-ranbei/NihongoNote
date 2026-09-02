# NihongoNote 本轮工作概述

## 完成项

1. **段级字段档位制 + 键级省略**（决策 5）— `segmentFieldProfileSchema`（minimal/standard/full，默认 standard）；prompt 档位化 `buildSystemPrompt(profile)`：standard 合并 tone+politeness → `register`、可选字段无值不输出键；minimal 只输出翻译 + 语法。`segmentAnalysisSchema` 新增 `register`（nullable，向后兼容），UI 展示 register 优先、tone/politeness 兜底。schema/存储零迁移，只改 prompt 与预览系数。
2. **预览系数按档位取值** — `previewCoefficientsByProfile`：full 3,500/段 + 400/未命中（历史标定）、standard 2,200 + 320、minimal 1,500 + 300；`estimateAnalysisTokens` 支持档位参数；`LLM_SEGMENT_FIELDS` env 设默认档位。
3. **工具页档位切换** — 模式选择区新增三档 radio，切换即自动重算预览（零 LLM）；成本确认弹窗展示当前档位。
4. **Ollama 本地模型支持**（决策 6）— registry 放行 `ollama`；configured 恒 true（无 key）、client 用占位 key、`fetchBalance()` 返回 null、不发 `response_format`（靠 prompt 约束 JSON）；预览费用显示「本地免费（零 API 费用）」而非「价格未知」（`provider.isLocal`）；`.env.example` 给出 `LLM_PROVIDER=ollama` + `LLM_BASE_URL=http://127.0.0.1:11434/v1` + `LLM_MODEL=qwen3.5:9b` 示例。
5. **文档 + 验证** — `docs/analysis-tools-design.md` 新增 §3.8（档位制）/§3.9（Ollama），更新 §3.5/§五/§六/§七/§八；verify 新增档位系数断言；全量 typecheck 通过。

## 关键数字（场景 1：30 段 / 799 字）

| 档位 | 段级输出/段 | 段级费用（闲时） | 相比 full |
| --- | --- | --- | --- |
| full（原） | ~3,500 | ~¥0.47 | — |
| standard（默认） | ~2,200 | ~¥0.31 | 省 ~37% |
| minimal | ~1,500 | ~¥0.20 | 省 ~57% |

## 关键决策

- **决策 5** — 档位制 + 键级省略：只改 prompt 与预览系数，数据层零迁移；档位越低模型思考内容越少，实际节省通常好于字段比例。
- **决策 6** — Ollama 走既有 OpenAI 兼容抽象，零 API 费用，适合高频低预算场景。

## 下一步候选（待用户决定）

- **AI 路径真实回归**：用户许可后用现有样本跑 `pnpm --filter @nihongonote/api regression`，对比 standard 档实际输出与覆盖率
- **离线扩充固定库**：从「未命中 TOP 30」挑高频礼貌表达人工补 5-10 条
- **Ollama 实测**：本机装 Ollama + `ollama pull qwen3.5:9b` 后跑通完整链路
- **覆盖率基线跟踪**：每次词典扩充后跑 `pnpm --filter @nihongonote/api dictionary-coverage` 对比

---

## 分析失败调查（2026-09-01）

详见 `docs/analysis-failure-investigation-2026-09-01.md`。诊断全程使用本地 Ollama，**零云端费用**。

### 结论

DB 中 8 条 `failed` 句段已全部归因：6 条属 08-29 旧版本缺陷（截断 / schema 不匹配），
已被自适应 token 上限与 prompt v5 修复；**剩余 2 条是当前仍存在的问题，且均已 100% 复现**。

| 根因 | 证据 | 性质 |
| --- | --- | --- |
| **`LLM_TIMEOUT_MS=60000` 低于本地模型实际耗时** | 段 7 实测需 **78.1s / 4995 tokens / 63.9 tok/s**，阈值仅 60s；现有「自动重试」超时上限不变，必然二次失败 | 配置性永久失败 |
| **9B 模型稳定退化全角闭引号为 ASCII `"`** | 段 9 原始输出 L37：`"数量词，与“1"组成“1 つ”…"`；全篇 12 处，两次运行出错位置相同（均 L38） | 确定性触发，非随机 |
| **Ollama 未启动时静默失败** | `configured` 恒 true，服务不在时每句段各跑一遍 60s 超时才失败 | 可观测性问题 |

### 修复实施（**已落地并验证**）

- **P0** ✓ `providers/openai-compatible.ts` 新增 `repairStrayQuotes()`，`parseJsonResponse()` 改为三级修复链
  （原样解析 → 控制字符转义 → 引号修复）。只对解析失败的响应生效，正常路径零开销。
- **P1** ✓ `.env` 的 `LLM_TIMEOUT_MS` 60000 → 300000。
- **P2** ✓ `providers/ollama.ts` 新增 `assertServerReady()`，分析前探活 `/api/tags`，
  区分「服务未启动」与「模型未安装」并给出可操作提示。
- **P3** ✓ `.env` 的 `LLM_DEBUG_LOGGING` false → true（附实测依据注释）。
- 附带修正：诊断脚本的 `llmDebugLogging` 原先写死 `false`，与真实服务不一致，已改为跟随 `.env`。

**回归**：`verify-pipeline` **93/93 通过**（原 87 + 新增 6 条用例）；typecheck 干净；
**实机复跑两个原失败段全部成功**——段 7（82.8s / 4915 tokens）、段 9（38.3s / 2412 tokens）。

### 遗留项（均已闭环，无待办）

- ✓ **db 中 `profile-current` 串味配置已删除**。成因是迁移时 `.env` 的 `LLM_PROVIDER` 仍是
  `deepseek` 而 `baseUrl/model` 已指本地 Ollama，被拼成一组必然失败的配置。
  删前已备份 `data/nihongonote.db.bak-20260902-084940`；现保留内置双配置，
  激活项与顶层生效字段均不变（`ollama / 127.0.0.1:11434 / qwen3.5:9b`）。
- ✓ **`.env` 保持 `LLM_BATCH_SIZE=1` / `LLM_BATCH_CONCURRENCY=1`，不提速**。
  核查发现提速路径对本地模型不存在：装箱预算为 `8192 × 0.77 = 6308`，
  而估算式最小两段开销 `2×3500 + 2×230 = 7460 > 6308` → 批次恒为 1，
  调大 `LLM_BATCH_SIZE` 是空转；`CONCURRENCY=2` 需约 20.6GB VRAM > 16GB，
  会被 Ollama 排队而非真并行，收益近零却要承担 OOM 风险。

### 新增诊断工具

- `apps/api/scripts/diagnose-failures.ts` — 配置体检 / 服务探活 / 全篇超时风险扫描 / LLM 实测复现
  （默认零 LLM；`--llm`、`--generous-timeout` 开启实测）
- `apps/api/scripts/capture-raw-output.ts <段号>` — 抓取模型原始输出并定位非法字符

### 实测标定（供容量规划）

`qwen3.5:9b`，`num_ctx=12288`，`think:false`，`temperature=0.2` → **约 64 tok/s**；
`outputTokens ≈ 340 + 186 × n`（n = 送 LLM 的 token 数）。
60s 超时下 n 的安全上限约 **19**。
注意 `llm-budget.ts` 的估算式（3,500/段 + 230/字符）按 DeepSeek thinking 标定，
对本地模型高估约 4.8 倍，**不可用于推算本地耗时**。

---

## 项目进展审计（2026-09-02）

详见 `docs/progress-audit-2026-09-02.md`（对照 requirements / roadmap / issues 逐项核对源码）。

**一句话**：能用的学习闭环已跑通，成本治理（词典降本 + 本地模型）做得比原计划更深；
但所有「让阅读体验真正好用」的 P1 后续增强一层未动。

| 阶段 | 状态 |
| --- | --- |
| P0 验证和骨架 | ✅ 完成 |
| P1 MVP 交互式解析 | ✅ 完成 |
| P1 后续增强 | ❌ 未动（9 项） |
| P2 自用质量 | 🟡 部分（12 项未做） |
| P3 扩展 | ❌ 未开始（4 项） |
| UI 与主题层 | 🟡 六套 Token 已就绪，缺切换入口（3 项） |

关键缺口：**范围标注 `AnnotationRange`、四层点击循环、等级解释层 `LevelExplanation`、学习库内容类型筛选、导出、TTS** 全部零实现。

**⚠️ `issues.md` 已过时**：I-6/I-7/I-11/I-16/I-17/I-18/I-19 实际均已完成但文档仍标「待实施」，
I-20 已被决策 2 取消，I-21 的断言数应从 39 更新为 93。按文档排期会被误导。

近期建议：先修文档快照 → 扩充固定用法库（覆盖率 39.7% → 55%+）→ 接主题切换 UI → 导出 → 拆 `App.tsx`（现 1611 行）。
