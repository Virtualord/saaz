import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { log, timed } from '../core/logger.js';
import { probeMedia, decodeToFloat32 } from './media.js';
import { transcribe } from './asr.js';
import { detectSpeech } from './vad.js';
import { alignToRegions } from './align.js';
import { segment, checkCue, type RawCue } from './segmenter.js';
import { fitTimeline, type FitInput } from './fit.js';
import { translateBatch } from './translate.js';
import { reflowCaption } from './caption.js';
import { applyGlossary, DEFAULT_GLOSSARY, glossaryHits, type Glossary } from './glossary.js';
import { defaultSelection, type ModelSelection } from '../models/registry.js';
import type { Cue, LanguagePair, Segment } from '../../shared/types.js';
import { JobSchema, type Job } from '../../shared/types.js';
import { z } from 'zod';

/**
 * The pipeline.
 *
 * Deliberately a straight line, because it has to be explainable in a write-up
 * and debuggable at 2am before a demo:
 *
 *   probe -> decode -> ASR -> VAD -> align -> segment -> glossary -> MT -> fit
 *
 * Every stage reports its own duration, and the stage timings are returned with
 * the result so the UI can show where the time actually went.
 */

export interface PipelineRequest {
  inputPath: string;
  sourceName: string;
  pair: LanguagePair;
  models?: Partial<ModelSelection>;
  glossary?: Glossary;
}

export interface PipelineResult {
  segments: Segment[];
  cues: Cue[];
  stageMs: Record<string, number>;
  modelsUsed: Record<string, string>;
  meta: {
    durationMs: number;
    audioCodec?: string;
    hasVideo: boolean;
    speechRegions: number;
    needsHuman: number;
    glossaryApplied: string[];
    /** True when every model ran from local weights with no network. */
    offline: boolean;
  };
}

export async function runPipeline(req: PipelineRequest): Promise<PipelineResult> {
  const selection: ModelSelection = { ...defaultSelection(), ...req.models };
  const glossary = req.glossary ?? DEFAULT_GLOSSARY;
  const stageMs: Record<string, number> = {};
  const mark = (name: string, ms: number) => {
    stageMs[name] = ms;
  };

  const t0 = Date.now();
  const info = await probeMedia(req.inputPath);
  mark('probe', Date.now() - t0);

  const t1 = Date.now();
  const audio = await decodeToFloat32(req.inputPath);
  mark('decode', Date.now() - t1);

  const t2 = Date.now();
  const asr = await timed('pipeline.asr', { model: selection.asr }, () =>
    transcribe(audio, {
      language: req.pair.split('-')[0]!,
      modelId: selection.asr!,
    }),
  );
  mark('transcribe', Date.now() - t2);

  const t3 = Date.now();
  const regions = await detectSpeech(audio);
  const aligned = alignToRegions(asr.segments, regions);
  mark('vad_align', Date.now() - t3);

  const t4 = Date.now();
  const rawCues = segment(aligned);
  mark('segment', Date.now() - t4);

  // Pinned terms are substituted in the source text before translation, so the
  // MT model sees a term it can carry rather than inventing one.
  const prepared = rawCues.map((c) => ({
    ...c,
    text: applyGlossary(c.text.replace('\n', ' '), glossary),
  }));
  const glossaryApplied = [...new Set(prepared.flatMap((c) => glossaryHits(c.text, glossary)))];

  const t5 = Date.now();
  const translations = await translateBatch(
    prepared.map((c) => c.text),
    req.pair,
    selection.mt!,
  );
  mark('translate', Date.now() - t5);

  // Fit the original cues first. Any cue that cannot fit may be split, and its
  // halves then need translating, so this is genuinely two passes over the text.
  const fitInputs: FitInput[] = prepared.map((cue, i) => ({
    cue,
    sourceText: cue.text,
    translation: translations[i] ?? null,
  }));

  const reflow = async ({ sourceText, draft, maxChars }: { sourceText: string; draft: string; maxChars: number }) =>
    reflowCaption({ sourceText, draft, maxChars, modelId: selection.caption! });

  const t6 = Date.now();
  let cues = await fitTimeline(fitInputs, { reflow });

  // Pass 2: translate the source of any cue we could not translate before
  // splitting, then refit it.
  const untranslated = cues.filter((c) => c.translation === null && req.pair !== 'en-en' && c.sourceText.trim().length > 0);
  if (untranslated.length > 0) {
    const retry = await translateBatch(
      untranslated.map((c) => c.sourceText),
      req.pair,
      selection.mt!,
    );
    let idx = 0;
    cues = await fitTimeline(
      cues.map((c) => {
        if (!untranslated.includes(c)) return { cue: rawOf(c), sourceText: c.sourceText, translation: c.translation };
        const t = retry[idx++] ?? null;
        return { cue: rawOf(c), sourceText: c.sourceText, translation: t };
      }),
      { reflow },
    );
    mark('translate_split_halves', Date.now() - t6);
  }
  mark('fit', Date.now() - t6);

  /** Rebuild a RawCue from a finished Cue so the fitter can work on it again. */
  function rawOf(c: Cue): RawCue {
    return { startMs: c.startMs, endMs: c.endMs, text: c.lines.join('\n') };
  }

  const needsHuman = cues.filter((c) => c.escalation === 'refused').length;
  log.info('pipeline.done', {
    source: req.sourceName,
    durationMs: info.durationMs,
    cues: cues.length,
    needsHuman,
    stageMs,
  });

  return {
    segments: aligned,
    cues,
    stageMs,
    modelsUsed: { asr: selection.asr!, mt: selection.mt!, caption: selection.caption! },
    meta: {
      durationMs: info.durationMs,
      audioCodec: info.audioCodec,
      hasVideo: info.hasVideo,
      speechRegions: regions.length,
      needsHuman,
      glossaryApplied,
      offline: true,
    },
  };
}

/** Render cues as SubRip. */
export function toSrt(cues: Cue[]): string {
  const fmt = (ms: number): string => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  return cues
    .map((c, i) => `${i + 1}\n${fmt(c.startMs)} --> ${fmt(c.endMs)}\n${c.lines.join('\n')}\n`)
    .join('\n');
}

/** Render cues as WebVTT, with the per-cue warnings as comments for the editor. */
export function toVtt(cues: Cue[]): string {
  // WebVTT is `HH:MM:SS.mmm` — one digit of milliseconds, not three like SRT.
  const fmt = (ms: number): string => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  };
  const header = 'WEBVTT\n\nNOTE Generated by Saaz. Run entirely on open-weight models.\n\n';
  return (
    header +
    cues
      .map((c, i) => {
        const note = c.warnings.length > 0 ? `NOTE ${c.warnings.join('; ')}\n` : '';
        return `${note}${i + 1}\n${fmt(c.startMs)} --> ${fmt(c.endMs)}\n${c.lines.join('\n')}\n`;
      })
      .join('\n')
  );
}

/** Every constraint violation across the timeline, for the QA panel. */
export function auditCues(cues: Cue[]): Array<{ index: number; warnings: string[] }> {
  return cues
    .map((c, index) => ({ index, warnings: checkCue(c.lines.join('\n'), c.startMs, c.endMs) }))
    .filter((r) => r.warnings.length > 0);
}