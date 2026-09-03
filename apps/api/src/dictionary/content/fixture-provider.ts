import type {
  ContentDictionaryProvider,
  ContentDictionaryStats,
  ContentLookupQuery,
  ContentWordEntry
} from "./types.js";

/**
 * 样例实现（id="fixture"），**仅供 verify 断言接口链路**，不参与生产。
 *
 * 词条取自本语料的高频内容词，释义参考 JMdict，并刻意覆盖三种情形：
 * - surface 直击（時間 / 営業 …）
 * - lemma 回退（かかって → かかる）
 * - 多语言并存（時間 同时有 zh 与 en，用于验证展示语言优先级）
 */
const entries: ContentWordEntry[] = [
  {
    surface: "時間",
    reading: "じかん",
    partsOfSpeech: ["名詞"],
    glosses: [
      { lang: "zh", text: "时间" },
      { lang: "en", text: "time" },
      { lang: "en", text: "hours" }
    ],
    source: "fixture",
    matchedBy: "surface"
  },
  {
    surface: "営業",
    reading: "えいぎょう",
    partsOfSpeech: ["名詞"],
    glosses: [{ lang: "en", text: "business" }],
    source: "fixture",
    matchedBy: "surface"
  },
  {
    surface: "見積もり",
    reading: "みつもり",
    partsOfSpeech: ["名詞"],
    glosses: [{ lang: "en", text: "estimate" }],
    source: "fixture",
    matchedBy: "surface"
  },
  {
    surface: "商談",
    reading: "しょうだん",
    partsOfSpeech: ["名詞"],
    glosses: [{ lang: "en", text: "business discussion" }],
    source: "fixture",
    matchedBy: "surface"
  },
  {
    surface: "履歴",
    reading: "りれき",
    partsOfSpeech: ["名詞"],
    glosses: [{ lang: "en", text: "personal history" }],
    source: "fixture",
    matchedBy: "surface"
  },
  {
    surface: "部門",
    reading: "ぶもん",
    partsOfSpeech: ["名詞"],
    glosses: [{ lang: "en", text: "division (of a larger group)" }],
    source: "fixture",
    matchedBy: "surface"
  },
  {
    surface: "効率",
    reading: "こうりつ",
    partsOfSpeech: ["名詞"],
    glosses: [{ lang: "en", text: "efficiency" }],
    source: "fixture",
    matchedBy: "surface"
  },
  {
    // 仅供 lemma 回退测试：原文里是「かかって」，词典里只有原形
    surface: "かかる",
    reading: "かかる",
    partsOfSpeech: ["動詞"],
    glosses: [{ lang: "zh", text: "花费（时间）" }, { lang: "en", text: "to take (time)" }],
    source: "fixture",
    matchedBy: "surface"
  }
];

export class FixtureContentDictionary implements ContentDictionaryProvider {
  readonly id = "fixture";
  readonly label = "内置样例（仅测试）";

  private readonly index = new Map<string, ContentWordEntry>();

  ready(): boolean {
    return this.index.size > 0;
  }

  async initialize(): Promise<void> {
    if (this.index.size > 0) {
      return;
    }
    for (const entry of entries) {
      this.index.set(entry.surface, entry);
    }
  }

  lookup(query: ContentLookupQuery): ContentWordEntry | null {
    const bySurface = this.index.get(query.surface);
    if (bySurface) {
      return { ...bySurface, matchedBy: "surface" };
    }
    const lemma = query.lemma;
    if (lemma) {
      const byLemma = this.index.get(lemma);
      if (byLemma) {
        return { ...byLemma, surface: lemma, matchedBy: "lemma" };
      }
    }
    return null;
  }

  stats(): ContentDictionaryStats {
    return {
      entries: this.index.size,
      loaded: this.index.size > 0,
      version: "fixture-1",
      license: "none"
    };
  }
}
