import type {
  ContentDictionaryProvider,
  ContentDictionaryStats,
  ContentLookupQuery,
  ContentWordEntry
} from "./types.js";

/**
 * 空实现（默认数据源 id="none"）。
 *
 * 未配置任何内容词数据源时使用，保证接入前后行为完全一致：
 * 所有 token 照旧落入 LLM 候选，不产生任何额外条目。
 */
export class NullContentDictionary implements ContentDictionaryProvider {
  readonly id = "none";
  readonly label = "未启用";

  ready(): boolean {
    return false;
  }

  async initialize(): Promise<void> {
    // 无数据可加载
  }

  lookup(_query: ContentLookupQuery): ContentWordEntry | null {
    return null;
  }

  stats(): ContentDictionaryStats {
    return { entries: 0, loaded: false, version: null, license: null };
  }
}
