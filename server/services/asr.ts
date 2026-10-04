import { loadModel } from '../models/loader.js';
import { findModel } from '../models/registry.js';
import { log } from '../core/logger.js';
import { withSpan } from '../core/tracing.js';
import type { Segment } from '../../shared/types.js';

/**
 * Whisper ASR via transformers.js, on CPU, from open MIT weights.
 *
 * Two things here are load-bearing for subtitle quality rather than
 * convenience:
 *
 *  1. Word-level timestamps. Whisper's segment timestamps are far too coarse
 *     for subtitles (a segment can span fifteen seconds). Cue boundaries need
 *     word timings, so we ask for them and fall back explicitly if unavailable.
 *
 *  2. Hallucination filtering. Whisper reliably invents text over silence and
 *     music, which would otherwise appear in our deliverable as confident
 *     nonsense. We drop those runs rather than shipping them.
 */

export interface AsrResult {
  segments: Segment[];
  language: string;
  /** Which timestamp path we actually got. Surfaced in the UI for honesty. */
  timestampMode: 'word' | 'segment';
  audioMs: number;
  audioSeconds: number;
  rawSegmentCount: number;
  droppedHallucinations: number;
}

interface RawChunk {
  text?: string;
  timestamp?: [number | null, number | null];
  avg_logprob?: number;
  no_speech_prob?: number;
}

function toMs(seconds: number | null | undefined): number {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.round(seconds * 1000));
}

/**
 * Whisper's known failure: over silence or music it emits a plausible-looking
 * phrase, and in the degenerate case repeats one token dozens of times. We
 * learned this the hard way in M1: a 29s clip ended with a single segment of
 * "अपने अपने अपने..." repeated 100+ times, past the end of the audio.
 *
 * Comparing against the previous segment was not enough, because the degenerate
 * run is one single segment. So we also test internal repetition directly.
 */
function markHallucinations(segments: Segment[], audioMs: number): Segment[] {
  return segments.map((seg) => {
    const trimmed = seg.text.trim();
    const normalised = trimmed.toLowerCase();
    const prev = segments.find((s) => s.startMs < seg.startMs)?.text.trim().toLowerCase() ?? '';

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const unique = new Set(tokens.map((t) => t.toLowerCase()));
    const repetitionRatio = tokens.length > 0 ? unique.size / tokens.length : 1;

    const reasons: string[] = [];
    if (trimmed && normalised === prev) reasons.push('repeat_of_previous');
    // A long run where almost every token is the same word is never real speech.
    if (tokens.length >= 8 && repetitionRatio < 0.3) reasons.push('internal_repetition');
    // Whisper sometimes runs its clock past the end of the audio on trailing
    // silence, which is where the degenerate run above appeared.
    if (audioMs > 0 && seg.startMs > audioMs + 400) reasons.push('past_audio_end');
    if (trimmed && seg.endMs - seg.startMs < 150 && seg.asrConfidence !== null && seg.asrConfidence < 0.35) {
      reasons.push('short_and_unsure');
    }

    if (reasons.length > 0) {
      log.debug('asr.dropped', { startMs: seg.startMs, chars: trimmed.length, reasons });
    }

    return {
      ...seg,
      suspectedHallucination: trimmed.length > 0 && reasons.length > 0,
    };
  });
}

/**
 * The narrow contract we rely on from the ASR pipeline. transformers.js types
 * `pipeline()` as a union of all supported tasks, so each call site casts to
 * what it actually uses instead of reaching for `any`.
 */
type AsrPipeline = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text?: string; chunks?: RawChunk[] }>;

export async function transcribe(
  audio: Float32Array,
  opts: { language: string; modelId: string; translateToEnglish?: boolean },
): Promise<AsrResult> {
  const model = findModel('asr', opts.modelId);

  return withSpan(
    'model.transcribe',
    {
      kind: 'model',
      attributes: {
        slot: 'asr',
        modelId: model.id,
        license: model.license,
        dtype: model.dtype,
        language: opts.language,
        audioSeconds: Math.round((audio.length / 16000) * 10) / 10,
        task: opts.translateToEnglish ? 'translate' : 'transcribe',
      },
    },
    async (span) => {
      const pipe = (await loadModel('asr', opts.modelId)) as unknown as AsrPipeline;

      const common = {
        chunk_length_s: 30,
        stride_length_s: 5,
        // Forcing the language avoids Whisper misdetecting short clips, which is
        // common and would silently produce the wrong script.
        language: opts.language,
        task: opts.translateToEnglish ? ('translate' as const) : ('transcribe' as const),
      };

      let raw: { text?: string; chunks?: RawChunk[] };
      let timestampMode: 'word' | 'segment' = 'word';

      try {
        raw = await pipe(audio, { ...common, return_timestamps: 'word' });
        if (!raw.chunks?.length) throw new Error('no word chunks returned');
      } catch (err) {
        // Not fatal: this ONNX export genuinely cannot emit word timestamps, so
        // the VAD stage supplies real boundaries instead.
        span.event('word_timestamps_unavailable', {
          reason: err instanceof Error ? err.message.slice(0, 120) : String(err),
          mitigation: 'falling back to segment timings, then VAD alignment',
        });
        log.warn('asr.word_timestamps_unavailable', {
          model: model.id,
          err: err instanceof Error ? err.message : String(err),
        });
        raw = await pipe(audio, { ...common, return_timestamps: true });
        timestampMode = 'segment';
      }

      span.set('timestampMode', timestampMode);

      const chunks = raw.chunks ?? [];
      const segments: Segment[] = chunks
        .map((c) => {
          const [start, end] = c.timestamp ?? [];
          const text = (c.text ?? '').trim();
          // avg_logprob is a log probability; exp() puts it back on 0..1.
          const conf = typeof c.avg_logprob === 'number' ? Math.min(1, Math.max(0, Math.exp(c.avg_logprob))) : null;
          return {
            startMs: toMs(start),
            endMs: toMs(end) || toMs(start) + 400,
            text,
            asrConfidence: conf,
            suspectedHallucination: false,
          };
        })
        // Whisper emits timestamp-only chunks with empty text; they carry no signal.
        .filter((s) => s.text.length > 0)
        // A zero-width span cannot be displayed, so give it a minimal readable width.
        .map((s) => (s.endMs <= s.startMs ? { ...s, endMs: s.startMs + 600 } : s));

      const audioMsTotal = Math.round((audio.length / 16000) * 1000);
      const filtered = markHallucinations(segments, audioMsTotal).filter((s) => !s.suspectedHallucination);
      const dropped = segments.length - filtered.length;

      span.setAll({
        rawSegments: segments.length,
        keptSegments: filtered.length,
        droppedHallucinations: dropped,
        transcriptChars: filtered.reduce((n, s) => n + s.text.length, 0),
      });
      if (dropped > 0) span.event('hallucinations_dropped', { count: dropped });

      log.info('asr.done', {
        model: model.id,
        license: model.license,
        timestampMode,
        rawSegments: segments.length,
        droppedHallucinations: dropped,
        kept: filtered.length,
      });

      return {
        segments: filtered,
        language: opts.language,
        timestampMode,
        audioMs: audioMsTotal,
        audioSeconds: Math.round((audio.length / 16000) * 10) / 10,
        rawSegmentCount: segments.length,
        droppedHallucinations: dropped,
      };
    },
  );
}