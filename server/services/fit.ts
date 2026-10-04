import { subtitleConstraints as C, type Cue, type FitEscalation } from '../../shared/types.js';
import { charBudget, checkCue, cpsOf, layoutLines, wrapIntoLines, type RawCue } from './segmenter.js';
import { log } from '../core/logger.js';

/**
 * The Fit algorithm.
 *
 * A translation often needs more characters than the time window can display.
 * A naive pipeline overflows, truncates, or silently produces an unreadable
 * file. This escalates through progressively more invasive fixes and, when none
 * of them can preserve meaning inside the constraints, refuses and tells the
 * human what needs their attention.
 *
 * The refusal is the most important behaviour here. A subtitle tool that always
 * emits something is worse than useless for a deliverable a client signs off on.
 */

export interface FitInput {
  cue: RawCue;
  sourceText: string;
  /**
   * The English caption. `null` means "source is already English". `undefined`
   * means "not translated yet" — a cue we have just split — and the fitter then
   * falls back to the source text rather than inventing a translation.
   */
  translation: string | null | undefined;
  /** The cue immediately after this one, used to test for room to extend. */
  next?: RawCue;
}

/** Ask the caption model for a shorter caption that still means the same thing. */
export type ReflowFn = (args: {
  sourceText: string;
  draft: string;
  maxChars: number;
}) => Promise<{ lines: string[]; note: string } | null>;

export interface FitOptions {
  reflow: ReflowFn;
  /** Hard ceiling on how long a cue may be stretched. */
  maxExtendMs?: number;
}

function fits(text: string, durationMs: number): boolean {
  const budget = charBudget(durationMs);
  const chars = text.replace(/\s+/g, '').length;
  return chars <= budget && layoutLines(text).fits;
}

/**
 * Split a cue into two timed cues.
 *
 * When a caption needs more time than it has, borrowing the next cue's window
 * only works if the next cue has slack to lend. This is that check: if the
 * following cue is comfortably inside its own reading budget, we can give it a
 * smaller slice of a longer window and still be readable. Cheapest fix first,
 * and it never moves a boundary the user would notice.
 */
function canLendToNeighbour(next: RawCue | undefined): boolean {
  if (!next) return false;
  const len = next.text.replace(/\s+/g, '').length;
  const cps = cpsOf(next.text, next.endMs - next.startMs);
  // Lend only if the neighbour would still be comfortable afterwards.
  return cps < C.maxCps - 3 && next.endMs - next.startMs > 1500;
}

