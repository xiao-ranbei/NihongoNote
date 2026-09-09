# P1 后续增强设计（范围标注 / 四层交互 / 等级解释层）

> 生成日期：2026-09-09
> 依据：`requirements.md` §1.1 / §1.3 / §1.4 / §六，`docs/progress-audit-2026-09-02.md` 第三节，
> 以及对 `packages/core/src/domain.ts`、`apps/web/src/App.tsx`、`apps/web/src/styles.css` 的实地勘察。
> 状态：**待用户确认**（按「先文档后实现」，确认后才进入实现）
> 前置原则：LLM-011——任何产生云端费用的步骤必须单独列出代价并取得明确批准。

---

## 一、现状（代码事实，非推断）

| 项 | 现状 |
| --- | --- |
| `AnnotationRange` / `LevelExplanation` / `CanonicalAnalysis` / `drawer` | 全仓库 **0 命中** |
| `App.tsx` | **1763 行**，其中 `App()` 组件本体占 898–1763（约 865 行） |
| 解析卡呈现 | `.notes-column`，`position: sticky; top: 20px` 的**右侧固定栏**——**不是**需求要求的「跟随点击位置的锚点卡片」 |
| 点击模型 | `selectedSegmentId` + `selectedTokenId` 两层扁平状态，**无层级循环** |
| token 渲染 | `renderSegmentContent()` 按 `startOffset/endOffset` 切分，每个 token 一个 `<button class="annotation-token annotation-{category}">` |
| 线型现状 | word/particle/functional/adverb/grammar 五类已有下划线；**grammar 已占用单层波浪线**（`text-decoration: underline wavy`） |
| 响应式断点 | 已有 1000px / 860px / 700px / 520px 四档 |
| 存储 | 段级分析整体存 `segment_analyses.result_json`（单列 JSON），`schemaVersion` 字段已就位（I-7） |
| 覆盖率 | 启用 jmdict-common 后 **92.7%**，仅 **42 段 / 67 token** 需 AI 兜底（本轮实测） |

### 两个必须先解决的冲突（否则后续返工）

1. **锚点卡片 vs 现有右栏**：需求 §1.1 要求「桌面端使用跟随点击位置的锚点卡片，靠近视口边缘自动换位」。
   现有 sticky 右栏不满足，需新增定位层。
2. **范围波浪线 vs token 类下划线**：需求要求语法范围「单层波浪线」、语气范围「双层波浪线」，
   而 token 类别已用 `text-decoration` 画下划线且 grammar 已占单层波浪。
   **同一元素上 `text-decoration` 无法叠加两层**，必须用另一套机制承载范围线型（见 §五）。

---

## 二、目标与非目标

### 目标
1. 跨词范围可标注、可点击、可解释（`AnnotationRange`）。
2. 同一位置重复点击按四层循环，缺失层级自动跳过。
3. 桌面锚点卡片跟随点击位置并在视口边缘自动换位；移动端改底部抽屉。
4. 基础事实层与等级表达层分离（`CanonicalAnalysis` / `LevelExplanation`），切等级不重新分词。

### 非目标（本轮不做）
- TTS（P3）、多设备同步、公网部署。
- 文件夹/标签体系（需求明确「第一版不引入文件夹」）。
- 自动识别结果当作最终事实（需求 §1.2：必须可修正并显示来源）。
- 重做分词或偏移体系——**既有 segment/token ID 与 UTF-16 偏移必须保持不变**（需求 §1.4）。

---

## 三、数据模型增量（`packages/core/src/domain.ts`）

遵循需求 §六 的字段建议，全部**新增为可选字段**（旧数据无此字段仍可读，向后兼容）。

### 3.1 `annotationRangeSchema`（新增）

