import type { Segment } from "@nihongonote/core";

interface Turn {
  speaker: string | null;
  startOffset: number;
  endOffset: number;
}

interface Span {
  startOffset: number;
  endOffset: number;
}

/**
 * 说话人标签形如「田中：こんにちは」。
 *
 * 误判代价极高：一旦把某行前缀认成说话人，contentStart 会跳过它，
 * 这段原文就永远不进入任何 segment，也不会被分析到。
 * 另一方面，收紧过度会让真正的说话人标签失效，两种错误都要靠
 * scripts/verify-pipeline.ts 里的用例同时盯住。
 *
 * 标签结构：首字符非空白、尾字符非空白、中间允许空格，全段不含冒号与路径符号。
 * 冒号后的负向前瞻逐条对应一个已知误判：
 *   (?!\d)      —— "10:30 から会議です"
 *   (?![\\/])   —— "C:\notes\a.txt"
 * 标签内禁止 / \ @ —— "https://example.com"（原正则会吞掉 "https:"）。
 * 协议名再用 rejectedSpeakerLabels 兜底，处理 "https：..." 这类全角冒号变体。
 */
const speakerPrefixPattern =
  /^(\s*)([^\s：:\r\n/\\@](?:[^：:\r\n/\\@]{0,18}[^\s：:\r\n/\\@])?)[ \t　]*[：:](?!\d)(?![\\/])/u;
const rejectedSpeakerLabels = /^(?:https?|ftp|mailto|tel|file)$/iu;
const sentenceEndings = new Set(["。", "！", "？", "!", "?"]);

function readSpeaker(lineText: string): { speaker: string; contentOffset: number } | undefined {
  const match = speakerPrefixPattern.exec(lineText);
  if (!match) {
    return undefined;
  }

  const label = match[2] ?? "";
  if (rejectedSpeakerLabels.test(label)) {
    return undefined;
  }

  return {
    speaker: label.trim(),
    // 整个匹配 = 行首空白 + 标签 + 标签与冒号之间的空白 + 冒号，
    // 直接取全长，避免手工累加时漏算尾随空格或冒号宽度。
    contentOffset: match[0].length
  };
}

function collectTurns(sourceText: string): Turn[] {
  const turns: Turn[] = [];
  let currentTurn: Turn | undefined;
  let offset = 0;
  const linePattern = /([^\r\n]*)(\r\n|\n|$)/gu;

  for (const match of sourceText.matchAll(linePattern)) {
    const fullLine = match[0];
    const lineText = match[1] ?? "";
    const lineStart = offset;
    const lineEnd = lineStart + lineText.length;
    const speakerLabel = readSpeaker(lineText);

    if (lineText.trim().length === 0) {
      if (currentTurn && currentTurn.startOffset < currentTurn.endOffset) {
        turns.push(currentTurn);
      }
      currentTurn = undefined;
    } else if (speakerLabel) {
      if (currentTurn && currentTurn.startOffset < currentTurn.endOffset) {
        turns.push(currentTurn);
      }

      currentTurn = {
        speaker: speakerLabel.speaker.length > 0 ? speakerLabel.speaker : null,
        startOffset: lineStart + speakerLabel.contentOffset,
        endOffset: lineEnd
      };
    } else if (currentTurn) {
      currentTurn.endOffset = lineEnd;
    } else if (lineText.trim().length > 0) {
      currentTurn = {
        speaker: null,
        startOffset: lineStart,
        endOffset: lineEnd
      };
    }

    offset += fullLine.length;
    if (fullLine.length === 0) {
      break;
    }
  }

  if (currentTurn && currentTurn.startOffset < currentTurn.endOffset) {
    turns.push(currentTurn);
  }

  return turns;
}

