import type { ContentDictionaryProvider } from "./types.js";
import { NullContentDictionary } from "./null-provider.js";
import { FixtureContentDictionary } from "./fixture-provider.js";
import { JmdictCommonProvider } from "./jmdict-common-provider.js";

export * from "./types.js";
export { NullContentDictionary } from "./null-provider.js";
export { FixtureContentDictionary } from "./fixture-provider.js";
export { JmdictCommonProvider } from "./jmdict-common-provider.js";

/**
 * 数据源注册表。
 *
 * 新增数据源只需两步：实现 ContentDictionaryProvider + 在这里注册，
 * 主链路（segment-preparation / analysis-service）零改动。
 *
 * 已接入 / 待实现（见 docs/jmdict-integration-design.md 第四节）：
 *   jmdict-common  — ✅ 已实现（scripts/build-jmdict-index.ts 预构建索引，英文释义）
 *   jmnedict       — 专名 74 万条（收益仅 11 token，倾向不做）
 *   中文资源        — 待用户自行寻找（kaikki zhwiktionary 体积过大且未分语言）
 */
const registry: Record<string, () => ContentDictionaryProvider> = {
  none: () => new NullContentDictionary(),
  fixture: () => new FixtureContentDictionary(),
  "jmdict-common": () => new JmdictCommonProvider()
};

/** 数据源 id 来源：app_settings 的 contentDictionary 键 → env CONTENT_DICT_ID → 默认 none。 */
export function resolveContentDictionaryId(
  settingsValue?: string | null,
  envValue?: string | null
): string {
  return settingsValue ?? envValue ?? "none";
}

/** 按 id 创建 provider；未知 id 回落到空实现（不抛错、不阻断分析）。 */
export function createContentDictionary(id?: string | null): ContentDictionaryProvider {
  const factory = id ? registry[id] : undefined;
  return factory ? factory() : new NullContentDictionary();
}

/** 已注册的数据源 id 列表（设置页下拉用）。 */
export function listContentDictionaryIds(): string[] {
  return Object.keys(registry);
}

/**
 * 可变数据源容器（镜像 LlmProviderHolder）：
 * 设置页后续保存后热切换，进行中的批次在下一个 batch 循环自然读到新 provider。
 */
export interface ContentDictionaryHolder {
  current: ContentDictionaryProvider;
  /** 热切换：保存设置后替换当前 provider（未来设置页 UI 用）。 */
  replace(next: ContentDictionaryProvider): void;
}

/**
 * 构建并安全初始化数据源容器（异步：首次需读取索引文件，只发生一次）。
 *
 * 解析顺序：db contentDictionary 键（设置页持久化） → env CONTENT_DICT_ID → 默认 none。
 * 默认 none ⇒ 不加载任何索引，行为与接入前完全一致（AC-01）。
 * 索引缺失/损坏由 initializeContentDictionary 静默回落 Null（AC-05）。
 *
 * 注意参数顺序：settingsValue 在前（db 优先），envValue 在后；
 * 旧调用 `createContentDictionaryHolder("jmdict-common")` 单参仍等价于「仅 env」。
 */
export async function createContentDictionaryHolder(
  settingsValue?: string | null,
  envValue?: string | null
): Promise<ContentDictionaryHolder> {
  const id = resolveContentDictionaryId(settingsValue, envValue);
  const provider = await initializeContentDictionary(createContentDictionary(id));
  const holder: ContentDictionaryHolder = {
    current: provider,
    replace(next: ContentDictionaryProvider): void {
      holder.current = next;
    }
  };
  return holder;
}

/**
 * 安全初始化：数据源损坏/缺失时回落空实现。
 *
 * 设计约束（AC-05）：加载失败**必须**静默降级，绝不阻断分析。
 */
export async function initializeContentDictionary(
  provider: ContentDictionaryProvider
): Promise<ContentDictionaryProvider> {
  try {
    await provider.initialize();
    return provider;
  } catch (error) {
    console.warn(
      `[content-dictionary] 数据源 ${provider.id} 初始化失败，回落到空实现：`,
      error instanceof Error ? error.message : error
    );
    return new NullContentDictionary();
  }
}
