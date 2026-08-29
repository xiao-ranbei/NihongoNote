export interface TokenBoundary {
  tokenId: string;
  startOffset: number;
  endOffset: number;
  surface: string;
}

interface RawToken {
  startOffset: number;
  endOffset: number;
  surface: string;
}

/**
 * 独立成词的助词与高频助动词。
 *
 * Intl.Segmenter 的问题不是「切太细」，而是「把敬语活用尾和补助动词切成单字」：
 * ありがとうございます → ありがとう|ご|ざ|い|ます
 * よろしくお願いします → よろしく|お願い|し|ます
 * 这些单字对学习者毫无意义，还会把一次分析要处理的 token 数翻倍。
 *
 * 但助词必须保持独立：需求里助词要用双线单独标注，一旦把「は」「を」
 * 并进前词，界面上就再也画不出那条线了。所以这里显式列出「不许被合并」的词。
 */
const standaloneParticles = new Set([
  // 格助词
  "が", "の", "を", "に", "へ", "と", "から", "まで", "より", "で", "や",
  // 系助词・副助词
  "は", "も", "こそ", "さえ", "しか", "だけ", "ばかり", "ほど", "くらい", "ぐらい",
  "など", "とか", "なり", "ずつ", "きり", "のみ",
  // 接続助词
  "て", "ば", "ながら", "ので", "のに", "たら", "たり", "ても", "でも", "とも",
  // 终助词
  "か", "ね", "よ", "な", "わ", "ぜ", "ぞ"
]);

/**
 * 助动词与前两组的差别在于：它们可以独立成词，但不能用来判断「词尾是不是边界」。
 *
 * 「だ」「た」「ない」这些助动词同时也是大量普通词的尾音节（くだ／かって／〜的だ），
 * 一旦拿它们去查词尾，「ください」就会被当成「くだ + 助动词」而永远拼不回来。
 */
const standaloneAuxiliaries = new Set([
  "ます", "です", "ました", "でした", "ません", "ましょう", "でしょう",
  "ください", "たい", "ない", "た", "だ", "である"
]);

const standaloneFunctionWords = new Set([
  ...standaloneParticles,
  ...standaloneAuxiliaries
]);

/**
 * 允许从 token 头部切走的助词。
 *
 * Segmenter 有时会把助词和后面一个字粘成一个 token：
 *   勉強しています → 毎日|日本語|を|勉強|し|てい|ます（"てい" 粘住了）
 * 不拆开的话，「前一个词是助词」的判断就永远命中不了，て 也就画不出来。
 *
 * 这个白名单刻意开得很小：只放「て」。
 * 「は」「に」「で」等同样是格助词，但它们大量出现在和语词的首音节
 * （はる/にほん/でる），一旦放开就会把正常的词剁成两半。
 * 而「て」开头的和语词几乎不存在，拆开的风险可以忽略。
 */
const splittableLeadingParticles = ["て"];

const hiraganaOnlyPattern = /^[\u3041-\u309F]+$/u;

/** 合并后的单个 token 长度上限，防止病态地把整句粘成一个词。 */
const maxMergedLength = 10;

const wordSegmenter = new Intl.Segmenter("ja", { granularity: "word" });

/**
 * 词尾是否已经落在助词上。
 *
 * 只看「前一个 token 整体是不是助词」是不够的：Segmenter 会给
 * 「者によって」这种把助词粘在词干后面的结果，它整体不在白名单里，
 * 于是后面的「ばらつき」就被一并吞成「者によってばらつき」。
 * 助词边界两边本来就该断开，所以词尾同样要查一次。
 */
function endsWithStandaloneParticle(surface: string): boolean {
  for (const particle of standaloneParticles) {
    if (surface.length > particle.length && surface.endsWith(particle)) {
      return true;
    }
  }
  return false;
}

function isHiraganaFragment(token: RawToken): boolean {
  return token.surface.length === 1 && hiraganaOnlyPattern.test(token.surface);
}