function splitTurn(sourceText: string, turn: Turn): Span[] {
  const spans: Span[] = [];
  let spanStart = turn.startOffset;

  for (let offset = turn.startOffset; offset < turn.endOffset; offset += 1) {
    const character = sourceText[offset];
    if (!character || !sentenceEndings.has(character)) {
      continue;
    }

    spans.push({
      startOffset: spanStart,
      endOffset: offset + 1
    });
    spanStart = offset + 1;
  }

  if (spanStart < turn.endOffset) {
    spans.push({
      startOffset: spanStart,
      endOffset: turn.endOffset
    });
  }

  return spans;
}

function trimSpan(sourceText: string, span: Span): Span | undefined {
  let startOffset = span.startOffset;
  let endOffset = span.endOffset;

  while (startOffset < endOffset && /\s/u.test(sourceText[startOffset] ?? "")) {
    startOffset += 1;
  }
  while (endOffset > startOffset && /\s/u.test(sourceText[endOffset - 1] ?? "")) {
    endOffset -= 1;
  }

  return startOffset < endOffset ? { startOffset, endOffset } : undefined;
}

export function assertSegmentsMatchSource(
  sourceText: string,
  documentId: string,
  segments: Segment[]
): void {
  let previousEndOffset = 0;
  for (const [index, segment] of segments.entries()) {
    if (segment.documentId !== documentId
      || segment.index !== index
      || segment.id !== `${documentId}:segment:${index}`) {
      throw new Error(`Segment ${index} has unstable identity metadata`);
    }
    if (segment.startOffset < previousEndOffset
      || segment.endOffset <= segment.startOffset
      || segment.endOffset > sourceText.length) {
      throw new Error(`Segment ${segment.id} has invalid UTF-16 offsets`);
    }
    if (sourceText.slice(segment.startOffset, segment.endOffset) !== segment.text) {
      throw new Error(`Segment ${segment.id} text does not match its source range`);
    }
    previousEndOffset = segment.endOffset;
  }
}

export interface SourceCoverage {
  sourceNonWhitespace: number;
  segmentNonWhitespace: number;
  missingNonWhitespace: number;
  coverageRatio: number;
}

/**
 * 统计源文本有多少非空白字符真正落进了 segment。
 *
 * 合法损耗只有两类：说话人标签本身、行间空白。
 * 说话人正则一旦再次放宽到能吞正文，这个比值会明显下滑，
 * 因此在验证脚本里用它当守卫，而不是等用户发现内容缺失。
 */
export function measureSourceCoverage(sourceText: string, segments: Segment[]): SourceCoverage {
  const countNonWhitespace = (value: string): number =>
    value.replace(/\s/gu, "").length;

  const sourceNonWhitespace = countNonWhitespace(sourceText);
  const segmentNonWhitespace = segments.reduce(
    (total, segment) => total + countNonWhitespace(segment.text),
    0
  );
  const missingNonWhitespace = Math.max(sourceNonWhitespace - segmentNonWhitespace, 0);

  return {
    sourceNonWhitespace,
    segmentNonWhitespace,
    missingNonWhitespace,
    coverageRatio: sourceNonWhitespace === 0
      ? 1
      : segmentNonWhitespace / sourceNonWhitespace
  };
}

export function splitIntoSegments(sourceText: string, documentId: string): Segment[] {
  const segments: Segment[] = [];
  let segmentIndex = 0;

  for (const turn of collectTurns(sourceText)) {
    for (const rawSpan of splitTurn(sourceText, turn)) {
      const span = trimSpan(sourceText, rawSpan);
      if (!span) {
        continue;
      }

      segments.push({
        id: `${documentId}:segment:${segmentIndex}`,
        documentId,
        index: segmentIndex,
        text: sourceText.slice(span.startOffset, span.endOffset),
        startOffset: span.startOffset,
        endOffset: span.endOffset,
        speaker: turn.speaker,
        status: "queued",
        errorMessage: null
      });
      segmentIndex += 1;
    }
  }

  assertSegmentsMatchSource(sourceText, documentId, segments);
  return segments;
}
