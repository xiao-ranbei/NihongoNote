import type { DictionaryEntry, SentenceEndingTemplate } from "./types.js";

/**
 * 固定用法库初始表（设计文档 3.3）。
 *
 * 覆盖三类：
 * 1. 助词（particle）—— 实测 TOP（の/を/が/て/と/に/か/ね/は…）全部在内，45 条；
 * 2. 功能词（functional）—— 助动词/补助动词/接续表达，33 条；
 * 3. 句末语气模板 —— 16 条，供简单句的词典化兜底。
 *
 * 约束（verify-pipeline 会断言）：
 * - surface 在同类内不得重复；
 * - explanation 必须非空；
 * - 数量不得低于设计下限（particle ≥ 40、functional ≥ 30）。
 */

export const particleEntries: DictionaryEntry[] = [
  // ── 格助词 ────────────────────────────────────────────────
  {
    surface: "が", category: "particle", reading: null, gloss: "（主格）",
    explanation: "主格助词，提示主语。表示动作/状态的主体。例：雨が降る（下雨）。疑问句中用が提示未知主体：誰が来ますか（谁来？）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "の", category: "particle", reading: null, gloss: "的",
    explanation: "①连体修饰，表所属/属性：私の本（我的书）。②准体助词，名词化：赤いのが好き（喜欢红色的）。③终助词，口语疑问（升调）：行くの？（去吗？）",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "を", category: "particle", reading: null, gloss: "（宾格）",
    explanation: "宾格助词，提示动作的直接对象：本を読む（读书）。也可表示经过/离开的场所：道を歩く（沿路走）、家を出る（出门）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "に", category: "particle", reading: null, gloss: "（方向/时间/对象）",
    explanation: "用法最广的助词：①时间点：7時に起きる（7点起床）。②方向/目的地：学校に行く（去学校）。③对象：田中さんに聞く（问田中）。④存在场所：机の上にある（在桌上）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "へ", category: "particle", reading: null, gloss: "（方向）",
    explanation: "方向助词，提示移动的方向/目的地，与に相近但更强调「朝向」：東京へ行く（去东京）。常出现在书信/正式表达中。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "と", category: "particle", reading: null, gloss: "和；与…一起",
    explanation: "①共动/对象：友達と話す（和朋友说话）。②并列列举（完全列举）：本とノート（书和笔记本）。③引用内容：「行く」と言った（说了要去）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "から", category: "particle", reading: null, gloss: "从；因为",
    explanation: "①起点/来源：9時から始まる（从9点开始）。②原因理由（主观判断，句末常接でしょう/と思います）：雨だから行かない（因为下雨不去）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "まで", category: "particle", reading: null, gloss: "到…为止",
    explanation: "终点/范围界限：5時まで働く（工作到5点）。也表示极端举例：子供まで知っている（连小孩都知道）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "より", category: "particle", reading: null, gloss: "比；从",
    explanation: "①比较基准：これより安い（比这个便宜）。②书面语的起点（相当于から）：会議は10時より開始（会议10点开始）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "で", category: "particle", reading: null, gloss: "（方式/场所/原因）",
    explanation: "①手段/方式：電車で行く（坐电车去）、日本語で話す（用日语说）。②动作发生的场所：図書館で勉強する（在图书馆学习）。③原因：病気で休む（因病休息）。④范围：クラスで一番（班里第一）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "や", category: "particle", reading: null, gloss: "…啦…啦（列举）",
    explanation: "不完全列举，暗示还有其他：本やノートを買う（买了书啊本子之类的）。常与など连用：茶やコーヒーなど。",
    confidence: 1, origin: "fixed"
  },
  // ── 系助词 ────────────────────────────────────────────────
  {
    surface: "は", category: "particle", reading: null, gloss: "（主题）",
    explanation: "主题助词，提示话题（读作 wa，写作 ha）。对比/强调时也用它：私は学生です（我是学生）。表示对比：酒は飲まない（酒不喝）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "も", category: "particle", reading: null, gloss: "也",
    explanation: "①添加/同类：私も行く（我也去）。②全面否定（与否定呼应）：誰もいない（谁都不在）。③数量意外之多：100人も来た（竟来了100人）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "こそ", category: "particle", reading: null, gloss: "正是…才是…",
    explanation: "强烈强调/限定：これこそ本物だ（这才是真货）。用于回应期待：こちらこそ（哪里哪里/彼此彼此）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "さえ", category: "particle", reading: null, gloss: "连…都；只要…就",
    explanation: "①极端举例（连…都）：漢字さえ読めない（连汉字都不会读）。②条件（只要…就）：お金さえあれば（只要有钱）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "しか", category: "particle", reading: null, gloss: "只；仅",
    explanation: "限定（必须与否定呼应）：一人しかいない（只有一个人）。表「仅有这一点，别无其他」。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "でも", category: "particle", reading: null, gloss: "也；即使是",
    explanation: "①极端举例：子供でもわかる（连小孩都懂）。②随便提一个：お茶でも飲もう（喝杯茶什么的吧）。③话题引入：私はコーヒーでも（我要咖啡吧）。",
    confidence: 1, origin: "fixed"
  },
  // ── 副助词 ────────────────────────────────────────────────
  {
    surface: "だけ", category: "particle", reading: null, gloss: "只；仅",
    explanation: "限定范围，不带否定色彩：一人だけ来た（只来了一个人）。也可以表程度：できるだけ（尽量）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ばかり", category: "particle", reading: null, gloss: "净是；刚刚",
    explanation: "①单一事物反复/过多：漫画ばかり読む（净看漫画）。②刚刚完成：来たばかり（刚来）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ほど", category: "particle", reading: null, gloss: "…的程度；越…越",
    explanation: "①程度：涙が出るほど笑った（笑得眼泪都出来了）。②比较基准（～ほど～ない）：君ほど速くない（没你快）。③越…越：勉強するほど上手になる（越学越好）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "くらい", category: "particle", reading: null, gloss: "大约；程度",
    explanation: "①大致数量：10分くらいかかる（大约要10分钟）。②程度（轻视/极限）：これくらいならできる（这种程度的话会做）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ぐらい", category: "particle", reading: null, gloss: "大约；程度",
    explanation: "くらい的浊音形，用法相同：1時間ぐらい（大约1小时）。口语中更常用。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "など", category: "particle", reading: null, gloss: "等；之类",
    explanation: "①列举举例：果物など（水果之类）。②自谦/轻视（～なんて/など）：私などには無理（我这样的人做不到）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "とか", category: "particle", reading: null, gloss: "…啦…啦",
    explanation: "口语列举（非穷尽）：映画とか見たい（想看个电影什么的）。也可表传闻（听说…）：田中さんとか言う人（一个叫田中的人）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "なり", category: "particle", reading: null, gloss: "…也好…也好",
    explanation: "①二选一举例：電話なりメールなり（打电话也好发邮件也好）。②放任：するなり好きにしろ（做不做随你）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ずつ", category: "particle", reading: null, gloss: "每…；各…",
    explanation: "等量分配：一人に二つずつ（每人两个）、少しずつ進む（一点点进步）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "きり", category: "particle", reading: null, gloss: "只；自从…就",
    explanation: "①限定（只）：二人きり（只有两个人）。②一旦…就不再（与否定呼应）：会ってからきり会っていない（自那次见面后再没见过）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "のみ", category: "particle", reading: null, gloss: "仅；只",
    explanation: "书面语限定（=だけ）：会員のみ入場可（仅会员可入场）。",
    confidence: 1, origin: "fixed"
  },
  // ── 接续助词 ──────────────────────────────────────────────
  {
    surface: "て", category: "particle", reading: null, gloss: "（接续）…然后",
    explanation: "接续助词，连接动词/形容词：①顺序：起きて顔を洗う（起床洗脸）。②原因：雨が降って試合中止（下雨所以比赛取消）。③状态（～ている/～ておく/～てしまう）：本を読んでいる（正在看书）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ば", category: "particle", reading: null, gloss: "如果…就",
    explanation: "条件助词（假定）：雨が降れば中止だ（如果下雨就取消）。与よ/いい搭配表愿望：早く来ればよかった（早点来就好了）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ながら", category: "particle", reading: null, gloss: "一边…一边；虽然",
    explanation: "①同时进行：音楽を聞きながら勉強する（边听音乐边学习）。②逆接（虽然…却）：知っていながら言わない（明明知道却不说）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ので", category: "particle", reading: null, gloss: "因为（客观）",
    explanation: "原因（客观事实，礼貌语气），与から相比更委婉正式：風邪なので休みます（因为感冒请假）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "のに", category: "particle", reading: null, gloss: "明明…却",
    explanation: "逆接（事实与预期不符，含不满/遗憾）：勉強したのに落ちた（明明学了却落榜）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "たら", category: "particle", reading: null, gloss: "如果…就；…之后",
    explanation: "条件（过去假定，口语）：時間があったら行く（有空就去）。发现：窓を開けたら雪が降っていた（开窗一看下雪了）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "たり", category: "particle", reading: null, gloss: "又…又…（列举）",
    explanation: "动作/状态列举（不完全，常与する连用）：飲んだり食べたりする（又喝又吃）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ても", category: "particle", reading: null, gloss: "即使…也",
    explanation: "让步：雨が降っても行く（即使下雨也去）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "とも", category: "particle", reading: null, gloss: "都；即使",
    explanation: "①全部（数量词后）：二人とも行く（两人都去）。②让步（～ても的书面/强调形）：反対されようとも（即使被反对）。",
    confidence: 1, origin: "fixed"
  },
  // ── 终助词 ────────────────────────────────────────────────
  {
    surface: "か", category: "particle", reading: null, gloss: "（疑问）",
    explanation: "①疑问：行きますか（去吗？）。②自问/不确定：どうしようか（怎么办好呢）。③选择（～か～か）：行くか行かないか。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ね", category: "particle", reading: null, gloss: "（确认/感叹）",
    explanation: "①征求同意：いい天気ですね（天气真好啊）。②感叹：きれいだね（真漂亮啊）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "よ", category: "particle", reading: null, gloss: "（提醒/告知）",
    explanation: "告知对方未知信息/提醒：ここで待ってますよ（我在这儿等哦）。语气偏肯定、略带强调。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "な", category: "particle", reading: null, gloss: "（禁止/感叹）",
    explanation: "①禁止（动词原形后）：行くな！（别去！）②感叹（口语，促音变なあ）：きれいだなあ（好美啊）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "わ", category: "particle", reading: null, gloss: "（柔和感叹）",
    explanation: "终助词（多用于女性/关西方言，柔和确认）：これでいいわ（这个就行）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ぜ", category: "particle", reading: null, gloss: "（强调，男性）",
    explanation: "终助词（男性口语，强硬强调）：行くぜ！（走了啊！）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ぞ", category: "particle", reading: null, gloss: "（强调，男性）",
    explanation: "终助词（男性口语，坚定宣告）：負けないぞ！（我不会输的！）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "し", category: "particle", reading: null, gloss: "又…又…；而且",
    explanation: "接续助词，列举理由（并列原因）：安いし美味しい（又便宜又好吃）。",
    confidence: 1, origin: "fixed"
  }
];

