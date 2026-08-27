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

const speakerPrefixPattern = /^(\s*)([^：:\r\n]{1,40})[：:]/u;
const sentenceEndings = new Set(["。", "！", "？", "!", "?"]);

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
    const speakerMatch = speakerPrefixPattern.exec(lineText);

    if (speakerMatch) {
      if (currentTurn && currentTurn.startOffset < currentTurn.endOffset) {
        turns.push(currentTurn);
      }

      const leadingWhitespace = speakerMatch[1] ?? "";
      const speaker = speakerMatch[2]?.trim();
      const contentStart = lineStart + leadingWhitespace.length + (speakerMatch[2]?.length ?? 0) + 1;
      currentTurn = {
        speaker: speaker && speaker.length > 0 ? speaker : null,
        startOffset: contentStart,
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

  return segments;
}
