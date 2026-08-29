# NihongoNote 优化评审清单

**评审日期**：2026-08-28
**基线**：Git `e1b6d2d`
**方法**：代码通读 + 运行时实测（`Intl.Segmenter` 分词、说话人正则）+ 文档/实现交叉比对
**状态更新**：2026-08-29 晚完成 A-1 / A-2 / T-1 / T-2 / U-1 五项修复并验证，各条目下附「修复记录」；实测数据另见[路线图第九节](roadmap.md#九进度审阅记录)。

> 每条问题标注来源文件与行号。分类说明：
> **缺陷** = 会导致错误数据的 bug；**偏差** = 实现与需求文档不一致；**技术债** = 不影响当前功能但阻碍后续扩展。
>
> 标记约定：**[已修复]** = 已改代码并有验证数据；**[未处理]** = 仍在待办。

---

## 一、架构实现（2 个缺陷）

### A-1 【缺陷·高】[已修复] 每次写库都全量同步落盘

**证据**：`apps/api/src/db/database.ts:58-94`（修复前）

```ts
public run(sql: string, params?: QueryParams): number {
  this.database.run(sql, params);
  const changedRows = this.database.getRowsModified();
  this.persistIfReady();   // → persist() → fs.writeFileSync(全量 export())
  return changedRows;
}
```

`persist()` 每次执行 `database.export()`（把整个 SQLite 序列化成字节数组）后 `writeFileSync` 同步写盘，且**没有防抖**。

**影响**：保存一个 segment 的分析会触发多次 `run()`（更新 `segment_analyses` + `segments` + `documents`）。分析 100 个句段 = 200~400 次全量序列化 + 同步写盘。数据库随文章累积增长到几十 MB 后，每次写盘都是同步阻塞 Node 事件循环，API 响应明显卡顿，长文分析越跑越慢。

**建议**：三选一，按成本递增：
1. **低成本**：空闲防抖写盘（2 秒无写入才 flush）+ 进程 `beforeExit`/`SIGINT` 时强制 flush；
2. **中成本**：脏标记 + 后台定时（如 5 秒）异步写，写时用临时文件 + rename 保证原子性；
3. **长期**：换 `node:sqlite`（Node 22 内置）或 `better-sqlite3` 走真 WAL，摆脱全量导出模型。

> 注意方案 1/2 都要保证异常退出不丢数据，建议配合"写前备份上一版"策略。

**修复记录（2026-08-29）**：采用方案 1 + 2 的组合——标脏 + 空闲 2 秒防抖 + 临时文件 rename 原子替换，并在 `exit` / `beforeExit` / `SIGINT` / `SIGTERM` 上补写。信号只 flush 不 close，避免打断 Fastify 自己的关闭流程。

验证（`verify-pipeline.ts`，4 项断言）：200 次连续写入期间文件大小保持不变 → 确认攒住了；空闲后一次性落盘且重开读到 200/200 行；无 `.tmp` 残留；**用子进程模拟「写完不调 `close()` 直接 `process.exit(0)`」，退出钩子成功补写**。

未采用方案 3（换 `node:sqlite`）：改动面大，且当前防抖后写放大已不是瓶颈。若以后数据库涨到几十 MB 再评估。

---

### A-2 【缺陷·高】[已修复] 说话人识别正则误吞原文

**证据**：`apps/api/src/segmentation.ts:14`（修复前）

```ts
const speakerPrefixPattern = /^(\s*)([^：:\r\n]{1,40})[：:]/u;
```

**实测结果**：

| 输入行 | 识别出的 speaker | 是否正确 |
| --- | --- | --- |
| `李：こんにちは` | `李` | 正确 |
| `A: はい` | `A` | 正确 |
| `https://example.com を参照` | **`https`** | 错误 |
| `10:30 から会議です` | **`10`** | 错误 |

**影响**：命中后 `contentStart` 会跳过 `speaker` + 冒号，因此 `https://example.com を参照` 的正文变成 `//example.com を参照`——**原文前缀被静默吞掉**。视觉上不丢（阅读框用 `sourceText` 补 gap），但送去 LLM 的内容和 `segments` 表里的 `text` 是残缺的，`speaker` 字段也被污染为 `"https"`。新闻/说明文里出现 URL 或时间戳就会触发。

**建议**：
1. 收紧规则：只接受短标签（≤ 12 字符）、不含 `/` `.` `@`、且冒号后必须有空白或日文字符；
2. 增加反向校验：候选 speaker 若匹配 URL/时间/数字模式则拒绝；
3. 由于需求明确"自动识别只作建议"，最稳妥的是**把说话人识别降级为可关闭的启发式**，并在 UI 上暴露修正入口（当前 `PATCH /api/segments/:id` 已支持改 speaker，但前端没有触发入口）。

**修复记录（2026-08-29）**：采用建议 1 + 2，但**没有**采纳「标签不含 `.`、冒号后必须有空白或日文」这两条——实测会误伤真实语料：

| 约束 | 若采纳的后果 |
| --- | --- |
| 标签不含 `.` | 无实际收益（排除 `.` 挡不住 `https://`，真正起作用的是排除 `/`） |
| 冒号后必须是空白或日文 | 会漏掉 `田中：Hello` 这类混排，且对 URL 判别没有额外贡献 |

最终规则：标签首字符非空白、尾字符非空白、中间允许空格、全段禁含 `/ \ @` 与冒号，长度上限 20；冒号后接 `(?!\d)` 挡时间、`(?![\\/])` 挡盘符与路径；`https`/`http`/`ftp`/`mailto`/`tel`/`file` 单独用 `rejectedSpeakerLabels` 拦掉全角冒号变体。

关键取舍是**长度上限取 20 而非建议的 12**：真实语料里 `田中部长`、`山田课长` 这类中文角色标签很常见，12 会误伤。

验证：9 个分段用例（4 个正例含「带空格的标签」「20 字内长标签」，5 个反例含 URL / http / 时间 / 全角协议名 / Windows 盘符）。真实语料覆盖率 94.6%，丢失的 19 个非空白字符全部是说话人标签本身。

> 排查过程中发现两处「改一个坏一个」，都靠验证脚本抓住：收紧标签字符集后 `店員 ：` 这种带空格的标签失效；给词尾加助词判断后 `ください` 因 `だ` 是助动词而被误判。目前 9 个正/反例成对存在，后续再改正则必须两边一起跑。

建议 3（降级为可关闭启发式 + UI 修正入口）仍未处理，属 P1 后续增强。

---

## 二、技术栈（1 个短板）

### T-1 【缺陷·高】[已修复] `Intl.Segmenter` 分词粒度过细，直接冲击成本与需求

**证据**：`apps/api/src/tokenization.ts:8-26`，Node 22 实测

| 原文 | 分词结果 |
| --- | --- |
| `ありがとうございます` | `["ありがとう", "ご", "ざ", "い", "ます"]` |
| `伺わせていただきます` | `["伺", "わせ", "て", "いただきます"]` |
| `担当していますが` | `["担当", "し", "てい", "ます", "が"]` |

**三重影响**：

1. **成本与延迟**：一个敬语动词被切成 5 个 token，prompt 要求"每个 token 返回 lemma/reading/pos/gloss/explanation"，输出 token 数成倍增长。文档记录的基线是 3 个句段耗时 76s/64s/166s，分词碎片化是重要推手。
2. **质量**：`ご` / `ざ` / `い` 单独没有语义，模型无法给出有意义的解释，只能填 `null` 或编造。
3. **需求无法实现**：`requirements.md` 第 74 行要求"虚线下划线：助动词和其他功能词"，但 `functional` 这个类别**在数据模型里不存在**——`packages/core/src/domain.ts:45` 的 `tokenCategorySchema` 只有 `word / particle / adverb / grammar` 四类。

**建议**（分两步）：
- **短期止血**：在 `tokenization.ts` 里加后处理合并规则——把连续的附属碎片（ひらがな单字 + 后续助动词）合并回前一个实词，让"ありがとうございます"回归 2~3 个 token。改动集中在单文件，风险可控。
- **中期正确解**：换 `kuromoji.js` 或 `MeCab` 系形态素分析器（架构文档第 31 行本就规划了这一步），拿到真正的品词信息后，`functional` 类别和线型标注才成立。

> 顺序建议：**先做合并后处理，再评估是否值得上形态素分析器**。前者当天可完成且立即降低成本。

**修复记录（2026-08-29）**：完成短期止血（合并后处理），`functional` 类别也一并补进数据模型（见 U-1）。形态素分析器暂未引入。

`tokenization.ts` 改为三段后处理：

1. **剥离被粘住的助词**——Segmenter 会输出 `てい` 这种「助词 + 单字」的粘合体，不拆开就永远识别不出 `て` 的边界。白名单**只放 `て`**：`は`/`に`/`で` 同样是格助词，但它们是大量和语词的首音节（はる／にほん／でる），放开就会把正常的词剁成两半。
2. **碎片向左并入词干**——日语是黏着语，活用尾天然跟在词干后。但前一个词整体是助词、或以助词收尾时不并（`実は` + `うち` 不能并）。
3. **助词后的碎片向右并**——`勉強|し|て|い|ます` 里 `い` 左边是助词 `て`，向右并成 `います`，正是教材的标准切法。

助词白名单拆成两组：格助词/接続助词/副助词参与「词尾边界」判断，助动词（`だ`/`た`/`ない`…）**不参与**——它们是大量普通词的尾音节，`くだ` 一旦被判成助词边界，`ください` 就永远拼不回来。

真实语料实测（样本 1 前 5 轮对话，12 个 segment）：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| token 总数 | 176 | **154** |
| 平均 token 长度 | 1.77 | **2.07** |
| 单字 token 占比 | 44.3% | **40.3%** |

典型变化：`申|し|ます` → `申し|ます`；`担当|し|てい|ます` → `担当し|て|います`；`頼っている` → `頼って|いる`；`者|によって|ばらつき` 正确保留边界。

剩余局限（无词典分词的固有代价，已确认非本次引入）：`かって|います` 的 `か` 被判为终助词（同形冲突）、`どの|よう|な` 偏碎、`お|時間` 的接头辞 `お` 未并入。若这些影响实际学习体验，再考虑引入形态素分析器。

---

### T-2 【缺陷·中】[已修复] 提示词自相矛盾，叠加分词问题会抬高失败率

**证据**：`apps/api/src/providers/openai-compatible.ts:65` 与 `:71`（修复前）

```
第 65 行：tokens: an array of meaningful surface tokens
第 71 行：Return exactly one token analysis for each provided boundary
```

"meaningful tokens" 与 "each provided boundary" 冲突。当分词产出 `ご`/`ざ`/`い` 这类碎片时，模型很可能按 "meaningful" 跳过它们，返回数量不匹配 → `analysis-service.ts:36-40` 抛 `LLM returned N token analyses; expected M` → **整段计入失败**。

另外第 79 行 `The word JSON must be followed` 是病句，应为 `The JSON format must be followed`。

**建议**：删除 "meaningful"，改为 "Return analysis objects for ALL provided token boundaries, in the same order. Fragments without独立 meaning should be marked with null fields rather than omitted." 改完递增 `LLM_PROMPT_VERSION`。

**修复记录（2026-08-29）**：按建议改写，并补了三处：

- "meaningful surface tokens" → "one entry for every boundary listed under that segment's tokenBoundaries"，并追加一句说明「单字助词也要给解释，学习者就是冲着它来的；可以说它没什么特别，但不能省略」；
- 第 79 行病句 `The word JSON must be followed` → `Return raw JSON only: no Markdown fences, no prose before or after the JSON.`；
- `confidence` 明确要求 JSON 数字（见下方新增缺陷）。

`LLM_PROMPT_VERSION` 从 `analysis-v1` 递增到 `analysis-v3`（v2 = 消除矛盾 + 补 functional 说明，v3 = 补 confidence 数字约束）。

**端到端验证**：真实 DeepSeek 分析 6/6 segment 成功，模型返回的 token 序列与本地分词结果**逐条一致，0 差异**——说明「每条 boundary 必答」的约束真正生效了。

**修复过程中暴露的两个新缺陷**（均非原评审覆盖，已一并修复）：

1. **输出被 token 上限截断**：实测单 segment 需 6575 completion tokens，其中 **4863 是推理过程（占 74%）**；batch=3 需约 19725，而 `LLM_MAX_TOKENS` 只有 12000，第一批必然失败。改为按批量自适应上限：`max(配置值, 批量 × 10000)`，不超过 config 的 32000 上限；错误信息改为带上实际上限值与批量数。
2. **`confidence` 被输出成字符串**：`tokens.0.confidence: Expected number, received string` 会让整段 schema 校验失败。提示词明确要求数字，schema 侧新增 `confidenceSchema` 用 `z.preprocess` 还原数字字符串——**只还原 `"0.9"` 这类，不猜 `"high"` 的语义**，猜错比报错更危险。同时在 schema 不匹配时把原始返回写入调试日志，避免下次排查还要重跑请求。

---

## 三、需求与范围（1 个偏差）

### R-1 【偏差·中】验收字段未落到数据模型

`requirements.md` 第 243-261 行与第 318-324 行要求句子层包含这些字段，但与 `packages/core/src/domain.ts` 的 `segmentAnalysisSchema`（106-117 行）比对：

| 需求要求 | schema 是否含 | 说明 |
| --- | --- | --- |
| `translation` 自然中文译文 | 有 | |
| 直译 `literalTranslation` | **无** | 需求写明"用户主动请求时显示"，可按需生成 |
| 句子结构和关键语法 | 有（`grammarSummary`） | |
| `conversationFunctionTags` 会话功能标签 | **无** | roadmap 已排为后续，可接受 |
| 语气强度等级 `toneStrength` | **无** | roadmap 已排为后续，可接受 |
| **语气判断依据 `toneEvidence`** | **无** | ⚠️ 建议补，见下 |
| 总体礼貌等级 `politenessLevel` | 部分 | 存成了自由文本 `politeness`，非五档枚举 |
| 具体语体和敬语形式 `registerTags` | **无** | roadmap 已排为后续 |
| 省略/潜台词 `impliedMeaning` | 有 | |
| 对话接话理由 `replyReason` | 有 | |
| 不确定性 `uncertaintyNote` | 有 | |

**重点**：`toneEvidence`（语气判断依据）不是"锦上添花的标签"，而是 `requirements.md` 第八节验收样例第 392 行"解析能指出具体原文证据"的落地字段。当前只有 `tone` 一段自由文本，无法区分"结论"和"依据"。建议在 `segmentAnalysisSchema` 增加 `toneEvidence: string | null`，并在 prompt 中要求模型引用原文片段。

其余缺失项（标签类）属于 roadmap 明确排期的后续内容，**可以接受**，但建议在 `docs/requirements.md` 里标注"MVP 有意简化"，避免后续被误读为遗漏。

---

### R-2 【偏差·低】`politenessLevel` 未使用五档枚举

需求第 341 行定义"随意 / 普通 / 礼貌 / 尊敬 / 自谦"五档，但实现是自由文本 `politeness: z.string()`。后续做筛选或统计时无法归类。

**建议**：MVP 阶段可保留自由文本，但把枚举加入 schema 约束（`z.enum` + 允许额外说明字段），让模型输出可被程序消费。

---

## 四、UI 实现（2 个偏差）

### U-1 【偏差·高】[已修复] 线型语言缺失，颜色成为唯一分类依据

**证据**：`apps/web/src/styles.css:1087-1105`

```css
.annotation-word     { background: #f2eadf; border-bottom-color: #c5a579; }
.annotation-particle  { background: #e4f0ed; border-bottom-color: #70a89b; }
.annotation-adverb    { background: #ece7f5; border-bottom-color: #9a86bf; }
.annotation-grammar   { background: #f9e8d6; border-bottom-color: #d49b60; }
```

四个类别**都是 `border-bottom: 2px solid`**（见 `styles.css:1070`），只靠颜色区分。

而 `requirements.md` 第 71-77 行与设计原型 `docs/annotation-prototype.html:230-241` 都明确要求线型语言：

| 类别 | 要求的线型 | 当前实现 |
| --- | --- | --- |
| 普通词 | 单层下划线 | 单层实线 ✓ |
| 严格助词 | **双层**（`3px double`） | 单层实线 ✗ |
| 助动词/功能词 | **虚线**（`dashed`） | 类别不存在 ✗ |
| 副词 | 独立线色单层 | 单层实线（颜色不同） |
| 多词语法 | **单层波浪线** | 单层实线 ✗ |
| 语气/态度 | **双层波浪线** | 未实现（后续） |

**影响**：直接违反 `requirements.md` 第 376 行的可访问性红线——"颜色不能作为唯一分类依据；图例、线型、焦点样式和文字标签必须同步可用"。色觉障碍用户无法区分类别，黑白打印/截图同样失效。

**建议**：照搬原型已有的 CSS（`.token.particle { border-bottom: 3px double }`、`.token.functional { border-bottom: 2px dashed }`），成本极低。前提是先把 T-1 的 `functional` 类别补进数据模型。

#### 修复记录（2026-08-29 晚）

前置条件已由 T-1 解决：`tokenCategorySchema` 现在含 `functional`，端到端回归中模型已实际产出该类别。线型语言按**需求原文**落地，不照搬原型：

| 类别 | 修复前 | 修复后 | 依据 |
| --- | --- | --- | --- |
| word | `2px solid` | `2px solid` | 需求第 72 行 |
| particle | `2px solid` | **`3px double`** | 需求第 73 行 |
| functional | 类别不存在 | **`2px dashed`** | 需求第 74 行 |
| adverb | `2px solid` | `2px solid`（线色独立） | 需求第 74 行 |
| grammar | `2px solid` | **`underline wavy`** | 需求第 75 行 |

具体改动（`apps/web/src/styles.css`）：

1. 五类显式声明 `border-bottom-style`，不再依赖基类的 `solid`；
2. `grammar` 的波浪无法用 `border` 表达，改用 `text-decoration: underline wavy var(--grammar-line) 1px`，并把基类边框宽度归零、补 `padding-bottom: 3px`，避免两条线叠在一起；
3. 图例色块 `.annotation-swatch` 改为 `inline-flex` + `::before` 占位字符，让它复用**与正文完全相同的**线型声明——图例和正文共用一套视觉语言，不会各说各话；
4. `functional` 相关规则从文件末尾的"待生效"注释块移入主序列（该块里 `.annotation-swatch.annotation-functional` 用了 `fill` 而非 `fill-hover`，与其余四类不一致，已一并纠正）。

**顺带发现并修复的令牌缺口**：`--adverb-fill-hover` / `--grammar-fill-hover` 在 `paper`、`night` 两个主题下**根本没有定义**，而 `--functional-fill-hover` / `--functional-text` 在**六个主题下全部缺失**。CSS 变量未定义时 `background: var(--x)` 会降级为初始值，也就是说这些类别的悬停底色和图例色块此前是**透明的**。本轮按各主题既有色系补齐，共新增 16 个令牌：

| 主题 | 补齐的令牌 |
| --- | --- |
| paper | `adverb-fill-hover` `grammar-fill-hover` `functional-fill-hover` `functional-text` |
| night | 同上 4 个（沿用各自半透明取值） |
| minimal / magazine / workbench / notebook | `functional-fill-hover` `functional-text` |

**未采用评审建议的一处**：评审说"副词 = 点线"是我在设计稿里的发散，但 `requirements.md` 第 74 行写的是"**独立线色的单层下划线**：副词"。需求是契约，因此改回实线、靠独立线色区分。由此带来的残留问题已写进 `theme-system.md` 已知边界：`adverb` 与 `word` 都是单层实线，色觉障碍用户仍要靠图例和解析卡片里的文字标签区分；若认为不可接受，应先修订需求再改 CSS，而不是前端单方面发明线型。

**验证**：`pnpm typecheck` 通过（CSS 改动无类型影响）；线型与令牌变更需人工在浏览器切换六个主题目测确认，尚未做（低优先级）。

---

### U-2 【偏差·中】移动端学习库是堆叠，不是抽屉

**证据**：`apps/web/src/styles.css:834-848`

```css
@media (max-width: 860px) {
  .workspace { grid-template-columns: 1fr; }
  .library-panel { order: 2; }
}
```

`requirements.md` 第 102 行要求"手机端改为**覆盖主内容的抽屉**"，当前实现是把学习库排到正文下方（堆叠），展开时会把阅读器推下去。

**建议**：窄屏下改为 `position: absolute` + 覆盖层，保留折叠态图标轨道入口。这个改动与后续"移动端底部抽屉承载解析卡片"是同一套机制，可以一起做。

---

### U-3 【技术债·中】`App.tsx` 1444 行，单一组件承载全部状态

组件内同时管理 21 个 `useState`（含文档列表、选中文档、进度轮询、学习库筛选、编辑草稿等），`renderArticle` / `renderSegmentContent` 这些纯函数也内联其中。

**影响**：后续加入范围标注（需要 `selectedSourceRange` + `interactionStage` 四层循环状态）会让这个文件迅速失控。

**建议**：按职责拆分为 —— `ReaderCanvas`（原文渲染）/ `LibraryPanel`（学习库）/ `SegmentAnalysisPanel`（句段解析）/ `TokenPopover`（词语卡片）/ `ComposerCard`（录入表单），并用 `useDocumentAnalysis` 之类的自定义 hook 收拢分析进度轮询逻辑。拆分后再引入状态机管理点击层级。

---

## 五、设计系统（1 项需整改）

### D-1 【需整改·中】136 处硬编码颜色，0 个设计 Token

**证据**：`apps/web/src/styles.css`，全文扫描 `#[0-9a-fA-F]{3,8}` 命中 **136 处**，`--*` CSS 变量 **0 个**。

**但这里有个好消息**：`docs/annotation-prototype.html:8-27` **已经定义好了一整套 Token**：

```css
:root {
  --ink: #3e342b;          --muted: #76695d;
  --paper: #fffaf3;        --panel: #fffdf9;
  --line: #e6d9c9;
  --sentence-fill: rgba(226, 237, 247, 0.82);
  --word-fill: #f2eadf;    --particle-fill: #e3f0ec;
  --functional-fill: #f6e4e9;   --adverb-fill: #ece7f5;
  --word-line: #bd955d;    --particle-line: #559587;
  --functional-line: #b46c84;   --adverb-line: #8e79bd;
  --grammar-line: #cb8d4e; --tone-line: #b55f7d;
}
```

生产样式与这套接色基本一致（说明设计意图是连贯的），只是**没有走变量**。

**建议**：
1. 把原型的 `:root` 变量块搬进 `styles.css` 顶部，补全生产代码用到但原型缺的 token（面板、按钮、状态色）；
2. 全局替换 136 处 hex 为 `var(--*)`；
3. 顺带解锁能力：深色模式（`prefers-color-scheme`）、用户切换预设主题——`requirements.md` 第 78 行本就要求"用户后续可以切换预设主题或调整颜色"。

**这是本清单中投入产出比最高的一项**：几乎零设计决策成本，一次性解决 Token 化、主题扩展能力和可访问性基础。

---

### D-2 【技术债·低】缺少可访问性与动效约束

- 全文无 `prefers-reduced-motion`（标注层有多处 `transition`）；
- `.annotation-token` 是 `<button>`，但焦点样式只定义在 `.annotation-segment:focus-visible`（`styles.css:1053`），**token 按钮没有可见焦点环**——键盘用户无法定位当前词；
- 无 `prefers-color-scheme`（配合 D-1 一起做）。

---

## 六、建议的修复顺序

| 优先级 | 事项 | 类型 | 理由 |
| --- | --- | --- | --- |
| **P0** | 装依赖跑通 `pnpm dev` + `typecheck` | 验证 | 代码尚未在本机运行过 |
| **P0** | A-2 说话人正则误吞 URL | 缺陷 | 静默损坏原文，新闻类材料必踩 |
| **P0** | A-1 数据库全量同步落盘 | 缺陷 | 长文分析性能会持续劣化 |
| **P1** | T-1 分词碎片合并后处理 | 缺陷 | 直接降低成本与失败率，单文件改动 |
| **P1** | T-2 修正 prompt 矛盾表述 | 缺陷 | 与 T-1 叠加抬高失败率 |
| **P1** | D-1 样式 Token 化（复用原型变量） | 整改 | 投入产出比最高，顺带解锁主题能力 |
| **P1** | U-1 补齐线型语言 + `functional` 类别 | 偏差 | 违反需求可访问性红线 |
| **P2** | R-1 补 `toneEvidence` 字段 | 偏差 | 支撑"指出原文证据"的验收要求 |
| **P2** | 引入 vitest，覆盖分句偏移与 token 校验 | 基建 | 这两处最容易静默出错 |
| **P2** | U-3 拆分 `App.tsx` | 技术债 | 为范围标注铺路 |
| **P3** | U-2 移动端抽屉、D-2 无障碍细节 | 增强 | 不阻塞 MVP |

---

## 七、总体判断

**架构判断是对的，问题出在验证与落地细节上。**

值得肯定的部分：稳定 ID + UTF-16 偏移的定位模型、provider 与协议隔离、前后端共用 Zod 契约、取消/重试/断点恢复的状态机、人工修正不覆盖 AI 原版的 revision 设计——这些决策都经得起推敲，不是"看起来能跑"的糊弄。

真正需要动手的三件事：

1. **两个会静默出错的缺陷**（说话人正则、全量落盘）——它们不会产生报错，只会悄悄产生错误数据和性能劣化；
2. **分词粒度**——它同时放大成本、延迟和失败率，是"完整回归做不下去"的潜在根因；
3. **样式 Token 化**——原型已经把答案写好了，生产代码只是没抄。

做完这三件，再进入 roadmap 的完整范围标注阶段，会顺畅得多。
