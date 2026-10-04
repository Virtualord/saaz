/** M1b gate: does open OPUS-MT actually translate our Hindi lines? */
import { pipeline } from '@huggingface/transformers';
import { config, ensureDirs } from '../config.js';
import { log } from '../core/logger.js';
import { env } from '@huggingface/transformers';

env.cacheDir = config.paths.modelDir;
ensureDirs();

/** The same five lines that are spoken in the demo clip. */
const LINES = [
  'नमस्ते दोस्तों, आज हम बात करेंगे इस नई मिठाई की दुकान के बारे में।',
  'यहाँ की मालाई सबसे ज़्यादा बिकती है क्योंकि वह घी में बनी हुई है।',
  'दाम भी बहुत किफायती है, दस रुपये किलो से शुरू होते हैं।',
  'दुकान सुबह सात बजे खुलती है और रात दस बजे बंद हो जाती है।',
  'अगर आपके पास कोई सवाल हो तो नीचे कमेंट में ज़रूर लिखिए।',
];

async function main(): Promise<void> {
  const translate = await pipeline('translation', 'Xenova/opus-mt-hi-en', { dtype: 'q8' });

  let totalChars = 0;
  const t0 = performance.now();
  console.log('\n--- OPUS-MT hi->en -------------------------------------------');
  for (const line of LINES) {
    const raw = (await translate(line)) as Array<{ translation_text: string }>;
    const text = Array.isArray(raw) ? (raw[0]?.translation_text ?? '') : '';
    totalChars += text.length;
    console.log(`[${String(Math.round(performance.now() - t0)).padStart(6)}ms] ${text}`);
  }
  const totalMs = performance.now() - t0;
  console.log(`--- ${totalChars} chars in ${Math.round(totalMs)}ms ---------------------------\n`);
  log.info('smoke.mt', { model: 'Xenova/opus-mt-hi-en', license: 'Apache-2.0', totalMs: Math.round(totalMs) });
}

main().catch((err) => {
  log.error('smoke.mt_failed', { err });
  process.exitCode = 1;
});