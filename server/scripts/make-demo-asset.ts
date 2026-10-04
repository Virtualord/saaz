/**
 * Generates the demo clip from open models, end to end.
 *
 * Why generate rather than use real footage: the product's central claim is that
 * footage never leaves the machine. A demo that depends on borrowed media would
 * undercut that, and would raise questions we could not answer honestly. This
 * script produces a reproducible Hindi clip whose audio comes from an openly
 * licensed TTS, so the entire demo runs from open weights.
 *
 * TTS provenance: facebook/mms-tts-hin (CC-BY-NC-4.0) via the Xenova ONNX port.
 * Used only to manufacture a fixture — it is not part of the Saaz runtime, and
 * its non-commercial licence does not touch anything we ship.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from '@huggingface/transformers';
import { config, ensureDirs } from '../config.js';
import { log } from '../core/logger.js';
import { env } from '@huggingface/transformers';

const exec = promisify(execFile);
env.cacheDir = config.paths.modelDir;

const FFMPEG = process.env.SAAZ_FFMPEG ?? 'ffmpeg';

/**
 * A short monologue about a local sweet shop, written the way someone actually
 * speaks to camera. Note the cultural specifics on purpose: "malai" and the
 * rupee price have no clean English rendering, which is exactly where a naive
 * translation pipeline falls apart and where the caption editor earns its keep.
 */
const LINES: Array<{ hi: string; note: string }> = [
  { hi: 'नमस्ते दोस्तों, आज हम बात करेंगे इस नई मिठाई की दुकान के बारे में।', note: 'greeting + topic' },
  { hi: 'यहाँ की मालाई सबसे ज़्यादा बिकती है क्योंकि वह घी में बनी हुई है।', note: 'cultural term: malai' },
  { hi: 'दाम भी बहुत किफायती है, दस रुपये किलो से शुरू होते हैं।', note: 'currency + number' },
  { hi: 'दुकान सुबह सात बजे खुलती है और रात दस बजे बंद हो जाती है।', note: 'times' },
  { hi: 'अगर आपके पास कोई सवाल हो तो नीचे कमेंट में ज़रूर लिखिए।', note: 'call to action' },
];

async function synthLine(text: string, outPath: string): Promise<void> {
  const tts = await pipeline('text-to-speech', 'Xenova/mms-tts-hin', { dtype: 'q8' });
  // mms-tts-hin is single-speaker; no voice selection needed.
  const out = (await tts(text)) as { audio: Float32Array; sampling_rate: number };
  const wav = encodeWavPcm16(out.audio, out.sampling_rate);
  await fs.writeFile(outPath, wav);
}

/** Minimal RIFF/PCM16 encoder so we need no audio dependency. */
function encodeWavPcm16(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // PCM header size
  buf.writeUInt16LE(1, 20); // format = PCM
  buf.writeUInt16LE(1, 22); // channels
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buf;
}

async function main(): Promise<void> {
  ensureDirs();
  const work = path.join(config.paths.outDir, 'demo-src');
  await fs.mkdir(work, { recursive: true });

  const parts: string[] = [];
  for (const [i, line] of LINES.entries()) {
    const wav = path.join(work, `line-${String(i).padStart(2, '0')}.wav`);
    const t0 = performance.now();
    await synthLine(line.hi, wav);
    parts.push(wav);
    log.info('demo.tts', { index: i, note: line.note, ms: Math.round(performance.now() - t0), text: line.hi });
  }

  // A short silence between lines, so the clip has realistic gaps for the
  // segmenter to respect rather than one continuous wall of speech.
  const silence = path.join(work, 'silence.wav');
  await exec(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.7', silence]);

  const concatList = path.join(work, 'concat.txt');
  const entries: string[] = [];
  for (const [i, p] of parts.entries()) {
    entries.push(`file '${p}'`);
    if (i < parts.length - 1) entries.push(`file '${silence}'`);
  }
  await fs.writeFile(concatList, entries.join('\n'));

  const audioOut = path.join(config.paths.outDir, 'demo-hi.wav');
  await exec(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c:a', 'pcm_s16le', audioOut]);

  const durationSec = (
    await exec(FFMPEG, ['-i', audioOut, '-f', 'null', '-'], {}).catch(() => ({ stderr: '' }))
  ).stderr.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  const seconds = durationSec
    ? Number(durationSec[1]) * 3600 + Number(durationSec[2]) * 60 + Number(durationSec[3])
    : 0;

  const videoOut = path.join(config.paths.outDir, 'demo-hi.mp4');
  await exec(FFMPEG, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=0x0d1117:s=1280x720',
    '-i', audioOut,
    '-shortest',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    videoOut,
  ]);

  log.info('demo.asset_ready', {
    audio: audioOut,
    video: videoOut,
    seconds: Number(seconds.toFixed(2)),
    lines: LINES.length,
  });
  console.log(`\nDemo asset ready:\n  ${audioOut}\n  ${videoOut}\n`);
}

main().catch((err) => {
  log.error('demo.failed', { err });
  process.exitCode = 1;
});