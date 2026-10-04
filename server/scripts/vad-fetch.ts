/**
 * Fetches the Silero VAD weights.
 *
 * This model is not in the transformers.js cache (it has no config.json and is
 * driven directly through onnxruntime-node), so it needs its own fetch step for
 * the Docker build to produce a genuinely offline image.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from '../config.js';
import { log } from '../core/logger.js';
import { VAD_LICENSE, VAD_MODEL_ID, vadAvailable } from '../services/vad.js';

const HF_BASE = `https://huggingface.co/${VAD_MODEL_ID}/resolve/main/onnx`;
const FILE = 'model_int8.onnx';

async function main(): Promise<void> {
  ensureDirs();
  if (vadAvailable()) {
    log.info('vad.fetch.skip_cached', { file: FILE });
    return;
  }

  const dir = path.join(config.paths.modelDir, 'silero-vad');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, FILE);

  log.info('vad.fetch.start', { model: VAD_MODEL_ID, license: VAD_LICENSE, file: FILE });
  const res = await fetch(`${HF_BASE}/${FILE}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${FILE}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength < 10_000) {
    throw new Error(`${FILE} is suspiciously small (${buf.byteLength} bytes); refusing to cache it.`);
  }

  // Write to a temp name and rename, so an interrupted fetch never leaves a
  // truncated file that would look cached.
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  log.info('vad.fetch.ok', { bytes: buf.byteLength, dest });
}

main().catch((err) => {
  log.error('vad.fetch.failed', { err });
  process.exitCode = 1;
});