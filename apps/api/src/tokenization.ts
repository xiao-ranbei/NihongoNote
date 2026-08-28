export interface TokenBoundary {
  tokenId: string;
  startOffset: number;
  endOffset: number;
  surface: string;
}

export function tokenizeJapanese(text: string, segmentId: string): TokenBoundary[] {
  const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
  const boundaries: TokenBoundary[] = [];

  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike) {
      continue;
    }

    boundaries.push({
      tokenId: `${segmentId}:token:${boundaries.length}`,
      startOffset: part.index,
      endOffset: part.index + part.segment.length,
      surface: part.segment
    });
  }

  return boundaries;
}