```ts
export const annotationRangeKindSchema = z.enum([
  "grammar",   // 多词语法结构
  "tone",      // 语气/态度
  "modifier",  // 副词修饰范围
  "clause"     // 分句
]);

export const annotationRangeSchema = z.object({
  id: z.string().min(1),
  segmentId: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  kind: annotationRangeKindSchema,
  style: z.enum(["single-wave", "double-wave", "block"]),
  targetTokenIds: z.array(z.string().min(1)).min(1),
  explanation: z.string().min(1).nullable().default(null),
  evidenceTokenIds: z.array(z.string().min(1)).default([]),
  confidence: confidenceSchema.default(null),
  source: z.enum(["ai", "user", "local"]).default("ai"),
  revisionId: z.string().min(1).nullable().default(null)
});
```

- `source: "local"` 为**零成本本地派生**范围预留（见 §六 S2 说明）。
- `targetTokenIds` 与 `start/end` 并存：前者用于交互命中，后者用于渲染定位与跨行切分。

### 3.2 `segmentAnalysisSchema` 增量

```ts
annotationRanges: z.array(annotationRangeSchema).default([]),   // 新增
schemaVersion: z.number().int().positive().optional()           // 已存在，值 +1
```

### 3.3 段级语气字段（需求 §六，补 I-9/I-10 验收缺口）

```ts
conversationFunctionTags: z.array(z.string()).default([]),
attitudeTags: z.array(z.string()).default([]),
toneStrength: z.enum(["weak", "medium", "strong"]).nullable().default(null),
toneEvidence: z.string().min(1).nullable().default(null),
politenessLevel: z.enum(["casual", "plain", "polite", "respectful", "humble"]).nullable().default(null),
registerTags: z.array(z.string()).default([])
```

### 3.4 等级解释层（需求 §1.4，S6）

```ts
// 只存事实，一篇文章一份
canonicalAnalysisSchema: { id, sourceVersion, segmentId, tokenizerVersion,
  tokenFacts, grammarFacts, sentenceMeaningFacts, toneFacts, politenessFacts,
  dialogueContextFacts, annotationRanges, evidenceTokenIds }

// 按等级生成/缓存，不改写 canonical
levelExplanationSchema: { id, canonicalAnalysisId, targetLevel, explanationVersion,
  translation, teachingSummary, vocabularyNotes, examples }
```

**过渡策略（需求 §1.4 明确允许）**：当前 `SegmentAnalysis` 继续作为兼容载体，
先在其上挂 `annotationRanges`；`CanonicalAnalysis`/`LevelExplanation` 的**物理拆分**放到 S6，
通过 `canonicalAnalysisId` + `explanationVersion` 关联，**不动既有 ID 与偏移**。

---

## 四、交互设计

### 4.1 四层点击循环（需求 §1.1）

层级顺序：`0 句子结构 → 1 词语/助词/副词 → 2 多词语法 → 3 语气/态度`

状态机（替换现有扁平 `selectedSegmentId`/`selectedTokenId`）：

```ts
interface ReaderSelection {
  segmentId: string;
  tokenId: string | null;   // 触发位置（token 或整句）
  layer: 0 | 1 | 2 | 3;
}
```

规则：
- 同一 `segmentId + tokenId` 重复点击 → `layer` 递增（mod 4），**跳过该位置没有内容的层级**；
- 点击其他位置 → `layer` 重置为 0；
- 点击文章外 → 清空选择（现有行为保留）；
- 悬浮只强化范围（加 `.is-hover`），**不弹卡片**。

### 4.2 锚点卡片换位（桌面）

新增 `useAnchoredCard(triggerRect)`：
1. 取触发元素的 `getBoundingClientRect()`；
2. 优先放右侧，其次左侧，再次上方/下方；
3. 与视口做碰撞检测（含 16px 安全边距），越界则换位；
4. 尺寸超视口时改为贴边 + 内部滚动。

**回滚保护**：保留现有 sticky 右栏作为 `readerCardMode` 的 `"column"` 取值，
新增 `"anchored"`；出问题时切回即可，不影响数据。

### 4.3 移动端（≤700px 沿用已有断点）