/** 把「助词 + 单字碎片」的粘合体拆开，例如 てい → て + い。 */
function splitLeadingParticle(token: RawToken): RawToken[] {
  if (standaloneFunctionWords.has(token.surface)) {
    return [token];
  }

  for (const particle of splittableLeadingParticles) {
    const remainder = token.surface.slice(particle.length);
    if (
      token.surface.length === particle.length + 1
      && token.surface.startsWith(particle)
      && hiraganaOnlyPattern.test(remainder)
    ) {
      return [
        {
          startOffset: token.startOffset,
          endOffset: token.startOffset + particle.length,
          surface: particle
        },
        {
          startOffset: token.startOffset + particle.length,
          endOffset: token.endOffset,
          surface: remainder
        }
      ];
    }
  }

  return [token];
}

function isMergeableTail(token: RawToken): boolean {
  // 只处理假名碎片：汉字词、片假名、数字、字母都不做合并，
  // 这些 Segmenter 切得本来就准，合并反而会毁掉专有名词。
  return hiraganaOnlyPattern.test(token.surface)
    && !standaloneFunctionWords.has(token.surface);
}

function mergeIntoLeft(target: RawToken, fragment: RawToken): RawToken {
  return {
    startOffset: target.startOffset,
    endOffset: fragment.endOffset,
    surface: target.surface + fragment.surface
  };
}

/**
 * 第一遍：把碎片向左并入前一个词。
 *
 * 日语是黏着语，活用尾天然跟在词干后面，所以默认方向是向左。
 * 但前一个词本身是助词时不并 —— 「私は」里的「は」后面跟的是体言，
 * 把体言并进助词会得到「はそれ」这种没有语法意义的东西。
 */
function mergeFragmentsLeft(tokens: RawToken[]): RawToken[] {
  const merged: RawToken[] = [];

  for (const token of tokens) {
    const previous = merged[merged.length - 1];
    const adjacent = previous !== undefined && previous.endOffset === token.startOffset;

    if (
      previous === undefined
      || !adjacent
      || !isMergeableTail(token)
      || standaloneFunctionWords.has(previous.surface)
      || endsWithStandaloneParticle(previous.surface)
      || previous.surface.length + token.surface.length > maxMergedLength
    ) {
      merged.push(token);
      continue;
    }

    merged[merged.length - 1] = mergeIntoLeft(previous, token);
  }

  return merged;
}

/**
 * 第二遍：把「前面是助词、自己又是单字假名」的碎片向右并。
 *
 * 典型场景「勉強しています」→ 勉強|し|て|い|ます：
 * 「い」前面的「て」是助词，不能向左并，于是「しています」这件事就卡住了。
 * 向右并到「ます」上得到「います」，正是教材里的标准切法。
 */
function mergeFragmentsRight(tokens: RawToken[]): RawToken[] {
  const merged: RawToken[] = [];
  let pending: RawToken | undefined;

  for (const token of tokens) {
    if (pending === undefined) {
      pending = token;
      continue;
    }

    const previous = merged[merged.length - 1];
    const adjacent = pending.endOffset === token.startOffset;
    // 只有当左侧确实停在助词边界上时才向右并，否则说明这个碎片
    // 本来就该向左并，只是被长度上限或断点拦住了，不该再往右推。
    const leftIsParticleBoundary = previous === undefined
      || standaloneFunctionWords.has(previous.surface)
      || endsWithStandaloneParticle(previous.surface);
    const shouldShift = isHiraganaFragment(pending)
      && !standaloneFunctionWords.has(pending.surface)
      && leftIsParticleBoundary
      && adjacent
      && pending.surface.length + token.surface.length <= maxMergedLength;

    if (shouldShift) {
      merged.push({
        startOffset: pending.startOffset,
        endOffset: token.endOffset,
        surface: pending.surface + token.surface
      });
      pending = undefined;
      continue;
    }

    merged.push(pending);
    pending = token;
  }

  if (pending !== undefined) {
    merged.push(pending);
  }

  return merged;
}

export function tokenizeJapanese(text: string, segmentId: string): TokenBoundary[] {
  const rawTokens: RawToken[] = [];

  for (const part of wordSegmenter.segment(text)) {
    if (!part.isWordLike) {
      continue;
    }
    rawTokens.push(...splitLeadingParticle({
      startOffset: part.index,
      endOffset: part.index + part.segment.length,
      surface: part.segment
    }));
  }

  const merged = mergeFragmentsRight(mergeFragmentsLeft(rawTokens));

  return merged.map((token, index) => ({
    tokenId: `${segmentId}:token:${index}`,
    startOffset: token.startOffset,
    endOffset: token.endOffset,
    surface: token.surface
  }));
}
