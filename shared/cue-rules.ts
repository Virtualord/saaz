import { subtitleConstraints as C } from './types.js';
import type { Cue } from './types.js';

/**
 * Subtitle rules shared by the server and the browser.
 *
 * This module is imported by both `server/services/segmenter.ts` and the React
 * editor, and it deliberately contains no Node-only imports. An earlier version
 * had the editor import the server's segmenter directly, which pulled
 * `process.env` through `config.ts` into the browser bundle and threw
 * `ReferenceError: process is not defined` at runtime.
 *
 * Keep this file dependency-free and platform-neutral.
 */

export interface CueLayout {
  lines: string[];
  /** False when the result would violate the line-count or line-width limits. */
  fits: boolean;
}

const HARD_BREAKS = /[।?!.]/;
const SOFT_BREAKS = /[,;،:]/;

/**
 * Wrap into at most two balanced lines.
 *
 * Guarantee: no returned line is ever wider than `maxChars`. When the text
 * genuinely needs more than two lines, the result is a flat hard-wrapped list
 * and `fits` is false — callers must check `fits` rather than assume two lines.
 *
 * The width guarantee is unconditional, because the earlier version leaked a
 * 149-character line for 60 repeated words and a unit test caught it.
 */
export function layoutLines(text: string, maxChars = C.maxCharsPerLine): CueLayout {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return { lines: [clean], fits: true };

  // Step 1: break any single word too long to ever fit on a line.
  let prepared = clean;
  if (clean.split(' ').some((w) => w.length > maxChars)) {
    const parts: string[] = [];
    for (const w of clean.split(' ')) {
      if (w.length > maxChars) {
        for (let i = 0; i < w.length; i += maxChars) parts.push(w.slice(i, i + maxChars));
      } else {
        parts.push(w);
      }
    }
    prepared = parts.join(' ');
  }

  // Step 2: try a balanced two-line split.
  const ideal = Math.ceil(prepared.length / 2);
  let line1 = '';
  for (const w of prepared.split(' ')) {
    if (line1.length === 0) line1 = w;
    else if (line1.length + 1 + w.length <= ideal) line1 += ' ' + w;
    else break;
  }
  line1 = line1.trim();
  const line2 = prepared.slice(line1.length).trim();

  if (line1.length <= maxChars && line2.length <= maxChars && line2.length > 0) {
    return { lines: [line1, line2], fits: true };
  }
  if (line2.length === 0 && line1.length <= maxChars) {
    return { lines: [line1], fits: true };
  }

  // Step 3: does not fit in two lines. Hard-wrap flat, so no line is too wide.
  return { lines: wrapFlat(prepared, maxChars), fits: false };
}

/** Hard-wrap flat text into pieces no wider than `maxChars`. */
export function wrapFlat(text: string, maxChars = C.maxCharsPerLine): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(' ').filter(Boolean)) {
    if (cur.length === 0) cur = w;
    else if (cur.length + 1 + w.length <= maxChars) cur += ' ' + w;
    else {
      out.push(cur);
      cur = w;
    }
    while (cur.length > maxChars) {
      out.push(cur.slice(0, maxChars));
      cur = cur.slice(maxChars);
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** How many display lines this text needs. */
export function linesNeeded(text: string, maxChars = C.maxCharsPerLine): number {
  return layoutLines(text, maxChars).lines.length;
}

/** Readable characters per second. */
export function cpsOf(text: string, durationMs: number): number {
  if (durationMs <= 0) return Infinity;
  return text.replace(/\s+/g, '').length / (durationMs / 1000);
}

/**
 * Every readability violation for one cue, as human-readable warnings.
 * An empty array means the cue is broadcast-safe by these rules.
 */
export function checkCue(text: string, startMs: number, endMs: number): string[] {
  const warnings: string[] = [];
  const lines = text.split('\n');
  const durationMs = endMs - startMs;

  if (lines.length > C.maxLines) warnings.push(`${lines.length} lines (max ${C.maxLines})`);
  for (const line of lines) {
    if (line.length > C.maxCharsPerLine) {
      warnings.push(`line too long: ${line.length} chars (max ${C.maxCharsPerLine})`);
    }
  }
  const cps = cpsOf(text, durationMs);
  if (cps > C.maxCps) warnings.push(`too fast to read: ${cps.toFixed(1)} cps (max ${C.maxCps})`);
  if (durationMs < C.minCueMs) warnings.push(`very short: ${durationMs}ms`);
  if (text.trim().length === 0) warnings.push('empty cue');
  return warnings;
}

/** Characters a cue of this duration may display. */
export function charBudget(durationMs: number): number {
  const byReadingSpeed = Math.floor((C.maxCps * Math.max(0, durationMs)) / 1000);
  const byLayout = C.maxLines * C.maxCharsPerLine;
  return Math.max(8, Math.min(byLayout, byReadingSpeed));
}

export { HARD_BREAKS, SOFT_BREAKS };