export const functionalEntries: DictionaryEntry[] = [
  {
    surface: "ます", category: "functional", reading: null, gloss: "（动词丁宁形）",
    explanation: "动词的丁宁形（礼貌体）词尾：行きます（去）。表示对听话人的礼貌。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "です", category: "functional", reading: null, gloss: "（丁宁断定）",
    explanation: "名词句/形容动词句的丁宁断定词尾：私は学生です（我是学生）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ました", category: "functional", reading: null, gloss: "（ます过去）",
    explanation: "丁宁体过去：行きました（去了）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "でした", category: "functional", reading: null, gloss: "（です过去）",
    explanation: "丁宁断定过去：昨日は休みでした（昨天休息）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ません", category: "functional", reading: null, gloss: "（ます否定）",
    explanation: "丁宁体否定：行きません（不去）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ませんでした", category: "functional", reading: null, gloss: "（ます过去否定）",
    explanation: "丁宁体过去否定：行きませんでした（没去）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ましょう", category: "functional", reading: null, gloss: "（劝诱/决心）",
    explanation: "①劝诱（一起做…）：一緒に行きましょう（一起去吧）。②决心/回应：私がやりましょう（我来做吧）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "でしょう", category: "functional", reading: null, gloss: "（推测/确认）",
    explanation: "①推测（大概…吧）：明日は雨でしょう（明天大概下雨吧）。②确认（降调）：できるでしょう？（能行的吧？）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ください", category: "functional", reading: null, gloss: "请（做）",
    explanation: "请求（て形/名词+ください）：見てください（请看）。比「てくれ」礼貌。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "たい", category: "functional", reading: null, gloss: "想（做）",
    explanation: "愿望（动词连用形+たい）：日本に行きたい（想去日本）。变形容动词活用。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "た", category: "functional", reading: null, gloss: "（过去/完成）",
    explanation: "过去/完成助动词：食べた（吃了）。也表确认：ここにあった（原来在这里）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "だ", category: "functional", reading: null, gloss: "（断定）",
    explanation: "断定助动词（简体）：学生だ（是学生）。形容词/名词句简体句尾。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "である", category: "functional", reading: null, gloss: "（书面断定）",
    explanation: "书面语断定（=だ）：これは事実である（这是事实）。常见于论文/报道。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ない", category: "functional", reading: null, gloss: "（否定）",
    explanation: "否定助动词（简体）：行かない（不去）。形容词性活用：高くない（不贵）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ぬ", category: "functional", reading: null, gloss: "（否定，文语）",
    explanation: "文语否定（=ない）：知らぬ顔（装作不知）。多见于惯用表达：捨てる神あれば拾う神あり。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ず", category: "functional", reading: null, gloss: "（否定，书面）",
    explanation: "书面否定（=ない，连用）：行かず（不去）。常见组合：～ずに（不…而…）：諦めずに頑張る（不放弃地努力）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "そうだ", category: "functional", reading: null, gloss: "好像；听说",
    explanation: "①样态（看起来…）：おいしそうだ（看起来很好吃）。②传闻（听说…）：雨が降るそうだ（听说要下雨）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ようだ", category: "functional", reading: null, gloss: "好像；如同",
    explanation: "①比况（像…一样）：花のような笑顔（如花般的笑容）。②推测：誰か来たようだ（好像有人来了）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "みたいだ", category: "functional", reading: null, gloss: "好像（口语）",
    explanation: "ようだ的口语形：映画みたいだ（像电影一样）。推测：熱があるみたいだ（好像发烧了）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "らしい", category: "functional", reading: null, gloss: "好像；有…样子的",
    explanation: "①传闻/推测（据说…）：彼は来ないらしい（他好像不来）。②典型特征（有…风范）：男らしい（有男子气概）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "べき", category: "functional", reading: null, gloss: "应该；应当",
    explanation: "义务/应当（動詞辞書形+べき）：学生は勉強すべきだ（学生应当学习）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "はず", category: "functional", reading: null, gloss: "理应；应该",
    explanation: "（基于依据的）推测/确信：彼は知っているはずだ（他理应知道）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "つもり", category: "functional", reading: null, gloss: "打算；就当作",
    explanation: "①打算：留学するつもりだ（打算留学）。②就当作/自以为：読んだつもり（自以为读过了）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "けれど", category: "functional", reading: null, gloss: "虽然；不过",
    explanation: "逆接（书面，=けど）：高いけれど買った（虽然贵还是买了）。也作委婉铺垫。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "けど", category: "functional", reading: null, gloss: "虽然；不过（口语）",
    explanation: "けれど的口语形：行きたいけど時間がない（想去但没时间）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ながら", category: "functional", reading: null, gloss: "一边…一边",
    explanation: "同时进行（动词ます形+ながら）：歩きながら話す（边走边聊）。（助词表中另收逆接用法）",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ている", category: "functional", reading: null, gloss: "正在；保持着",
    explanation: "①进行：本を読んでいる（正在看书）。②状态持续：結婚している（已婚）。③习惯/经历：毎朝走っている（每天早上跑步）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ていた", category: "functional", reading: null, gloss: "（ている过去）",
    explanation: "ている的过去：映画を見ていた（当时正在看电影）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "てしまう", category: "functional", reading: null, gloss: "（完了/遗憾）",
    explanation: "①完了（强调全部）：食べてしまった（吃光了）。②遗憾/后悔：遅れてしまった（迟到了，糟糕）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ていく", category: "functional", reading: null, gloss: "（继续/离去）",
    explanation: "①空间上远离：持っていく（带去）。②时间上继续：頑張っていく（继续努力下去）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "てくる", category: "functional", reading: null, gloss: "（过来/逐渐）",
    explanation: "①空间上靠近：持ってくる（带来）。②变化逐渐发生：寒くなってきた（渐渐变冷了）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "たがる", category: "functional", reading: null, gloss: "（第三人称）想…",
    explanation: "第三人称愿望（他/她想要）：子供が行きたがる（孩子想去）。",
    confidence: 1, origin: "fixed"
  },
  {
    surface: "ませんか", category: "functional", reading: null, gloss: "（劝诱）要不要…",
    explanation: "礼貌劝诱（要不要一起…）：一緒に食べませんか（要不要一起吃？）。",
    confidence: 1, origin: "fixed"
  }
];

