import type { Segment } from '../../shared/types.js';
import type { SpeechRegion } from './vad.js';
import { log } from '../core/logger.js';

/**
 * Align ASR text to VAD speech regions.
 *
 * Whisper gives us the words but (on this export) not when they were said. The
 * VAD gives us when, but not what. So we hand the text to the clock: each speech
 * region receives a share of the transcript proportional to how long it lasts,
 * and segments that straddle a region boundary are split at the nearest word.
 *
 * This is a deliberate approximation, and we say so in the UI. It is accurate
 * enough for subtitle cue boundaries because those mostly need to fall on
 * speech onsets, which the VAD gives us exactly.
 */
export function alignToRegions(segments: Segment[], regions: SpeechRegion[]): Segment[] {
  if (regions.length === 0 || segments.length === 0) return segments;

  // Work in whole words. An earlier version sliced by raw character offset and
  // it cut mid-word ("...श्रूए ह"), which is unacceptable in a subtitle and was
  // caught by inspecting real output.
  const words: string[] = [];
  for (const seg of segments) {
    for (const w of seg.text.split(/\s+/)) if (w) words.push(w);
  }
  if (words.length === 0 || regions.length === 0) return segments;

  const totalChars = words.reduce((n, w) => n + w.length, 0);
  const totalSpeechMs = regions.reduce((n, r) => n + (r.endMs - r.startMs), 0);
  if (totalChars === 0 || totalSpeechMs === 0) return segments;

  const confs = segments.filter((s) => s.asrConfidence !== null).map((s) => s.asrConfidence as number);
  const avgConf = confs.length > 0 ? confs.reduce((a, b) => a + b, 0) / confs.length : null;

  const out: Segment[] = [];
  let wordIndex = 0;

  for (const [i, region] of regions.entries()) {
    if (wordIndex >= words.length) break;

    // Budget in whole words: proportional to how long the region lasts, then
    // rounded to a whole word so nothing is ever cut in half.
    const share = (region.endMs - region.startMs) / totalSpeechMs;
    const isLast = i === regions.length - 1;
    let wordCount = isLast ? words.length - wordIndex : Math.max(1, Math.round(share * words.length));
    wordCount = Math.min(wordCount, words.length - wordIndex);

    // Don't strand trailing words if the remaining regions can't hold them.
    const regionsLeft = regions.length - i;
    if (words.length - wordIndex <= regionsLeft) {
      wordCount = words.length - wordIndex;
    }

    const slice = words.slice(wordIndex, wordIndex + wordCount);
    wordIndex += wordCount;

    out.push({
      startMs: region.startMs,
      endMs: region.endMs,
      text: slice.join(' '),
      asrConfidence: avgConf,
      suspectedHallucination: false,
    });
  }

  log.info('align.done', {
    inputSegments: segments.length,
    words: words.length,
    regions: regions.length,
    outputSegments: out.length,
    wordsPlaced: wordIndex,
    unplacedWords: words.length - wordIndex,
    speechMs: totalSpeechMs,
  });

  // Guarantee monotonic, non-overlapping cues downstream code can assume.
  for (let i = 0; i < out.length; i++) {
    const cur = out[i]!;
    cur.startMs = Math.max(0, cur.startMs);
    if (cur.endMs <= cur.startMs) cur.endMs = cur.startMs + 400;
    const next = out[i + 1];
    if (next && cur.endMs > next.startMs) cur.endMs = Math.max(cur.startMs + 100, next.startMs - 40);
  }

  return out;
}