- 解析内容改**底部抽屉**（`role="dialog"` + `aria-modal`，焦点 trap，Esc 关闭）；
- 学习库改**覆盖式抽屉**（需求 §1.3），折叠状态继续存 localStorage（现有机制已支持）。

---

## 五、范围渲染方案（关键技术决策）

### 问题
范围跨多个 token 且**可互相重叠**（一个 token 可能同时属于语法范围和语气范围）。
把连续 token 包进 `<span class="range">` 在重叠时无法正确嵌套。

### 方案：**按 token 标记范围归属，用两套机制分离的样式层**

渲染前预计算 `Map<tokenId, RangeKind[]>`，给每个 token button 追加：
- `in-range`、`range-grammar` / `range-tone` / `range-modifier` 等类；
- `data-range-ids` 属性（用于点击命中范围）。

样式分层（避免与 token 类下划线冲突）：

| 层 | 承载机制 | 说明 |
| --- | --- | --- |
| 句子背景 | `.article-segment` 背景 | 已存在 |
| 范围背景色块 | token 的 `background-color` | 最低层，默认可见 |
| 范围波浪线 | token 的 `::after` 伪元素 + 重复波浪背景 | 与 `text-decoration` 分离，**可叠加** |
| token 类别下划线 | token 的 `text-decoration` | 已存在，不动 |

双层波浪线：`::after` 画一层 + `::before` 画一层（错开 3px）。
需先做一个 CSS 小验证（spike）确认跨行与缩放下的对齐——**这是 S2 的进入条件**。

### 备选（已否决）
包裹 `<span>` 方案：重叠范围无法嵌套，且会破坏现有 token button 的可访问性结构。

---

## 六、分期实施计划

原则：**UI 先行、LLM 后置**。范围渲染与交互全部用 **fixture 假数据**开发验证，
唯一花钱的 S5（让 LLM 真正产出范围）放到最后单独批准。

| 期 | 内容 | 云端费用 | 独立验证 | 回滚方式 |
| --- | --- | --- | --- | --- |
| **S0** | `App.tsx` 拆分（1763 行 → 按职责拆 5–7 个模块） | 零 | verify + 构建 + 手工走查无行为变化 | 单 commit revert |
| **S1** | core schema 增量 + 迁移 + API 透传（无 UI） | 零 | verify 新增 schema 断言；旧数据仍可读 | schema 字段可选，删即回滚 |
| **S2** | 范围渲染（读 fixture ranges）+ 图例 + CSS 分层 | 零 | fixture 页面：背景/波浪/重叠/跨行 | 删渲染分支 |
| **S3** | 四层点击循环 + 锚点卡片换位（桌面） | 零 | 点击序列断言 + 视口边缘换位 | `readerCardMode` 切回 `"column"` |
| **S4** | 移动端抽屉（解析 + 学习库） | 零 | 窄屏走查 + 焦点/Esc | 断点下走旧布局 |
| **S5** | **LLM 产出 ranges**：提示词 + 解析 + 预算系数 | **有（需批准）** | 受控回归 1 篇，对比前后 | 提示词开关 `LLM_EMIT_RANGES` |
| **S6** | `CanonicalAnalysis` / `LevelExplanation` 物理拆分 | 零（切等级才生成） | 切等级不重新分词、ID/偏移不变 | 过渡载体仍在 |
| **S7** | 学习库内容类型筛选 + 范围编辑 | 零 | 筛选/编辑断言 | 功能开关 |

> S0 是 S2/S3 的硬前提：在 1763 行单文件里加范围渲染与层级状态机会不可控。

### 各期完成标准（DoD）
- verify 全绿、typecheck 与生产构建干净；
- 新增断言覆盖本期新增行为；
- 提供回滚开关或单 commit 可 revert；
- 涉及费用的期次，实测费用写入本文档 §八。

---

## 七、验收标准（EARS）