export const sentenceEndingTemplates: SentenceEndingTemplate[] = [
  { surface: "ますね", politeness: "formal", tone: "确认/征求同意", explanation: "丁宁体+ね，向对方确认或征求同意：暑いですね（真热啊）。" },
  { surface: "ますよ", politeness: "formal", tone: "告知/提醒", explanation: "丁宁体+よ，告知对方信息或稍作强调：ここで待ってますよ（我在这儿等哦）。" },
  { surface: "ますか", politeness: "formal", tone: "疑问", explanation: "丁宁体疑问：行きますか（去吗？）。" },
  { surface: "ませんか", politeness: "formal", tone: "劝诱", explanation: "礼貌劝诱：一緒に飲みませんか（要不要一起喝一杯？）。" },
  { surface: "ましょう", politeness: "formal", tone: "提议/决心", explanation: "提议一起做或表达决心：始めましょう（开始吧）。" },
  { surface: "でしょう", politeness: "formal", tone: "推测/确认", explanation: "推测（大概…吧）或降调确认：明日は晴れるでしょう（明天大概晴吧）。" },
  { surface: "ですね", politeness: "formal", tone: "确认/感叹", explanation: "です+ね，确认或感叹：いい天気ですね（天气真好啊）。" },
  { surface: "ですよ", politeness: "formal", tone: "告知/强调", explanation: "です+よ，告知对方：まだ大丈夫ですよ（还不要紧哦）。" },
  { surface: "ですから", politeness: "formal", tone: "原因/结论", explanation: "です+から，给出原因或引出结论：だからですからね（所以说嘛）。" },
  { surface: "そうです", politeness: "formal", tone: "传闻/肯定回应", explanation: "①肯定回应（是的）：はい、そうです。②传闻（听说）：合格したそうです（听说及格了）。" },
  { surface: "みたいです", politeness: "formal", tone: "推测（口语）", explanation: "みたい+です，口语推测：雨が降るみたいです（好像要下雨）。" },
  { surface: "らしいです", politeness: "formal", tone: "传闻/推测", explanation: "らしい+です，据闻/推断：彼は来ないらしいです（他好像不来）。" },
  { surface: "はずです", politeness: "formal", tone: "确信推测", explanation: "はず+です，基于依据的推测：もう着くはずです（应该快到了）。" },
  { surface: "かもしれません", politeness: "formal", tone: "不确定推测", explanation: "可能性的推测：間違っているかもしれません（说不定错了）。" },
  { surface: "したね", politeness: "formal", tone: "过去确认", explanation: "た+ね，对过去事实的确认/共感：先週も来ましたね（上周也来了吧）。" },
  { surface: "だね", politeness: "casual", tone: "确认/感叹（简体）", explanation: "简体断定+ね：面白い本だね（是本有意思的书呢）。" }
];
