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
