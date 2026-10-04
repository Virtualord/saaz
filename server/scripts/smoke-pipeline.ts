/** M3 gate: the full pipeline end to end on the generated demo clip. */
import path from 'node:path';
import { config, ensureDirs } from '../config.js';
import { runPipeline, toSrt, toVtt, auditCues } from '../services/pipeline.js';
import type { LanguagePair } from '../../shared/types.js';

const target = process.argv[2] ?? path.join(config.paths.outDir, 'demo-hi.wav');
const pair = (process.argv[3] ?? 'hi-en') as LanguagePair;

async function main(): Promise<void> {
  ensureDirs();
  const wall0 = Date.now();

  const res = await runPipeline({ inputPath: target, sourceName: path.basename(target), pair });

  console.log('\n=== stage timings (ms) ===');
  for (const [k, v] of Object.entries(res.stageMs)) {
    console.log(`  ${k.padEnd(12)} ${String(v).padStart(7)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(12)} ${String(Date.now() - wall0).padStart(7)}`);

  console.log('\n=== cues ===');
  for (const [i, c] of res.cues.entries()) {
    const flag = c.escalation === 'refused' ? 'REFUSED' : c.escalation;
    console.log(`\n[${i + 1}] ${c.startMs}->${c.endMs}  (${c.endMs - c.startMs}ms)  ${flag}  cps=${c.cps}`);
    console.log(`    src: ${c.sourceText}`);
    if (c.translation) console.log(`    eng: ${c.lines.join(' | ')}`);
    if (c.warnings.length) console.log(`    !!  ${c.warnings.join('; ')}`);
  }

  const audit = auditCues(res.cues);
  console.log(`\n=== QA: ${audit.length}/${res.cues.length} cues with warnings ===`);
  for (const a of audit.slice(0, 10)) console.log(`  cue ${a.index + 1}: ${a.warnings.join('; ')}`);

  console.log(`\nmodels: ${JSON.stringify(res.modelsUsed)}`);
  console.log(`glossary applied: ${JSON.stringify(res.meta.glossaryApplied)}`);
  console.log(`needs human: ${res.meta.needsHuman}`);
  console.log(`\n--- SRT (first 3 cues) ---\n${toSrt(res.cues).split('\n\n').slice(0, 3).join('\n\n')}`);
  console.log(`\n--- VTT head ---\n${toVtt(res.cues).split('\n').slice(0, 6).join('\n')}\n`);
}

main().catch((err) => {
  console.error('pipeline failed:', err);
  process.exitCode = 1;
});