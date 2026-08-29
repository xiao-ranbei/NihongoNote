# 主题系统与设计 Token

**状态**：Token 化已完成，主题切换 UI 待接入
**日期**：2026-08-29
**关联**：[优化评审清单](optimization-review.md) D-1 / [UI 设计提案](ui-design-proposals.html) / [标注视觉原型](annotation-prototype.html)

---

## 一、结论

`apps/web/src/styles.css` 已完成 Token 化：

- 组件规则区（约 1000 行）**零硬编码颜色**，全部通过 `var(--*)` 引用；
- 文件头部定义了 **72 个语义 Token** 与 **6 套完整主题**；
- 六套主题对应 6 个设计提案，通过 `data-theme` 属性一键切换，全部保留。

## 二、六套主题

| 主题名 | data-theme 值 | 来源提案 | 气质 |
| --- | --- | --- | --- |
| 紙・白（默认） | `paper`（或缺省） | 提案 A | 米白纸感，现役基线 |
| 夜读 | `night` | 提案 B | 墨韵深色 + 暖金，夜间护眼 |
| 编辑部 | `minimal` | 提案 C | 黑白极简，标注只靠线型 |
| 雑誌 | `magazine` | 提案 D | 米黄印刷色 + 深红，杂志感 |
| 工作台 | `workbench` | 提案 E | 浅灰高密度，青绿强调 |
| 手帳 | `notebook` | 提案 F | 奶油底 + 荧光笔标注 |

**预览方式**（切换 UI 接入前）：在浏览器 DevTools Console 执行：

```js
document.documentElement.dataset.theme = "night";   // 换成任意主题名
```

**正式接入**（低优先级，待办）：`App.tsx` 增加一个主题下拉，把选择写入 `localStorage` 并设置 `data-theme`，预计 20 行以内。参考实现：

```tsx
const [theme, setTheme] = useState(() => localStorage.getItem("nn-theme") ?? "paper");
useEffect(() => {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("nn-theme", theme);
}, [theme]);
```

## 三、Token 分组

| 分组 | Token（部分） | 说明 |
| --- | --- | --- |
| 字体 | `--font-ui` / `--font-display` / `--font-jp` | UI 无衬线 / 标题衬线 / 日文明朝体 |
| 基础面 | `--paper` `--panel` `--panel-soft` `--hover` `--shadow-card` | 页面底、面板底、悬停底 |
| 墨色 | `--ink-strong` `--ink` `--ink-soft` `--text-label` `--muted` `--muted-soft` | 文字层级（深→浅） |
| 强调 | `--accent` `--accent-deep` `--accent-bright` `--accent-muted` `--on-ink` | 棕金强调与按钮文字 |
| 边框 | `--line-faint` → `--line-strong` + `--line-accent(-hover)` | 深浅分级 |
| 装饰块 | `--tint-neutral` `--tint-accent` `--tint-badge` `--tint-warn` 等 | badge、标签、提示底色 |
| 状态 | `--status-ok(-bg)` `--status-run(-bg)` `--status-fail(-bg/-border)` | 完成 / 处理中 / 失败 |
| 阅读标注 | `--sentence-fill(-hover)` `--segment-active-fill` `--token-ring` | 句子底色与选中反馈 |
| 词类标注 | `--word/particle/functional/adverb/grammar-fill(-hover)/-line/-text` | 五类词语的底色 + 线色 + 文字色 |

**线型语言与 Token 无关**（实线/双线/虚线/波浪定义在 `border-bottom` / `text-decoration` 规则里），因此所有主题都自动继承线型分类——颜色只是第二编码。

当前线型映射（`apps/web/src/styles.css`，对照 `requirements.md` 第 71-77 行）：

| 类别 | 线型 | 实现方式 |
| --- | --- | --- |
| 普通词 word | 单层实线 | `border-bottom: 2px solid` |
| 严格助词 particle | 双层 | `border-bottom: 3px double` |
| 助动词/功能词 functional | 虚线 | `border-bottom: 2px dashed` |
| 副词 adverb | 独立线色的单层实线 | `border-bottom: 2px solid`（线色独立，不加新线型） |
| 跨词语法 grammar | 单层波浪 | `text-decoration: underline wavy`（`border` 无法表达波浪，故让出边框位） |
| 语气/态度/隐含意义 | 双层波浪 | 未实现，属范围层 `AnnotationRange` |

图例色块 `.annotation-swatch` 复用与正文完全相同的线型声明，不另立一套视觉语言。

## 四、约定（新增样式必须遵守）

1. **组件规则里禁止出现 hex / rgba 颜色字面量**，只能 `var(--*)`；
2. 新颜色需求先问"属于哪个语义组"，没有合适的就先在该主题块中新增 Token 再引用；
3. 修改主题只改文件头部的主题定义块，不碰组件规则区；
4. 新增主题 = 复制一份 `:root` 块改值 + 换 `data-theme` 名称，不改动任何组件规则。

## 五、已知边界

