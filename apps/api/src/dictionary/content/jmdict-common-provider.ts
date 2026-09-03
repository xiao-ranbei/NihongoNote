import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";

import type {
  ContentDictionaryProvider,
  ContentDictionaryStats,
  ContentGloss,
  ContentLookupQuery,
  ContentWordEntry
} from "./types.js";

/** 精简索引条目（紧凑字段名以压低体积）。 */
interface SlimEntry {
  r: string | null;
  p: string[];
  g: { l: string; t: string }[];
}

interface SlimIndex {
  version: string | null;
  source: string;
  license: string | null;
  entries: Record<string, SlimEntry>;
}

// 文件位于 src/dictionary/content/，向上三级到 apps/api/，再进 data/
const DEFAULT_INDEX_PATH = fileURLToPath(
  new URL("../../../data/jmdict-common-index.json", import.meta.url)
);

export interface JmdictCommonOptions {
  /** 索引文件路径；默认 apps/api/data/jmdict-common-index.json */
  indexPath?: string;
}

/**
 * JMdict 常用词（英文释义）数据源适配器。
 *
 * 实现 ContentDictionaryProvider：
 * - initialize 在索引文件缺失/损坏时**抛错**，交由 initializeContentDictionary
 *   工厂静默回落到 NullContentDictionary（满足 AC-05，不阻断分析）；
 * - lookup 两级匹配：surface 直击 → kuromoji lemma 回退；
 * - 释义语言固定 en（JMdict 官方多语不含中文，见设计文档「中文问题」）。
 *
 * 数据文件由 scripts/build-jmdict-index.ts 预构建，不入库（data/ 目录，已被 gitignore）。
 */
export class JmdictCommonProvider implements ContentDictionaryProvider {
  readonly id = "jmdict-common";
  readonly label = "JMdict 常用词（英文）";

  private readonly indexPath: string;
  private index: SlimIndex | null = null;

  constructor(options: JmdictCommonOptions = {}) {
    this.indexPath = options.indexPath ?? DEFAULT_INDEX_PATH;
  }

  ready(): boolean {
    return this.index !== null && Object.keys(this.index.entries).length > 0;
  }

  async initialize(): Promise<void> {
    if (this.index) {
      return; // 幂等
    }
    const raw = fs.readFileSync(this.indexPath, "utf8");
    const parsed = JSON.parse(raw) as SlimIndex;
    if (!parsed || typeof parsed !== "object" || !parsed.entries) {
      throw new Error(`jmdict 索引格式无效：${this.indexPath}`);
    }
    this.index = parsed;
  }

  lookup(query: ContentLookupQuery): ContentWordEntry | null {
    if (!this.index) {
      return null;
    }
    const bySurface = this.index.entries[query.surface];
    if (bySurface) {
      return this.toEntry(query.surface, bySurface, "surface");
    }
    if (query.lemma) {
      const byLemma = this.index.entries[query.lemma];
      if (byLemma) {
        return this.toEntry(query.lemma, byLemma, "lemma");
      }
    }
    return null;
  }

  private toEntry(
    surface: string,
    entry: SlimEntry,
    matchedBy: "surface" | "lemma"
  ): ContentWordEntry {
    const glosses: ContentGloss[] = entry.g.map((g) => ({ lang: g.l, text: g.t }));
    return {
      surface,
      reading: entry.r,
      partsOfSpeech: entry.p,
      glosses,
      source: this.index?.source ?? "jmdict",
      matchedBy
    };
  }

  stats(): ContentDictionaryStats {
    return {
      entries: this.index ? Object.keys(this.index.entries).length : 0,
      loaded: this.ready(),
      version: this.index?.version ?? null,
      license: this.index?.license ?? null
    };
  }
}
