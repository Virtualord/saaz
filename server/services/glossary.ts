import { log } from '../core/logger.js';

/**
 * A glossary for terms the models demonstrably get wrong.
 *
 * This exists because of a measured failure, not a hypothetical one: open
 * Hindi→English models translate `मालाई` (malai, the sweet) as "by Miley", and
 * `मालाई` in a sentence produces fluent nonsense. No amount of prompting fixes
 * a vocabulary gap, and a closed API would fail the same way — it simply hides
 * the failure instead of letting us pin the answer.
 *
 * For a user who captions local businesses repeatedly, the set of names that
 * matter is small, known, and stable. That is exactly the kind of customisation
 * that open weights plus an in-process glossary makes possible.
 */

export interface GlossaryEntry {
  /** Term as it appears in the source language. */
  source: string;
  /** How it must appear in the English caption. */
  target: string;
  /** Optional note shown in the UI so the user knows why the pin exists. */
  note?: string;
}

export interface Glossary {
  entries: GlossaryEntry[];
}

export const DEFAULT_GLOSSARY: Glossary = {
  entries: [
    { source: 'मालाई', target: 'Malai', note: 'Malai, the thickened-milk sweet sold here.' },
    { source: 'मिठाई', target: 'sweets', note: 'Generic term for Indian sweets.' },
    { source: 'दुकान', target: 'shop' },
    { source: 'रुपये', target: 'rupees' },
    { source: 'किलो', target: 'kg' },
  ],
};

/**
 * Replace pinned source terms with their required English rendering before
 * translation.
 *
 * Longest match wins, so a glossary containing both "दुकान" and "मिठाई की
 * दुकान" resolves the specific phrase rather than the generic word.
 */
export function applyGlossary(sourceText: string, glossary: Glossary): string {
  const entries = [...glossary.entries]
    .filter((e) => e.source.trim().length > 0)
    .sort((a, b) => b.source.length - a.source.length);

  if (entries.length === 0) return sourceText;

  let out = sourceText;
  let applied = 0;
  for (const entry of entries) {
    if (!out.includes(entry.source)) continue;
    const before = out;
    // Split/join rather than a global regex so we do not need to escape the
    // term's characters, which are Devanagari and regex-significant.
    out = out.split(entry.source).join(entry.target);
    if (out !== before) applied++;
  }

  if (applied > 0) {
    log.debug('glossary.applied', { applied, of: entries.length, sample: out.slice(0, 80) });
  }
  return out;
}

/** Which glossary entries actually fired on this text. Surfaced in the UI. */
export function glossaryHits(sourceText: string, glossary: Glossary): string[] {
  return glossary.entries.filter((e) => sourceText.includes(e.source)).map((e) => e.source);
}