- **六主题当前只统一"配色层"**。提案 D（杂志双栏）和 E（三栏工作台）的**布局**差异未实现——布局切换属于结构层，实现规范见下一节，按既定分层策略推迟到范围标注功能稳定之后再评估。
- `functional` 类别已贯通（`tokenCategorySchema` + `.annotation-functional` 虚线 + 六主题 Token 齐全），端到端回归中已出现实际分类结果；主题层无需再改动。
- `adverb` 与 `word` 同为单层实线，靠**独立线色 + 文字标签**区分（需求第 74 行即此约定）。若后续认为色觉障碍下二者仍难辨，应在需求层先修订线型映射，再改 CSS，不要由前端单独发明点线等新线型。
- 非 `paper` 主题的推导色基于提案稿延伸，实际运行后可能需要按对比度微调——特别是 `night` 下的 `--tint-*` 半透明值。
- 深色主题未包含 `prefers-color-scheme` 自动跟随，切换入口落地时一并考虑。

---

## 六、结构层（布局骨架）维护说明

> 结构层与主题层**正交**：主题管"长相"（颜色/字体/装饰），结构层管"骨架"（栅格、栏位、位置、断点）。当前骨架锁定为提案 A 的单布局；本文节记录接缝位置与未来扩展规范，供后期追加维护。

### 6.1 当前骨架（提案 A 布局）

| 接缝类名 | 作用 | 关键属性 |
| --- | --- | --- |
| `.app-shell` | 页面底 + 顶栏排版 | radial 装饰（走 `--paper-glow`） |
| `.workspace` | 主网格：学习库 ↔ 内容 | `grid-template-columns: minmax(220px, .7fr) minmax(0, 2fr)` |
| `.workspace.library-collapsed` | 学习库折叠后的单栏态 | `grid-template-columns: minmax(0, 1fr)` |
| `.library-panel` | 学习库面板（`align-self: start`） | 移动端 `order: 2` 堆叠 |
| `.reader-layout` | 阅读区双栏：文章列 + 解析面板 | `minmax(0, 1.45fr) / minmax(260px, .75fr)` |
| `.analysis-panel`（第二条定义） | 解析面板 sticky 跟随 | `position: sticky; top: 20px` |
| `.article-toolbar` / `.annotation-legend` | 图例与标注工具条位置 | flex，700px 下转纵向 |
| `@media 860 / 520 / 1000 / 700` | 四个响应式断点 | 见 styles.css 对应区块 |

代码中这些规则已用 `/* [layout] … */` 注释标记，检索 `[layout]` 即可定位全部骨架规则。

### 6.2 未来扩展规范：`data-layout`

布局变体建议使用与 `data-theme` 正交的第二个属性，二者可自由组合（6 主题 × N 布局）：

```html
<html data-theme="night" data-layout="reader">
```

| data-layout 值 | 对应提案 | 布局差异 |
| --- | --- | --- |
| `reader`（默认/缺省） | A | 现行：侧库 + 文章/解析双栏 |
| `magazine` | D | 正文 + 固定注释栏（解析变"注"），报头式页眉 |
| `workbench` | E | 三栏（库 / 阅读 / 解析+统计卡），顶栏工具化 |
| `minimal` / `notebook` | C / F | 布局与 `reader` 基本一致，用主题即可近似，暂不需要独立布局 |

实现纪律——**布局变体只写差异规则**，不复制默认布局：

```css
/* 示例：magazine 布局的差异部分 */
[data-layout="magazine"] .reader-layout {
  grid-template-columns: minmax(0, 1fr) 292px;
}
[data-layout="magazine"] .analysis-panel {
  border-right: 1px solid var(--line);
  position: static;
}
```

### 6.3 组件接口预留（为范围标注与四层点击）

进入"P1 后续增强"前，结构层需要保住三个接缝：

1. **解析卡落点**：已有 `.token-popover`（词卡）与 `.analysis-panel`（句卡）两个容器，四层循环点击的卡片应复用同一容器体系，不另起炉灶；
2. **点击层级状态位**：拆分 `App.tsx` 时在阅读器组件加入 `selectedSourceRange` 与 `interactionStage`（句子结构 → 词语 → 语法 → 语气），布局变体不感知该状态；
3. **图例扩展位**：`.annotation-legend` 已按类别数组渲染，`functional` 类别落地后自动获得图例项，布局无需改动。

### 6.4 维护纪律

1. **布局与视觉分离书写**：布局规则（`display/grid/flex/order/position`）与视觉规则（颜色/字体/圆角/阴影）不混在一条声明里堆叠，颜色一律走 Token；
2. **布局尺寸不进主题块**：列宽、断点、间距骨架属于结构层，主题块只定义颜色与字体——保证 6 主题 × N 布局自由组合；
3. **响应式断点统一收敛**：新增断点前先复用 860/520/1000/700，避免碎片化；
4. **移动端学习库待改造**：当前是 `order: 2` 堆叠，需求要求"覆盖主内容的抽屉"（optimization-review U-2），改造时动 `.library-panel` 的接缝规则即可，不影响主题；
5. **拆分文件的时机与顺序**：单文件超过 2500 行或引入布局变体时，拆为 `tokens.css`（主题块）/ `layout.css`（`[layout]` 标记规则 + media queries）/ `components.css`（其余），拆分前后类名与选择器保持不变。
