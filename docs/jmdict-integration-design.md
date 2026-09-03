# 内容词词典层设计（可插拔数据源）

> 状态：**接口层已实施，数据源待定**（2026-09-03 修订）
> 决策（用户拍板）：**先做标准化接口，具体字典数据等后续寻找资源**。
> 因此本设计的核心是「与数据源解耦的词典层契约」，已调研的数据源只作为
> 待实现的适配器登记在案，不绑定到主链路。
> 全部结论基于本地实测，零云端调用。

---

## 一、为什么需要这一层：实测依据

固定用法库两轮扩充后覆盖率 39.7% → 47.8%，剩余 477 token 中内容词占大头。
用 `jmdict-eng-common`（JMdict 常用词子集，50,687 词条键）对当前语料实测：

| 指标 | 实测值 |
| --- | --- |
| 内容词规模 | 112 surface / 329 token（占语料 36.0%） |
| surface 直接命中 | **285 token（86.6%）** |
| kuromoji 原形回退命中 | 9 token（2.7%） |
| 未命中 | 35 token（10.6%） |
| **可词典化合计** | **294 token → 覆盖率 +32.2 pp（47.8% → 约 80.0%）** |
| 未命中构成 | 人名（田中6/李5）、外来语（IT/テンプレート）、分词残片单字（化/社/層） |

**结论**：内容词值得做，且收益远超手工补条目（手工 top 114 条天花板 +38.7 pp 但属自评过拟合）。
同时也说明——**覆盖率瓶颈不在"有没有词典"，而在"用什么词典 + 什么语言"**。

---

## 二、设计目标：数据源解耦

用户阅读场景是「什么都读」，且中文资源尚未确定。因此本层的设计约束是：

1. **主链路不依赖任何具体数据源**——没有数据文件时，行为与接入前完全一致；
2. **新增数据源 = 新增一个适配器**，不改 `segment-preparation` / 分析服务 / 前端；
3. **释义语言可插拔**——英文直出、本地译中、人工修正可并存，按可用性择优；
4. **降级必须静默安全**——数据源缺失/加载失败/Ollama 未启动，都不阻断分析。

---

## 三、接口契约

```ts
// apps/api/src/dictionary/content/types.ts

/** 一条释义（可能多语言并存） */
export interface ContentGloss {
  /** BCP 47 语言标记：en / zh / ja */
  lang: string;
  text: string;
}

/** 词典层返回的内容词条目 */
export interface ContentWordEntry {
  surface: string;              // 命中的词形
  reading: string | null;       // 读音
  partsOfSpeech: string[];      // 词性（各源格式不同，统一为字符串数组）
  glosses: ContentGloss[];      // 至少一条
  source: string;               // 来源标识，UI 显示徽标用（如 "jmdict"）
  /** 命中方式：surface 直击 / lemma 回退 */
  matchedBy: "surface" | "lemma";
}

export interface ContentDictionaryStats {
  entries: number;
  loaded: boolean;
  version: string | null;
  license: string | null;
}

/**
 * 内容词词典层契约。
 *
 * 实现必须满足：
 * - lookup 未命中返回 null（绝不编造释义，与固定用法库同律）；
 * - 幂等：initialize 可重复调用；
 * - 线程/并发安全：只读查询，无共享可变状态；
 * - 失败降级：initialize 抛错时由工厂回落到空实现，不阻断分析。
 */
export interface ContentDictionaryProvider {
  readonly id: string;          // "jmdict-common" / "none" / 自定义
  readonly label: string;       // 设置页展示名
  ready(): boolean;
  initialize(): Promise<void>;
  lookup(query: { surface: string; lemma?: string | null }): ContentWordEntry | null;
  stats(): ContentDictionaryStats;
}
```

### 3.1 内置实现

| 实现 | id | 用途 |
| --- | --- | --- |
| `NullContentDictionary` | `none` | **默认**。始终返回 null，`ready()` 恒 false。未配置数据源时使用，保证行为与接入前一致 |
| `FixtureContentDictionary` | `fixture` | 内置十余条样例词，**仅供 verify 断言接口链路**，不参与生产 |

未来新增数据源只需实现接口并在工厂注册（见 3.3）。

### 3.2 查询流程（两级匹配）

```
token surface
   │
   ├─① 固定用法库（人工、中文、含教学解释）—— 优先级最高
   │
   ├─② kuromoji 形态素事实字段（lemma/reading/pos/conjugation）
   │
   ├─③ 内容词词典层：provider.lookup({ surface, lemma })
   │      ├─ surface 直击 → 命中
   │      └─ lemma 回退 → 命中
   │
   └─④ 其余交 LLM
```

- **① 与 ③ 严格分层**：固定用法库继续只放「日语语言知识」（助词/功能词/寒暄），
  内容词一律走 ③。固定库永不被词汇表污染——这对「什么都读」的场景尤其重要。
- 复用 `morphology.ts` 已有的 `lemma`，**不新增形态素分析**。
- 分词残片（化/社/層）两级都查不到 → 自然落到 ④，与现状一致。

### 3.3 工厂与配置

```ts
createContentDictionary(config?: { id?: string; indexPath?: string }): ContentDictionaryProvider
```

- 未配置或加载失败 → 回落 `NullContentDictionary`（静默，仅日志）；
- 配置读取顺序：`app_settings` 的 `contentDictionary` 键 → 环境变量 `CONTENT_DICT_ID`
  → 默认 `none`（沿用现有「db 覆盖 .env」的约定）。