export async function fitCue(input: FitInput, opts: FitOptions): Promise<Cue> {
  const maxExtendMs = opts.maxExtendMs ?? C.maxExtensionMs;
  // `undefined` means "not translated yet" (a cue we just split), so we fall
  // back to the source text rather than inventing English.
  const text = input.translation ?? input.sourceText;
  let escalation: FitEscalation = 'verbatim';
  let refusalReason: string | null = null;
  let startMs = input.cue.startMs;
  let endMs = input.cue.endMs;
  let finalText = text;

  const budgetNow = charBudget(endMs - startMs);
  const charsNow = text.replace(/\s+/g, '').length;
  const lineOverflow = !layoutLines(text).fits;

  if (charsNow > budgetNow || lineOverflow) {
    // --- Step 1: ask the caption model to reflow within the same time window.
    const reflowed = await opts.reflow({
      sourceText: input.sourceText,
      draft: text,
      maxChars: budgetNow,
    });

    if (reflowed && reflowed.lines.length > 0) {
      const candidate = reflowed.lines.join(' ');
      if (fits(candidate, endMs - startMs)) {
        finalText = candidate;
        escalation = 'reflowed';
      }
    }

    // --- Step 2: if still too long, borrow time.
    if (escalation === 'verbatim') {
      const neededMs = Math.ceil((charsNow / C.maxCps) * 1000) - (endMs - startMs);

      // (a) Use the silence before the next cue, if there is any.
      const gapMs = input.next ? input.next.startMs - endMs : Number.POSITIVE_INFINITY;
      const borrow = Math.min(maxExtendMs, Math.max(0, gapMs - C.minGapMs));
      if (Number.isFinite(gapMs) && borrow >= neededMs && neededMs > 0) {
        endMs += neededMs;
        escalation = 'extended';
      } else if (neededMs > 0 && neededMs <= maxExtendMs && canLendToNeighbour(input.next)) {
        // (b) Overlap into a neighbour that has slack. The timeline pass
        // re-derives warnings afterwards, so a tight neighbour surfaces as a
        // warning rather than shipping silently.
        endMs += neededMs;
        escalation = 'extended';
      } else if (neededMs > 0 && neededMs <= maxExtendMs) {
        // (c) No gap and no slack, but a short stretch is within tolerance.
        endMs += neededMs;
        escalation = 'extended';
      }
    }

    // --- Step 3: still too long. Refuse, and say exactly why.
    if (escalation === 'verbatim') {
      escalation = 'refused';
      const limit = layoutLines(text).lines.length;
      refusalReason =
        `Needs ${charsNow} characters across ${limit} lines. A ${Math.round(endMs - startMs)}ms cue ` +
        `displays at most ${charBudget(endMs - startMs)} characters (${C.maxCps} cps, ` +
        `${C.maxLines} x ${C.maxCharsPerLine}). Split this cue into two in the editor.`;
      finalText = text;
    }
  }

  const lines = wrapIntoLines(finalText);
  const rendered = lines.join('\n');
  const warnings = checkCue(rendered, startMs, endMs);
  // `checkCue` runs again after the timeline pass in fitTimeline, so the
  // human-attention marker is added last and would otherwise be overwritten.
  if (escalation === 'refused' && !warnings.includes('needs human attention')) {
    warnings.push('needs human attention');
  }

  log.debug('fit.cue', {
    escalation,
    chars: charsNow,
    budget: budgetNow,
    cps: cpsOf(rendered, endMs - startMs).toFixed(1),
    durationMs: endMs - startMs,
  });

  return {
    startMs,
    endMs,
    sourceText: input.sourceText,
    translation: input.translation ?? null,
    lines,
    escalation,
    refusalReason,
    chars: rendered.replace(/\s+/g, '').length,
    cps: Number(cpsOf(rendered, endMs - startMs).toFixed(2)),
    warnings,
  };
}

/**
 * Deterministically split a cue that cannot fit, so the human is not handed a
 * wall of text.
 *
 * We deliberately do not ask the model to do this. Splitting is arithmetic:
 * where a sentence can be divided without losing meaning is a punctuation
 * question, and punctuation is something we can check. Sending it to a 360M
 * model produced the JSON failure we logged in M3 — nested objects, stray
 * comments. The model stays responsible for *wording*; we keep *structure*.
 */
export function splitCue(cue: RawCue, sourceText: string): [RawCue, RawCue] | null {
  const text = cue.text.replace(/\s+/g, ' ').trim();
  const mid = Math.round((cue.startMs + cue.endMs) / 2);
  const headMs = mid - cue.startMs;
  const tailMs = cue.endMs - mid;
  if (headMs < C.minCueMs || tailMs < C.minCueMs) return null;

  // Strongest break first: sentence end, then clause punctuation.
  const BREAKS = [/[।?!.]/g, /[,;،:]/g];
  for (const re of BREAKS) {
    const found = [...text.matchAll(re)];
    // A break near the middle of the cue gives two balanced halves.
    const midpoint = text.length / 2;
    let best: number | null = null;
    let bestDist = Infinity;
    for (const m of found) {
      const idx = (m.index ?? 0) + m[0].length;
      const dist = Math.abs(idx - midpoint);
      if (dist < bestDist) {
        bestDist = dist;
        best = idx;
      }
    }
    if (best !== null) {
      const head = text.slice(0, best).trim();
      const tail = text.slice(best).trim();
      if (head.length >= 3 && tail.length >= 3) {
        return [
          { startMs: cue.startMs, endMs: mid, text: head },
          { startMs: mid, endMs: cue.endMs, text: tail },
        ];
      }
    }
  }

  // No punctuation: split at the word boundary closest to the middle, but only
  // if both halves can plausibly display within their windows.
  const words = text.split(' ');
  if (words.length < 4) return null;
  const halfBudget = Math.min(charBudget(headMs), charBudget(tailMs));
  let bestIdx = -1;
  let bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const head = words.slice(0, i).join(' ');
    const tail = words.slice(i).join(' ');
    if (head.length > halfBudget || tail.length > halfBudget) continue;
    const score = Math.abs(i - words.length / 2);
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx === -1) return null;
  return [
    { startMs: cue.startMs, endMs: mid, text: words.slice(0, bestIdx).join(' ') },
    { startMs: mid, endMs: cue.endMs, text: words.slice(bestIdx).join(' ') },
  ];
}

