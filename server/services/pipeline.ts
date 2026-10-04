import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';
import { log } from '../core/logger.js';
import { withSpan, withTrace, noteUserVisibleFailure, currentContext } from '../core/tracing.js';
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

/**
 * The pipeline.
 *
 * Deliberately a straight line, because it has to be explainable in a write-up
 * and debuggable at 2am before a demo:
 *
 *   probe -> decode -> ASR -> VAD -> align -> segment -> glossary -> MT -> fit
 *
 * Every stage is a traced span, so one request produces exactly one trace whose
 * shape matches that sentence. Stage timings are also returned in the response so
 * the UI can show where the time went without needing a tracing backend.
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
  traceId: string;
  meta: {
    durationMs: number;
    audioCodec?: string;
    hasVideo: boolean;
    speechRegions: number;
    needsHuman: number;
    glossaryApplied: string[];
    /** True when every model ran from local weights with no network. */
    offline: boolean;
    /** Counts that make model quality visible without reading logs. */
    transcriptChars: number;
    droppedHallucinations: number;
    timestampMode: 'word' | 'segment';
  };
}

export async function runPipeline(req: PipelineRequest): Promise<PipelineResult> {
  const selection: ModelSelection = { ...defaultSelection(), ...req.models };
  const glossary = req.glossary ?? DEFAULT_GLOSSARY;
  const stageMs: Record<string, number> = {};

  return withTrace(
    'pipeline.generate_subtitles',
    { userInput: `${req.sourceName} (${req.pair})`, attributes: { pair: req.pair, models: selection } },
    async (root) => {
      /** Time a stage and record it as a child span. */
      const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
        const t0 = Date.now();
        return withSpan(name, { kind: 'tool' }, fn).finally(() => {
          stageMs[name] = Date.now() - t0;
        });
      };

      const info = await stage('probe', () => probeMedia(req.inputPath));
      const audio = await stage('decode', () => decodeToFloat32(req.inputPath));

      const asr = await stage('transcribe', () =>
        transcribe(audio, { language: req.pair.split('-')[0]!, modelId: selection.asr! }),
      );

      const { regions, aligned } = await stage('vad_align', async () => {
        const regions = await detectSpeech(audio);
        const aligned = alignToRegions(asr.segments, regions);
        return { regions, aligned };
      });

      const rawCues = await stage('segment', async () => segment(aligned));

      // Pinned terms are substituted in the source text before translation, so the
      // MT model sees a term it can carry rather than inventing one.
      const prepared = await stage('glossary', async () => {
        const withGlossary = rawCues.map((c) => ({
          ...c,
          text: applyGlossary(c.text.replace('\n', ' '), glossary),
        }));
        const hits = [...new Set(withGlossary.flatMap((c) => glossaryHits(c.text, glossary)))];
        return { withGlossary, hits };
      });
      const glossaryApplied = prepared.hits;

      const fitInputs: FitInput[] = prepared.withGlossary.map((cue, i) => ({
        cue,
        sourceText: cue.text,
        translation: null,
      }));

      // Retrying this: a transient MT failure should not throw away the whole job.
      const t5 = Date.now();
      const translations = await stage('translate', () =>
        translateBatch(
          prepared.withGlossary.map((c) => c.text),
          req.pair,
          selection.mt!,
        ),
      );
      stageMs.translate = Date.now() - t5;
      fitInputs.forEach((f, i) => {
        f.translation = translations[i] ?? null;
      });

      const reflow = async ({ sourceText, draft, maxChars }: { sourceText: string; draft: string; maxChars: number }) =>
        reflowCaption({ sourceText, draft, maxChars, modelId: selection.caption! });

      let cues = await stage('fit', () => fitTimeline(fitInputs, { reflow }));

      // Pass 2: a cue that was split has halves we have never translated. Catch
      // them up here rather than emitting source text as if it were a caption.
      const untranslated = cues.filter(
        (c) => c.translation === null && req.pair !== 'en-en' && c.sourceText.trim().length > 0,
      );
      if (untranslated.length > 0) {
        const t6 = Date.now();
        const retry = await stage('translate_split_halves', () =>
          translateBatch(
            untranslated.map((c) => c.sourceText),
            req.pair,
            selection.mt!,
          ),
        );
        let idx = 0;
        cues = await fitTimeline(
          cues.map((c) => {
            if (!untranslated.includes(c)) return { cue: rawOf(c), sourceText: c.sourceText, translation: c.translation };
            return { cue: rawOf(c), sourceText: c.sourceText, translation: retry[idx++] ?? null };
          }),
          { reflow },
        );
        stageMs.fit = Date.now() - t6;
      }

      const needsHuman = cues.filter((c) => c.escalation === 'refused').length;
      root.setAll({
        durationMs: info.durationMs,
        cueCount: cues.length,
        needsHuman,
        stageMs,
        modelsUsed: { ...selection },
      });
      if (needsHuman > 0) {
        // A refusal is a failure the user must act on, so it is recorded as
        // user-visible rather than silently swallowed.
        noteUserVisibleFailure(root.traceId, `${needsHuman} cue(s) could not be fitted automatically`);
        root.event('cues_need_human', { count: needsHuman });
      }
      root.set('outcome', `${cues.length} cues, ${needsHuman} need human review`);

      log.info('pipeline.done', {
        traceId: root.traceId,
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
        traceId: root.traceId,
        meta: {
          durationMs: info.durationMs,
          audioCodec: info.audioCodec,
          hasVideo: info.hasVideo,
          speechRegions: regions.length,
          needsHuman,
          glossaryApplied,
          offline: true,
          transcriptChars: asr.segments.reduce((n, s) => n + s.text.length, 0),
          droppedHallucinations: asr.droppedHallucinations,
          timestampMode: asr.timestampMode,
        },
      };
    },
  );
}

/** Rebuild a RawCue from a finished Cue so the fitter can work on it again. */
function rawOf(c: Cue): RawCue {
  return { startMs: c.startMs, endMs: c.endMs, text: c.lines.join('\n') };
}

/** Render cues as SubRip. */
export function toSrt(cues: Cue[]): string {
  const fmt = (ms: number): string => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  return cues.map((c, i) => `${i + 1}\n${fmt(c.startMs)} --> ${fmt(c.endMs)}\n${c.lines.join('\n')}\n`).join('\n');
}

/** Render cues as WebVTT, with per-cue warnings as comments for the editor. */
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