---

## 四、数据源适配器登记（待实现 / 待用户补充资源）

> 以下均已调研，实现任一只需「写适配器 + 在工厂注册」，主链路零改动。

| 数据源 | 体积 | 词条 | 覆盖/特点 | 许可 | 状态 |
| --- | --- | --- | --- | --- | --- |
| **jmdict-eng-common** | zip 1.37 MB / JSON 16.5 MB | 50,687 键 | 实测覆盖 86.6%，英文释义 | CC BY-SA 3.0（EDRDG，需署名） | 待实现 |
| jmdict-eng（全量） | zip 11 MB / JSON ~100 MB | ~21 万 | 补生僻词/部分外来语，增量小 | 同上 | 待定 |
| JMnedict（专名） | 单独发布 | 74 万 | 补人名（收益仅 11 token） | 同上 | 倾向不做 |
| **中文维基词典** via kaikki.org | gz **214 MB** / 1.8 GB | 未知 | 唯一开源**日→中**来源；**未按语言拆分**，需流式过滤；官方标注提取仍在完善 | CC BY-SA | 待用户评估 |
| Yomitan 生态中日大辞典 / 白水社 | — | — | 方向为**中→日**（与需求相反）；系商业词典抓取版，**版权灰色** | 不干净 | 排除 |
| 用户自选资源 | — | — | 用户表示后续自行寻找 | 视资源而定 | **当前主路径** |

### ⚠️ 中文问题（核心待决）

JMdict 官方多语含 英/德/俄/匈/荷/西/法/瑞典/斯洛文尼亚语，**确无中文**（JMdictDB
语言表与 jmdict-simplified 版本列表互相印证）。中文策略可插拔：

| 策略 | 说明 | 代价 |
| --- | --- | --- |
| 英文直出 | 直接显示数据源释义 | 零 |
| 按需本地译中 | 词首次出现时用本地 Ollama 译中，写入 `vocabulary_cache` 永久复用 | 零 API 费用（需 LLM-011 批准） |
| 汉字词不译 | 同形汉字词（時間/営業/部門）中文母语者可直接理解，只译和语词与陷阱词（手紙/大丈夫） | 大幅减少译词量 |
| 人工修正优先 | `translated_by='user'` 的条目不被自动覆盖 | — |

---

## 五、数据模型（译词缓存，按需启用）

```sql
CREATE TABLE vocabulary_cache (
  surface       TEXT PRIMARY KEY,
  gloss_zh      TEXT,
  gloss_en      TEXT,
  pos           TEXT,
  source        TEXT NOT NULL,
  translated_by TEXT,              -- 模型名 或 'user'
  created_at    TEXT NOT NULL
);
```

本次**不建表**（等译中功能启用时随迁移脚本一起加）。

---

## 六、本次实施范围（接口层）

**做**：

1. `dictionary/content/types.ts` —— 上述契约与类型
2. `dictionary/content/null-provider.ts` —— 默认空实现
3. `dictionary/content/fixture-provider.ts` —— 测试用样例实现
4. `dictionary/content/index.ts` —— 工厂 + 回落逻辑
5. `segment-preparation.ts` —— 支持可选第四层参数（**不传则行为完全不变**）
6. `verify-pipeline.ts` —— 接口契约与降级行为断言

**不做**（等数据源确定后）：

- 任何真实数据源的下载/索引构建脚本
- `vocabulary_cache` 表与译中链路
- 设置页 UI、前端徽标
- 覆盖率提升（未接数据源前指标不变）

---

## 七、验收标准（EARS 格式）

| 编号 | 功能 | 验收标准 | 优先级 |
| --- | --- | --- | --- |
| AC-01 | 默认不生效 | While 未配置数据源，系统**必须**使用 `none` 实现，分析结果与接入前完全一致 | P0 |
| AC-02 | 未命中不编造 | If 词典层未命中，系统**必须**返回 null 并回落 LLM，不得生成释义 | P0 |
| AC-03 | 固定库优先 | When 固定用法库与词典层同时命中，系统**必须**优先固定用法库 | P0 |
| AC-04 | 原形回退 | If surface 未命中但 lemma 命中，系统**必须**使用 lemma 结果并标记 `matchedBy='lemma'` | P0 |
| AC-05 | 加载失败降级 | If 数据源初始化抛错，系统**必须**回落空实现且不阻断分析 | P0 |
| AC-06 | 零费用 | While 未启用译中，系统**必须不**发起任何 LLM 请求（含本地模型） | P0 |
| AC-07 | 可扩展性 | 新增数据源**必须**只需实现接口 + 工厂注册，不改主链路 | P1 |
| AC-08 | 回归 | 本次改动后 `verify-pipeline` **必须**全数通过，覆盖率指标**必须**保持 47.8% 不变 | P0 |

---

## 八、未决项

| 项 | 现状 | 待定 |
| --- | --- | --- |
| 具体数据源 | 接口就绪，无绑定 | **用户自行寻找中文资源** |
| 中文释义策略 | 可插拔，四策略并存 | 等数据源确定后选 |
| 是否上 JMnedict 补人名 | 收益仅 11 token | 倾向不做 |
| 是否上全量版补外来语 | 增量小、体积 10 倍 | 倾向不做 |
| 数据文件是否入库 | 体积与许可衍生考量 | 倾向不入库（放 gitignore 的 `data/`） |

> 涉及本地 LLM 的译词属 LLM-011 管辖，需明确批准后才会执行。
