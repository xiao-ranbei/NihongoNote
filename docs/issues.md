# NihongoNote 问题清单（Issues）

**用途**：集中追踪所有已知问题、技术债与待决策项。已修复项留档可追溯，未修复项按优先级推进。
**建立**：2026-08-29 晚
**关联**：详细修复过程见[优化评审清单](optimization-review.md)与[路线图进度审阅](roadmap.md#九进度审阅记录)；词典/AI 成本方案见[分析工具化与内置词典降本设计](analysis-tools-design.md)。

> 状态约定：**[已修复]** = 已改代码并有验证数据；**[未处理]** = 待办；**[待决策]** = 需要用户拍板。
> 优先级：P0 会损坏数据/阻塞使用；P1 影响成本/质量；P2 影响可维护性；P3 增强。

---

## 一、数据与可靠性

### I-1 【缺陷·P1】[已修复] 说话人正则误吞原文（A-2）

`segmentation.ts` 的说话人正则曾把 `https://`、`10:30` 开头识别为 speaker 并吞掉原文前缀。已修：标签禁含 `/ \ @` 与冒号、长度上限 20、单独拦截协议名。详见 optimization-review.md A-2。

### I-2 【缺陷·P1】[已修复] 数据库全量同步落盘（A-1）

每次 `run()` 全量 export + 同步写盘，长文分析持续劣化。已修：标脏 + 空闲 2 秒防抖 + 原子替换 + 退出补写。详见 optimization-review.md A-1。

### I-3 【缺陷·P1】[已修复] 分词碎片化冲击成本与质量（T-1）

`Intl.Segmenter` 把「ありがとうございます」切成单字碎片。已做短期止血（三段后处理合并，token 176→154）。**中期正确解（形态素分析器）未引入**，现并入词典方案升级讨论，见 `analysis-tools-design.md` 第九节与本文档第五节。

### I-4 【缺陷·P1】[已修复] 输出截断 / 控制字符 / 缺字段（T-2 及缺陷 3/4）

按批量自适应 max_tokens、字符串字面量控制字符转义、`confidence`/顶层字段 `default(null)` 降级、prompt v5 明确全部字段必出。详见 roadmap 第九节。

### I-5 【偏差·P1】[未处理] `usage_json` 历史数据缺缓存命中字段

**现状**：`llm-prompt.md` 声称缓存命中随 usage 落库，但库里 42 条历史 `usage_json` 全部只有 `inputTokens/outputTokens/totalTokens` 三字段——缓存字段是后来加的，**历史数据未回填**。影响：这批数据的费用估算按「未命中」计价，偏高。

**修法**：一次性迁移脚本，旧数据无缓存信息按未命中处理（不阻塞、零 token 消耗）。新数据已含 `cachedInputTokens`。

---

## 二、JSON 与数据格式

### I-6 【技术债·P2】[未处理] `result_json` 宽表：14 字段每 token 必填，恒定 null 也占位

word 的 `particleFunction` 恒 null、particle 的 `conjugation` 恒 null……宽表保证 LLM 输出稳定（优点），但恒定 null 也在烧 token。

**修法**（与词典方案联动）：词典/形态素命中的 token 只存必要字段（`tokenId + category + explanation + source`），未命中的才走完整宽表；schema 非必填字段改 optional，向后兼容。

### I-7 【技术债·P2】[未处理] JSON 内缺 `schemaVersion`

版本只挂在 `prompt_version` 列，`result_json` 自身无版本号，迁移时无法从数据自判格式。建议内嵌 `schemaVersion: 1`。

### I-8 【技术债·P3】[已做对，保持] 原始响应与规范化结果分离

provider 层已拆分「原始响应」与「规范化结果」，便于排查模型质量问题。**保持现状，不合并**。

---

## 三、需求与数据模型

### I-9 【偏差·P2】[未处理] `toneEvidence` 字段未落地（R-1）

验收要求「解析能指出具体原文证据」，当前只有自由文本 `tone`，无法区分结论与依据。建议 `segmentAnalysisSchema` 增加 `toneEvidence: string | null`，prompt 要求引用原文片段。

### I-10 【偏差·P3】[未处理] `politenessLevel` 未用五档枚举（R-2）

需求定义「随意/普通/礼貌/尊敬/自谦」五档，实现是自由文本。后续做筛选/统计无法归类。MVP 可保留自由文本，schema 加 `z.enum` 约束。

### I-11 【偏差·P3】[未处理] 说话人识别未降级为可关闭启发式

A-2 修复时未采纳「降级为可关闭启发式 + UI 修正入口」。PATCH 改 speaker 的 API 已存在，但前端无触发入口。

---

## 四、UI 与主题

### I-12 【偏差·P3】[未处理] 移动端学习库是堆叠不是抽屉（U-2）

窄屏下学习库排到正文下方（堆叠），需求要求「覆盖主内容的抽屉」。与移动端解析卡片抽屉同机制，可一起做。

### I-13 【技术债·P2】[未处理] `App.tsx` 1444 行单一组件（U-3）

21 个 useState + 内联渲染函数。后续范围标注会失控。建议拆 ReaderCanvas / LibraryPanel / SegmentAnalysisPanel / TokenPopover / ComposerCard + useDocumentAnalysis hook。

### I-14 【增强·P3】[未处理] 主题切换 UI 未接入

六主题 Token 已落地（`data-theme`），但 App.tsx 未接下拉 + localStorage + prefers-color-scheme 自动跟随。非 paper 主题还需对比度微调。

### I-15 【技术债·P3】[未处理] 无障碍细节（D-2）

无 `prefers-reduced-motion`；token 按钮无可见焦点环；无 `prefers-color-scheme` 跟随（配合 I-14）。

---

## 五、成本与词典方案（已决策）

详见 [analysis-tools-design.md](analysis-tools-design.md)。2026-08-29 晚用户拍板 4 项决策：

### I-16 【决策已定】[待实施] 形态素分析器选用 kuromoji.js

- **决策**：引入 kuromoji.js（本地 IPADIC 词库，1–2MB），负责分词 + 词性 + 原形 + 读音；
- 收益：4 个事实字段（lemma/reading/partOfSpeech/conjugation）本地确定，砍约 30% 输出字段；顺带解决 T-1 分词残留问题；
- 风险：IPADIC 对专名/新词覆盖一般，LLM 兜底不可去；
- 实施：见 design 文档六、2；需与现有分词做边界对比验证。

### I-17 【决策已定】[待实施] 词典/缓存命中 token 采用瘦身存储

- **决策**：命中 token 只存 `tokenId + category + surface + explanation + source`（+ 必要的 reading/gloss），不存 14 字段宽表；
- 未命中 token 才走完整宽表；schema 非必填字段改 optional，向后兼容；
- 联动 I-6（result_json 宽表瘦身）。

### I-18 【决策已定】[待实施] 句段级语义仍走 AI + 词典化兜底

- **决策**：tone/impliedMeaning/replyReason/grammarSummary 仍走 AI（理解层不可替代）；
- 固定用法库内置常见句末语气模板（～ますね/～でしょう/～そうです…），命中时提供参考语气/礼貌度，简单句可省整段 AI 调用；
- 提供「仅词典分析」零费用模式（决策 4 附带确认）。

### I-19 【决策已定】[待实施] 分析工具页形态：独立页面（倾向）

- **决策**：独立页面（与设置页同级），职责拆分——设置页管配置，工具页管执行；支持多选批量 + 成本确认弹窗；
- 实施时与设置页一并落地，最终布局实施前再确认一次。

### I-20 【决策已定】[待实施] 解释缓存回填机制：固定用法库起步 + 用户确认回填

- **决策**：固定用法库（助词 ~40 + functional ~30 + 句末语气模板）起步；用户在解析卡上确认过的 AI 解释沉淀为缓存条目；
- **未确认的解释不进缓存**（防止错误解释固化）；回填条目 confidence=0.9、来源 dictionary。

---

## 六、测试与工程

### I-21 【基建·P2】[未处理] vitest 未引入

现有 verify-pipeline 为自包含断言脚本（39 项）。建议引入 vitest 优先覆盖 `segmentation.ts` 偏移正确性与 `analysis-service.ts` 校验逻辑。

### I-22 【基建·P3】[未处理] ESLint 未引入

---

## 七、优先级汇总

| 优先级 | 事项 | 状态 |
| --- | --- | --- |
| P1 | I-5 usage_json 缓存字段回填（迁移脚本，零成本零 token） | 待做 |
| P2 | I-6/I-7 JSON 瘦身 + schemaVersion（随词典方案实施） | 待做 |
| P2 | I-9 toneEvidence、I-13 App.tsx 拆分、I-21 vitest | 待做 |
| P2 | I-16~I-20 词典方案（**决策已定**，进入实施队列） | 待实施 |
| P3 | I-10/I-11/I-12/I-14/I-15 增强项 | 待做 |
