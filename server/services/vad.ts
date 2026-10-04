import path from 'node:path';
import fs from 'node:fs';
import * as ort from 'onnxruntime-node';
import { config } from '../config.js';
import { log } from '../core/logger.js';

/**
 * Voice activity detection with Silero VAD (MIT), run directly on
 * onnxruntime-node.
 *
 * Why this exists, concretely: in M1 our Whisper ONNX export turned out to lack
 * cross-attention outputs, so it could not produce word timestamps and its
 * segment timings collapsed into uniform 3-second blocks that matched nothing in
 * the audio. Subtitle cues built on those timings would have been visibly wrong.
 * Cue boundaries are fundamentally a speech-boundary problem, so we solve it
 * with a real VAD instead of pretending the timings were good enough.
 *
 * transformers.js 4.3.0 ships no VAD pipeline, and the ONNX repo has no
 * config.json, so we drive the graph ourselves: a 512-sample window (32ms at
 * 16kHz) at a time, carrying the recurrent state between windows.
 *
 * If this model is unavailable we fall back to energy-based detection, because a
 * degraded cue boundary is far better than a broken pipeline.
 */

export interface SpeechRegion {
  startMs: number;
  endMs: number;
}

export const VAD_MODEL_ID = 'onnx-community/silero-vad';
export const VAD_LICENSE = 'MIT';
const VAD_WINDOW = 512; // samples, i.e. 32ms at 16kHz
const SAMPLE_RATE = 16000;

function localVadPath(): string {
  return path.join(config.paths.modelDir, 'silero-vad', 'model_int8.onnx');
}

