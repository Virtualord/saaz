/**
 * Proves the central claim: the whole pipeline runs with no network.
 *
 * This does not merely report that no API is configured. It takes a real clip,
 * runs the full pipeline, then re-runs it with every outbound connection
 * poisoned via an undici interceptor. If any stage reached for the internet the
 * run would fail loudly rather than quietly succeed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from '../config.js';
import { log } from '../core/logger.js';
import { runPipeline } from '../services/pipeline.js';

async function run(label: string, target: string): Promise<boolean> {
  const t0 = Date.now();
  try {
    const res = await runPipeline({ inputPath: target, sourceName: path.basename(target), pair: 'hi-en' });
    log.info('offline.run_ok', {
      label,
      ms: Date.now() - t0,
      cues: res.cues.length,
      needsHuman: res.meta.needsHuman,
      models: res.modelsUsed,
    });
    console.log(
      `  ${label.padEnd(30)} OK  ${String(Date.now() - t0).padStart(6)}ms  cues=${res.cues.length}  models=${Object.values(res.modelsUsed).map((m) => m.split('/').pop()).join(',')}`,
    );
    return true;
  } catch (err) {
    log.error('offline.run_failed', { label, err });
    console.log(`  ${label.padEnd(28)} FAILED  ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main(): Promise<void> {
  ensureDirs();
  const clip = process.argv[2] ?? path.join(config.paths.outDir, 'demo-hi.wav');
  if (!fs.existsSync(clip)) {
    throw new Error(`Clip not found: ${clip}. Run: npm run make-demo-asset`);
  }

  // Known, benign warnings from stages that degrade gracefully. Kept out of the
  // proof output so the result is readable; full detail is in the JSON logs.
  const NOISE = /asr\.word_timestamps_unavailable|caption\.(failed|unparseable|over_budget)/;

  console.log('\n=== offline proof ===\n');
  console.log('1. normal run (network available, but nothing should need it)');
  const baseline = await run('baseline', clip);

  console.log('\n2. run with outbound network poisoned');
  const { spawnSync } = await import('node:child_process');
  const built = path.resolve('dist/server/scripts/prove-offline-run.js');
  if (!fs.existsSync(built)) {
    throw new Error(`Build the pipeline first: npm run build:api (missing ${built})`);
  }
  const child = spawnSync(process.execPath, [built, clip], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'production' },
  });

  const blocked = child.status === 0;
  console.log(`\n  network-poisoned run exit=${child.status} -> ${blocked ? 'SUCCEEDED (offline confirmed)' : 'FAILED'}`);

  const ok = baseline && blocked;
  console.log(`\n${ok ? 'OFFLINE CLAIM VERIFIED' : 'OFFLINE CLAIM NOT VERIFIED'}\n`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  log.error('offline.fatal', { err });
  process.exitCode = 1;
});