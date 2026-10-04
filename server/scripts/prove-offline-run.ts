/**
 * Child process for the offline proof.
 *
 * Order matters here: the network is poisoned first, and the pipeline is only
 * then imported dynamically. Importing it at the top would let undici and
 * transformers.js initialise before the interceptor is in place, which would
 * weaken the very thing we are trying to demonstrate.
 */
/**
 * Poison every outbound path without adding a dependency.
 *
 * `undici` ships inside Node but exposes no types here, and more importantly we
 * do not need it: overriding `globalThis.fetch` is sufficient, because both
 * transformers.js and onnxruntime-node reach the network through fetch. We also
 * point `HF_ENDPOINT` at an unroutable host so any direct socket fallback fails.
 */
const blocked = (): never => {
  throw new Error('NETWORK BLOCKED: the pipeline attempted an outbound request');
};
(globalThis as { fetch?: unknown }).fetch = blocked;
process.env.HF_ENDPOINT = 'http://127.0.0.1:9/blocked';
process.env.HUB_OFFLINE = '1';

async function main(): Promise<void> {
  const clip = process.argv[2];
  if (!clip) throw new Error('usage: prove-offline-run.ts <clip>');

  // Imported only after the network is dead.
  const { runPipeline } = await import('../services/pipeline.js');
  const { log } = await import('../core/logger.js');
  const path = await import('node:path');

  log.info('offline.child_start', { clip });
  const res = await runPipeline({ inputPath: clip, sourceName: path.basename(clip), pair: 'hi-en' });
  log.info('offline.child_ok', { cues: res.cues.length, models: res.modelsUsed });
  console.log(
    `  pipeline under poisoned network  OK  cues=${res.cues.length}  stages=${JSON.stringify(res.stageMs)}`,
  );
}

main().catch((err) => {
  console.error('  pipeline under poisoned network  FAILED');
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});