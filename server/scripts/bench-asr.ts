/**
 * M3b gate: does a bigger Whisper fix the vocabulary errors?
 *
 * M3 produced captions like "Bürench leaves the dust" for "बुप्रे कियो से श्रूए
 * होते है". Before blaming the architecture we should check whether the ASR was
 * the problem. This measures the quality dial for real.
 *
 * Run:  npm run bench:asr
 */
import path from 'node:path';
import { config, ensureDirs } from '../config.js';
import { log } from '../core/logger.js';
import { decodeToFloat32, toolVersions } from '../services/media.js';
import { transcribe } from '../services/asr.js';
import { detectSpeech } from '../services/vad.js';
import { alignToRegions } from '../services/align.js';

ensureDirs();

/** The five spoken lines, i.e. ground truth for scoring. */
const TRUTH = [
  'नमस्ते दोस्तों, आज हम बात करेंगे इस नई मिठाई की दुकान के बारे में।',
  'यहाँ की मालाई सबसे ज़्यादा बिकती है क्योंकि वह घी में बनी हुई है।',
  'दाम भी बहुत किफायती है, दस रुपये किलो से शुरू होते हैं।',
  'दुकान सुबह सात बजे खुलती है और रात दस बजे बंद हो जाती है।',
  'अगर आपके पास कोई सवाल हो तो नीचे कमेंट में ज़रूर लिखिए।',
];

/** Character error rate, computed on codepoints after dropping punctuation. */
function cer(reference: string, hypothesis: string): number {
  const norm = (s: string) => s.replace(/[\s।,.!?;:]/g, '');
  const r = [...norm(reference)];
  const h = [...norm(hypothesis)];
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  let prev = new Array<number>(h.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[h.length]! / r.length;
}

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['onnx-community/whisper-small', 'onnx-community/whisper-base', 'onnx-community/whisper-large-v3-turbo'];

async function main(): Promise<void> {
  const target = path.join(config.paths.outDir, 'demo-hi.wav');
  log.info('bench.tools', (await toolVersions()) ?? {});
  const audio = await decodeToFloat32(target);
  const audioMs = Math.round((audio.length / 16000) * 1000);

  console.log(`\n=== ASR quality dial (${(audioMs / 1000).toFixed(1)}s of Hindi) ===\n`);
  console.log(['model'.padEnd(40), 'ms'.padStart(7), 'RTF'.padStart(6), 'CER'.padStart(7), 'regions'.padStart(8)].join(' '));

  for (const modelId of CANDIDATES) {
    const t0 = Date.now();
    try {
      const res = await transcribe(audio, { language: 'hi', modelId });
      const ms = Date.now() - t0;
      const regions = await detectSpeech(audio);
      const aligned = alignToRegions(res.segments, regions);

      const hypothesis = aligned.map((s) => s.text).join(' ');
      const reference = TRUTH.join(' ');
      const score = cer(reference, hypothesis);

      console.log(
        [
          modelId.padEnd(40),
          String(ms).padStart(7),
          (ms / audioMs).toFixed(2).padStart(6),
          score.toFixed(3).padStart(7),
          String(regions.length).padStart(8),
        ].join(' '),
      );
      console.log(`   heard: ${hypothesis.slice(0, 110)}...`);
    } catch (err) {
      console.log(`${modelId.padEnd(40)}  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log();
  log.info('bench.asr_done', { audioMs });
}

main().catch((err) => {
  log.error('bench.asr_failed', { err });
  process.exitCode = 1;
});