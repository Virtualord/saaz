/**
 * M1 gate: probe -> decode -> transcribe, printed for inspection.
 *
 * Exists because the single biggest risk in this project is whether open ASR
 * reads regional-language audio well enough to build a real product on. Run it
 * before touching anything else.
 */
import path from 'node:path';
import { config, ensureDirs } from '../config.js';
import { log } from '../core/logger.js';
import { probeMedia, decodeToFloat32, toolVersions } from '../services/media.js';
import { transcribe } from '../services/asr.js';
import { detectSpeech } from '../services/vad.js';
import { alignToRegions } from '../services/align.js';

const target = process.argv[2] ?? path.join(config.paths.outDir, 'demo-hi.wav');
const modelId = process.argv[3] ?? 'onnx-community/whisper-small';
const language = process.argv[4] ?? 'hi';

async function main(): Promise<void> {
  ensureDirs();
  const versions = await toolVersions();
  log.info('smoke.tools', versions ?? { note: 'ffmpeg not found on PATH' });

  const t0 = performance.now();
  const info = await probeMedia(target);
  log.info('smoke.probe', { ...info, ms: Math.round(performance.now() - t0) });

  const t1 = performance.now();
  const audio = await decodeToFloat32(target);
  log.info('smoke.decode', { samples: audio.length, seconds: (audio.length / 16000).toFixed(2), ms: Math.round(performance.now() - t1) });

  const t2 = performance.now();
  const res = await transcribe(audio, { language, modelId });
  const asrMs = Math.round(performance.now() - t2);

  const tV = performance.now();
  const regions = await detectSpeech(audio);
  const aligned = alignToRegions(res.segments, regions);
  log.info('smoke.vad_align', {
    regions: regions.length,
    alignedSegments: aligned.length,
    ms: Math.round(performance.now() - tV),
  });

  log.info('smoke.asr', {
    model: modelId,
    timestampMode: res.timestampMode,
    segments: res.segments.length,
    asrMs,
    realtimeFactor: (asrMs / Math.max(1, res.audioMs)).toFixed(2),
  });

  console.log('\n--- ALIGNED segments (VAD-derived timings) ------------------');
  for (const s of aligned) {
    const conf = s.asrConfidence === null ? '   n/a' : s.asrConfidence.toFixed(2);
    console.log(
      `[${String(s.startMs).padStart(6)} -> ${String(s.endMs).padStart(6)}] conf=${conf}  ${s.text}`,
    );
  }
  const total = aligned.reduce((n, s) => n + s.text.length, 0);
  console.log(`--- ${res.segments.length} segments, ${total} chars ---------------------------\n`);
}

main().catch((err) => {
  log.error('smoke.failed', { err });
  process.exitCode = 1;
});