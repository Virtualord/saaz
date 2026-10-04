import { subtitleConstraints as C } from '../../shared/types.js';
import type { Segment } from '../../shared/types.js';
import {
  charBudget,
  checkCue,
  cpsOf,
  HARD_BREAKS,
  layoutLines,
  linesNeeded,
  SOFT_BREAKS,
} from '../../shared/cue-rules.js';
import { log } from '../core/logger.js';

// The rules live in shared/cue-rules.ts because the browser editor needs the
// exact same implementation. Re-exported here so server call sites stay tidy.
export { charBudget, checkCue, cpsOf, layoutLines, linesNeeded };
export { wrapFlat } from '../../shared/cue-rules.js';

/**
 * Turns aligned speech into subtitle cues that respect hard readability limits.
 *
 * This is deterministic on purpose. A subtitle file is a deliverable a client
 * signs off on, so the same input must always produce the same output — which is
 * exactly why there is no LLM in this stage.
 */

export interface RawCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** Split a word longer than the per-line limit, since it cannot be wrapped. */
function splitLongText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [text];

  const out: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current += ' ' + word;
    } else {
      out.push(current);
      current = word;
    }
    while (current.length > limit) {
      out.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Break text at the most natural point available: sentence punctuation first,
 * then clause punctuation, then whitespace. This is segmentation-specific, so it
 * stays here rather than in the shared rules module.
 */
function splitAtNaturalBreak(text: string, limit: number): [string, string] | null {
  if (text.length <= limit) return null;

  const window = text.slice(0, limit + 1);
  for (const re of [HARD_BREAKS, SOFT_BREAKS]) {
    const reGlobal = new RegExp(re.source, 'g');
    let best = -1;
    let m: RegExpExecArray | null;
    while ((m = reGlobal.exec(window)) !== null) {
      if (m.index > 0) best = m.index + m[0].length;
    }
    if (best > 0 && best < text.length) {
      const head = text.slice(0, best).trim();
      const tail = text.slice(best).trim();
      if (head.length >= 4 && tail.length >= 4) return [head, tail];
    }
  }

  const pieces = splitLongText(text, limit);
  if (pieces.length > 1) {
    return [pieces[0]!, pieces.slice(1).join(' ')];
  }
  return null;
}

/**
 * Segment aligned speech into cues.
 *
 * Each incoming speech region is divided in proportion to how much text it has
 * to say, then each piece is re-split if the budget demands it. Regions shorter
 * than `minCueMs` are merged forward rather than emitted as flickers.
 */
export function segment(segments: Segment[]): RawCue[] {
  const cues: RawCue[] = [];

  // Merge very short adjacent regions so we never emit a sub-second cue.
  const merged: Segment[] = [];
  for (const seg of segments) {
    const prev = merged[merged.length - 1];
    if (prev && seg.startMs - prev.endMs < C.minGapMs) {
      prev.endMs = Math.max(prev.endMs, seg.endMs);
      prev.text = `${prev.text} ${seg.text}`.replace(/\s+/g, ' ').trim();
    } else {
      merged.push({ ...seg });
    }
  }

  for (const seg of merged) {
    const durationMs = Math.max(C.minCueMs, seg.endMs - seg.startMs);
    const budget = charBudget(durationMs);
    const pieces = splitAtNaturalBreak(seg.text, budget);
    const parts = pieces ? [pieces[0], pieces[1]] : [seg.text];

    const per = durationMs / parts.length;
    for (const [i, part] of parts.entries()) {
      const startMs = Math.round(seg.startMs + i * per);
      const endMs = i === parts.length - 1 ? Math.round(seg.endMs) : Math.round(seg.startMs + (i + 1) * per);
      const lines = wrapIntoLines(part);
      cues.push({
        startMs,
        endMs: Math.max(endMs, startMs + C.minCueMs),
        text: lines.join('\n'),
      });
    }
  }

  log.info('segment.done', {
    inputSegments: merged.length,
    cues: cues.length,
    maxCps: C.maxCps,
    maxCharsPerLine: C.maxCharsPerLine,
  });

  return cues;
}

/** Convenience wrapper when only the lines are needed. */
export function wrapIntoLines(text: string, maxChars = C.maxCharsPerLine): string[] {
  return layoutLines(text, maxChars).lines;
}