| 编号 | 功能 | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| AC-R1 | 范围渲染 | When 一个 token 属于某范围，系统**必须**显示该范围的背景色块与对应线型 | P0 |
| AC-R2 | 范围重叠 | When 一个 token 同时属于语法与语气范围，系统**必须**同时呈现两层线型且互不覆盖 | P0 |
| AC-R3 | 范围点击 | When 用户点击范围，系统**必须**显示该范围的完整解释而非单个 token 解释 | P0 |
| AC-R4 | 四层循环 | When 在同一位置重复点击，系统**必须**按「句子→词语→语法→语气」循环并跳过空层级 | P0 |
| AC-R5 | 层级重置 | When 点击其他位置，系统**必须**从第一层重新开始 | P0 |
| AC-R6 | 锚点换位 | When 卡片接近视口边缘，系统**必须**自动换位且**不得**遮住触发位置的关键原文 | P1 |
| AC-R7 | 移动端 | While 视口 ≤700px，系统**必须**用底部抽屉承载解析，不依赖悬浮 | P1 |
| AC-R8 | 悬浮 | While 悬浮于范围，系统**必须**只强化范围，**不得**弹出卡片 | P1 |
| AC-R9 | 等级切换 | When 用户切换目标等级，系统**必须**只重新生成解释层，**不得**重新分词或改变 token ID/偏移 | P0 |
| AC-R10 | 事实/表达分离 | If 用户修正属于事实（词义/词性），系统**必须**作用于 canonical；若属表达，只影响 level explanation | P1 |
| AC-R11 | 向后兼容 | While 读取无 ranges 的旧数据，系统**必须**正常渲染，范围层整体缺席 | P0 |
| AC-R12 | 类型筛选 | When 用户按内容类型筛选学习库，系统**必须**只显示匹配文章且不影响已有解析 | P2 |

---

## 八、代价与风险

### 云端费用（唯一来源：S5）

- **S0–S4、S6–S7 零云端费用**（纯前端/本地；S6 切等级才生成解释层，属用户显式动作）。
- **S5 估算（待实测确认，勿据此决策）**：
  - 增量输出 ≈ 每段 3 个 range × 每个约 60–100 输出 tokens ≈ **+180~300 输出 tokens/段**；
  - 当前需 AI 兜底 **42 段**（覆盖率 92.7% 后）→ 约 **+7,600~12,600 输出 tokens/篇**；
  - deepseek-v4-flash 输出单价 闲 4.5 / 峰 9.0 元每百万 → 约 **¥0.034~0.057（闲时）/ ¥0.068~0.113（高峰）每篇**。
  - **必须实测**：用 `docs/evaluation-corpus.md` 的样本做前后对比回归，实测值回填本表。
    估算未含思考 token；实测前不批准实施。

### 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 1763 行单文件改造失控 | 高 | S0 先拆；S2 起才有功能改动 |
| 波浪线与既有下划线冲突 | 中 | S2 进入条件为 CSS spike 通过 |
| LLM 产出范围不稳定/编造 | 中 | 范围 `confidence` + `source` 落库；低置信度不渲染；`evidenceTokenIds` 可回溯 |
| 等级切换引发重新分词 | 高 | AC-R9 断言 ID/偏移不变；物理拆分放 S6 |
| 锚点卡片在长文滚动时错位 | 中 | 滚动/尺寸变化时重算；越界降级为贴边 |

---

## 九、未决项

| 项 | 现状 | 待定 |
| --- | --- | --- |
| 范围来源比例 | AI 产出 vs 本地派生未定 | **建议**：零成本本地派生先做（`source:"local"`，如副词修饰范围、助词附着范围），AI 范围作为增量 |
| 双层波浪线实现 | 需 CSS spike | S2 进入条件 |
| 等级切换是否缓存多等级解释 | 未定 | S6 定；倾向按 (canonicalId, level) 缓存 |
| 范围编辑的交互入口 | 需求只说「后续实现」 | S7 定 |

---

## 十、建议的第一步

**S0（`App.tsx` 拆分）**——零费用、零功能变化、且是后续所有 UI 工作的硬前提。
拆分完成后再按 S1→S2→S3 推进，S5 单独提交费用申请。