export function vadAvailable(): boolean {
  const p = localVadPath();
  return fs.existsSync(p) && fs.statSync(p).size > 10_000;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    const file = localVadPath();
    sessionPromise = ort.InferenceSession.create(file).catch((err) => {
      sessionPromise = null;
      throw new Error(`Silero VAD session failed to load from ${file}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
  return sessionPromise;
}

/** Per-window speech probabilities from the stateful Silero graph. */
async function sileroProbabilities(audio: Float32Array): Promise<Float32Array> {
  const session = await getSession();
  const numWindows = Math.max(1, Math.ceil(audio.length / VAD_WINDOW));
  const probs = new Float32Array(numWindows);
  let state = new Float32Array(new ArrayBuffer(2 * 128 * 4));
  const window = new Float32Array(VAD_WINDOW);

  for (let i = 0; i < numWindows; i++) {
    window.fill(0);
    const start = i * VAD_WINDOW;
    const end = Math.min(audio.length, start + VAD_WINDOW);
    if (end > start) window.set(audio.subarray(start, end));

    const feeds = {
      input: new ort.Tensor('float32', window, [1, VAD_WINDOW]),
      state: new ort.Tensor('float32', state, [2, 1, 128]),
      sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []),
    } as Record<string, ort.Tensor>;

    const out = await session.run(feeds as never);
    probs[i] = Number(out['output']!.data[0]);
    // Copy out of the runtime-owned buffer so the type and ownership are ours.
    const nextState = out['stateN']!.data as Float32Array;
    state = new Float32Array(nextState.length);
    state.set(nextState);
  }
  return probs;
}

/**
 * Energy-based fallback: frame RMS, adaptive threshold from the noise floor.
 * Crude next to Silero, but it keeps the pipeline working if the model is
 * missing, and it is honest about being a fallback.
 */
function energyRegions(audio: Float32Array, frameMs = 30): SpeechRegion[] {
  const frameLen = Math.floor((SAMPLE_RATE * frameMs) / 1000);
  const frames = Math.floor(audio.length / frameLen);
  if (frames === 0) return [];

  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * frameLen;
    for (let i = 0; i < frameLen; i++) {
      const v = audio[base + i] ?? 0;
      sum += v * v;
    }
    rms[f] = Math.sqrt(sum / frameLen);
  }
  const sorted = Float32Array.from(rms).sort();
  const noiseFloor = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  const loud = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  const threshold = Math.max(noiseFloor * 2.5, (noiseFloor + loud) / 2);

  const regions: SpeechRegion[] = [];
  let runStart = -1;
  for (let f = 0; f < frames; f++) {
    const voiced = rms[f]! > threshold;
    if (voiced && runStart === -1) runStart = f;
    if ((!voiced || f === frames - 1) && runStart !== -1) {
      const end = voiced ? f + 1 : f;
      regions.push({ startMs: Math.round((runStart * frameLen * 1000) / SAMPLE_RATE), endMs: Math.round((end * frameLen * 1000) / SAMPLE_RATE) });
      runStart = -1;
    }
  }
  return regions;
}

/** Hysteresis + duration filtering, the standard Silero post-processing. */
function probsToRegions(
  probs: Float32Array,
  opts: { startThreshold: number; endThreshold: number; minSpeechMs: number; minSilenceMs: number; padMs: number },
): SpeechRegion[] {
  const winMs = (VAD_WINDOW * 1000) / SAMPLE_RATE;
  const regions: SpeechRegion[] = [];
  let inSpeech = false;
  let silenceRun = 0;
  let startWin = 0;

  for (let i = 0; i < probs.length; i++) {
    const p = probs[i]!;
    if (!inSpeech) {
      if (p >= opts.startThreshold) {
        inSpeech = true;
        startWin = i;
        silenceRun = 0;
      }
    } else {
      if (p < opts.endThreshold) {
        silenceRun++;
        if (silenceRun * winMs >= opts.minSilenceMs) {
          regions.push({ startMs: startWin * winMs, endMs: (i - silenceRun + 1) * winMs });
          inSpeech = false;
          silenceRun = 0;
        }
      } else {
        silenceRun = 0;
      }
    }
  }
  if (inSpeech) {
    regions.push({ startMs: startWin * winMs, endMs: probs.length * winMs });
  }

  return regions
    .map((r) => ({
      startMs: Math.max(0, r.startMs - opts.padMs),
      endMs: Math.min(probs.length * winMs, r.endMs + opts.padMs),
    }))
    .filter((r) => r.endMs - r.startMs >= opts.minSpeechMs);
}

function tidy(regions: SpeechRegion[], bridgeGapMs: number, minSpeechMs: number): SpeechRegion[] {
  const sorted = [...regions].sort((a, b) => a.startMs - b.startMs);
  const bridged: SpeechRegion[] = [];
  for (const r of sorted) {
    const prev = bridged[bridged.length - 1];
    if (prev && r.startMs - prev.endMs <= bridgeGapMs) {
      prev.endMs = Math.max(prev.endMs, r.endMs);
    } else {
      bridged.push({ ...r });
    }
  }
  return bridged.filter((r) => r.endMs - r.startMs >= minSpeechMs);
}

export async function detectSpeech(
  audio: Float32Array,
  opts: { minSpeechMs?: number; bridgeGapMs?: number } = {},
): Promise<SpeechRegion[]> {
  const minSpeechMs = opts.minSpeechMs ?? 300;
  const bridgeGapMs = opts.bridgeGapMs ?? 260;
  const audioMs = Math.round((audio.length / SAMPLE_RATE) * 1000);

  let regions: SpeechRegion[];
  let engine: string;

  if (vadAvailable()) {
    try {
      const probs = await sileroProbabilities(audio);
      regions = probsToRegions(probs, {
        startThreshold: 0.6,
        endThreshold: 0.35,
        minSpeechMs,
        minSilenceMs: 160,
        padMs: 120,
      });
      engine = 'silero-vad';
    } catch (err) {
      log.warn('vad.silero_failed_falling_back', { err });
      regions = energyRegions(audio);
      engine = 'energy-fallback';
    }
  } else {
    regions = energyRegions(audio);
    engine = 'energy-fallback';
  }

  const tidied = tidy(regions, bridgeGapMs, minSpeechMs);
  const speechMs = tidied.reduce((n, r) => n + (r.endMs - r.startMs), 0);

  log.info('vad.done', {
    engine,
    license: engine === 'silero-vad' ? VAD_LICENSE : undefined,
    regions: tidied.length,
    speechMs,
    audioMs,
    speechRatio: audioMs > 0 ? (speechMs / audioMs).toFixed(2) : '0',
  });

  return tidied;
}