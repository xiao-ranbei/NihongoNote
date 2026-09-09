import type { DocumentDetail } from "@nihongonote/core";
import type { ReactElement, ReactNode } from "react";

import type { Segment } from "../lib/constants";
import { tokenCategoryLabels } from "../lib/constants";
import { getTokenCategory, isRenderableToken } from "../lib/tokens";

/**
 * 连续阅读表面（S0 拆分自 App.tsx）。
 *
 * 需求 1.1：原文、换行、标点和未解析区块必须在同一个连续阅读框里，
 * 不能视觉上拆成句子卡片——这里的渲染只靠稳定偏移切分，不插入块级容器。
 *
 * 两个函数都是纯渲染（无状态、无请求），点击行为由调用方通过回调注入，
 * 便于 P1 增强的四层点击循环（docs/p1-enhancement-design.md §4.1）替换选择模型。
 */

/** 单个句段内部：按 token 偏移切分成可点击的词块 + 未覆盖的原文片段。 */
export function renderSegmentContent(
  segment: Segment,
  isSelected: boolean,
  selectedTokenId: string | null,
  onSelectSegment: (segmentId: string) => void,
  onSelectToken: (segmentId: string, tokenId: string) => void
): ReactElement {
  const content: ReactNode[] = [];
  const tokens = (segment.analysis?.tokens ?? [])
    .filter((token) => isRenderableToken(token, segment.text))
    .sort((left, right) => left.startOffset - right.startOffset);
  let cursor = 0;

  for (const token of tokens) {
    if (token.startOffset < cursor) {
      continue;
    }
    if (token.startOffset > cursor) {
      content.push(
        <span className="article-plain" key={`${token.tokenId}:before`}>
          {segment.text.slice(cursor, token.startOffset)}
        </span>
      );
    }

    const category = getTokenCategory(token);
    content.push(
      <button
        aria-label={`${token.surface}，${tokenCategoryLabels[category]}`}
        aria-pressed={selectedTokenId === token.tokenId}
        className={`annotation-token annotation-${category} ${
          selectedTokenId === token.tokenId ? "is-selected" : ""
        }`}
        key={token.tokenId}
        onClick={(event) => {
          event.stopPropagation();
          onSelectToken(segment.id, token.tokenId);
        }}
        title={tokenCategoryLabels[category]}
        type="button"
      >
        {token.surface}
      </button>
    );
    cursor = token.endOffset;
  }

  if (cursor < segment.text.length) {
    content.push(
      <span className="article-plain" key={`${segment.id}:after`}>
        {segment.text.slice(cursor)}
      </span>
    );
  }

  if (content.length === 0) {
    content.push(
      <span className="article-plain" key={`${segment.id}:text`}>
        {segment.text}
      </span>
    );
  }

  return (
    <span
      aria-label={`第 ${segment.index + 1} 句`}
      className={`article-segment status-${segment.status} ${isSelected ? "is-selected" : ""}`}
      data-segment-id={segment.id}
      onClick={() => onSelectSegment(segment.id)}
    >
      {content}
    </span>
  );
}

/** 整篇文章：按段偏移拼接句段，段间空隙与文末残文原样保留。 */
export function renderArticle(
  document: DocumentDetail,
  selectedSegmentId: string | null,
  selectedTokenId: string | null,
  onSelectSegment: (segmentId: string) => void,
  onSelectToken: (segmentId: string, tokenId: string) => void
): ReactNode[] {
  const content: ReactNode[] = [];
  let cursor = 0;

  for (const segment of document.segments) {
    const startOffset = Math.max(0, Math.min(document.sourceText.length, segment.startOffset));
    const endOffset = Math.max(startOffset, Math.min(document.sourceText.length, segment.endOffset));

    if (startOffset > cursor) {
      content.push(
        <span className="article-source-gap" key={`${segment.id}:gap`}>
          {document.sourceText.slice(cursor, startOffset)}
        </span>
      );
    }

    content.push(
      <span
        className={`article-segment-wrapper ${segment.id === selectedSegmentId ? "is-active" : ""}`}
        key={segment.id}
      >
        {renderSegmentContent(
          segment,
          segment.id === selectedSegmentId,
          selectedTokenId,
          onSelectSegment,
          onSelectToken
        )}
      </span>
    );
    cursor = Math.max(cursor, endOffset);
  }

  if (cursor < document.sourceText.length) {
    content.push(
      <span className="article-source-gap" key="article:tail">
        {document.sourceText.slice(cursor)}
      </span>
    );
  }

  if (content.length === 0) {
    content.push(<span key="article:source">{document.sourceText}</span>);
  }

  return content;
}