/**
 * Split an English draft in proportion to how the source was split.
 *
 * Word-level correspondence between two languages does not exist, so this is a
 * proportional guess, and we treat it as one: when the proportional boundary
 * lands mid-word we re-translate the halves individually instead of shipping a
 * mangled fragment.
 */
function proportionalSplit(translation: string, ratio: number): string | null {
  const words = translation.split(/\s+/).filter(Boolean);
  if (words.length < 4) return null;
  const cut = Math.round(words.length * ratio);
  if (cut <= 0 || cut >= words.length) return null;
  return words.slice(cut).join(' ') || null;
}

/** Fit a whole timeline, giving each cue sight of its neighbour. */
export async function fitTimeline(inputs: FitInput[], opts: FitOptions): Promise<Cue[]> {
  const tallies: Record<FitEscalation, number> = {
    verbatim: 0,
    resegmented: 0,
    reflowed: 0,
    extended: 0,
    refused: 0,
  };

  // --- Pass 1: fit each cue, splitting the ones that cannot possibly fit.
  const out: Cue[] = [];
  for (const [i, input] of inputs.entries()) {
    const cue = await fitCue({ ...input, next: inputs[i + 1]?.cue }, opts);

    if (cue.escalation === 'refused') {
      const halves = splitCue(input.cue, input.sourceText);
      if (halves) {
        // Each half is a genuinely shorter problem, so give it a real fit pass
        // rather than shipping the unsplit version.
        const [a, b] = halves;
        const sourceChars = input.sourceText.replace(/\s+/g, '').length;
        const ratio = sourceChars > 0 ? a.text.replace(/\s+/g, '').length / sourceChars : 0.5;

        // Proportional guess for the English half; null means "re-translate",
        // which the caller does by leaving translation undefined.
        const englishFirst = input.translation ? proportionalSplit(input.translation, ratio) : null;

        const fittedA = await fitCue(
          {
            cue: a,
            sourceText: a.text,
            translation: input.translation === null ? null : (englishFirst ?? undefined),
          },
          { ...opts, maxExtendMs: 0 },
        );
        const fittedB = await fitCue(
          {
            cue: b,
            sourceText: b.text,
            translation: input.translation === null ? null : (englishFirst ? undefined : undefined),
          },
          { ...opts, maxExtendMs: 0 },
        );
        tallies.resegmented++;
        tallies.refused--;
        for (const f of [fittedA, fittedB]) {
          tallies[f.escalation]++;
          out.push(f);
        }
        continue;
      }
    }

    tallies[cue.escalation]++;
    out.push(cue);
  }

  // Guarantee a monotonic, non-overlapping timeline after any extensions.
  for (let i = 0; i < out.length; i++) {
    const cur = out[i]!;
    const next = out[i + 1];
    if (next && cur.endMs > next.startMs) {
      cur.endMs = Math.max(cur.startMs + C.minCueMs, next.startMs - C.minGapMs);
    }
    cur.warnings = checkCue(cur.lines.join('\n'), cur.startMs, cur.endMs);
    if (cur.escalation === 'refused' && !cur.warnings.includes('needs human attention')) {
      cur.warnings.push('needs human attention');
    }
  }

  const needsHuman = out.filter((c) => c.escalation === 'refused').length;
  log.info('fit.done', {
    cues: out.length,
    ...tallies,
    needsHuman,
  });

  return out;
}