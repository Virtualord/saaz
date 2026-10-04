/**
 * Downloads and verifies every model in the registry, so that a deployed
 * instance can run with no network at all.
 *
 * Run once before deployment:  npm run fetch-models
 */
import { config, ensureDirs } from '../config.js';
import { log } from '../core/logger.js';
import { pipeline, env } from '@huggingface/transformers';
import { SLOTS, type Slot } from '../models/registry.js';
import { isCachedLocally } from '../models/loader.js';

env.cacheDir = config.paths.modelDir;
env.allowLocalModels = true;
env.allowRemoteModels = true;

ensureDirs();

/** Only fetch these; `--all` grabs every swappable alternative too. */
const WANTED: Record<Slot, string[]> = {
  asr: ['onnx-community/whisper-small'],
  mt: ['Xenova/opus-mt-hi-en'],
  caption: ['HuggingFaceTB/SmolLM2-360M-Instruct'],
};

async function main(): Promise<void> {
  const all = process.argv.includes('--all');
  let failed = 0;

  for (const slot of Object.keys(SLOTS) as Slot[]) {
    const spec = SLOTS[slot];
    const ids = all ? spec.models.map((m) => m.id) : WANTED[slot];

    for (const id of ids) {
      const model = spec.models.find((m) => m.id === id);
      if (!model) {
        log.error('fetch.unknown_model', { slot, id });
        failed++;
        continue;
      }
      if (isCachedLocally(id)) {
        log.info('fetch.skip_cached', { slot, id, approxMb: model.approxMb });
        continue;
      }
      const t0 = performance.now();
      try {
        log.info('fetch.start', { slot, id, license: model.license, dtype: model.dtype });
        // Constructing the pipeline forces a real fetch and a real graph load.
        await pipeline(spec.task, id, { dtype: model.dtype as 'q8' });
        log.info('fetch.ok', { slot, id, ms: Math.round(performance.now() - t0) });
      } catch (err) {
        failed++;
        log.error('fetch.fail', { slot, id, err });
      }
    }
  }

  if (failed > 0) {
    log.error('fetch.summary', { failed, message: 'One or more models could not be fetched.' });
    process.exitCode = 1;
  } else {
    log.info('fetch.summary', { failed: 0, message: 'All requested models cached locally.' });
  }
}

main().catch((err) => {
  log.error('fetch.fatal', { err });
  process.exitCode = 1;
});