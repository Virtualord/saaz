/**
 * Reproducible benchmark for the caption slot.
 *
 * This exists because the default model was chosen by measurement, not taste.
 * Qwen2.5-0.5B and Qwen2.5-1.5B both produced unusable output on this exact
 * task: no parseable JSON, and degenerate repetition until the token limit.
 * SmolLM2-360M returned valid JSON and was faster. Publishing the harness means
 * nobody has to take that claim on trust.
 *
 * Run:  npm run bench:caption
 */
import { pipeline, env } from '@huggingface/transformers';
import { config, ensureDirs } from '../config.js';
import { log } from '../core/logger.js';
import { CAPTION_SLOT } from '../models/registry.js';
import { CaptionDraftSchema } from '../../shared/types.js';

env.cacheDir = config.paths.modelDir;
ensureDirs();

const SYSTEM = [
  'You rewrite machine-translated subtitles for video.',
  'Respond ONLY with JSON: {"lines":["..."],"note":""}.',
  'Max 2 lines. Respect the character limit exactly.',
].join('\n');

/** Cases mirror real pipeline output, including the awkward ones. */
const CASES = [
  {
    budget: 24,
    original: 'यहाँ की मालाई सबसे ज़्यादा बिकती है',
    draft: 'Malai is the most widely sold here because it is made in ghee',
  },
  {
    budget: 32,
    original: 'दुकान सुबह सात बजे खुलती है',
    draft: 'The shop opens at seven oclock in the morning which is quite early',
  },
  {
    budget: 20,
    original: 'दाम भी बहुत किफायती है',
    draft: 'The prices are also very affordable for everyone',
  },
];

type Row = {
  model: string;
  license: string;
  ok: number;
  parseFail: number;
  overBudget: number;
  avgMs: number;
  loadMs: number;
  sample: string;
};

const results: Row[] = [];

for (const model of CAPTION_SLOT.models) {
  const loadT0 = Date.now();
  let pipe: Awaited<ReturnType<typeof pipeline>>;
  try {
    pipe = await pipeline('text-generation', model.id, { dtype: model.dtype as 'q8' });
  } catch (err) {
    log.warn('bench.load_failed', { model: model.id, err });
    continue;
  }
  const loadMs = Date.now() - loadT0;

  let ok = 0;
  let parseFail = 0;
  let overBudget = 0;
  let totalMs = 0;
  let sample = '';

  for (const c of CASES) {
    const user = [
      `Character budget: ${c.budget} characters TOTAL.`,
      '',
      `Original: ${c.original}`,
      `Machine draft: ${c.draft}`,
      '',
      `Rewrite to fit ${c.budget} characters. JSON only.`,
    ].join('\n');

    const tokenizer = (pipe as unknown as { tokenizer?: { apply_chat_template?: (m: unknown[], o?: unknown) => string } })
      .tokenizer;
    const prompt = tokenizer?.apply_chat_template
      ? tokenizer.apply_chat_template(
          [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: user },
          ],
          { tokenize: false, add_generation_prompt: true },
        )
      : `${SYSTEM}\n\n${user}`;

    const t0 = Date.now();
    let raw = '';
    try {
      const out = (await pipe(prompt, {
        max_new_tokens: 70,
        do_sample: false,
        return_full_text: false,
      })) as Array<{ generated_text: string }>;
      raw = out[0]?.generated_text ?? '';
    } catch (err) {
      log.warn('bench.gen_failed', { model: model.id, err });
    }
    totalMs += Date.now() - t0;

    const match = raw.match(/\{[\s\S]*\}/);
    let parsed: unknown = null;
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }

    if (!parsed) {
      parseFail++;
      if (!sample) sample = raw.slice(0, 90);
      continue;
    }
    const safe = CaptionDraftSchema.safeParse(parsed);
    if (!safe.success) {
      parseFail++;
      continue;
    }
    const total = safe.data.lines.join(' ').length;
    if (total > c.budget) {
      overBudget++;
      if (!sample) sample = safe.data.lines.join(' ') + ` (${total}/${c.budget} chars)`;
      continue;
    }
    ok++;
    if (!sample) sample = safe.data.lines.join(' ');
  }

  results.push({
    model: model.id,
    license: model.license,
    ok,
    parseFail,
    overBudget,
    avgMs: Math.round(totalMs / CASES.length),
    loadMs,
    sample,
  });
}

console.log('\n=== caption slot benchmark (budgeted rewrite, 3 cases) ===\n');
console.log(
  ['model'.padEnd(42), 'lic'.padEnd(11), 'ok'.padStart(3), 'parseX'.padStart(7), 'over'.padStart(5), 'gen_ms'.padStart(7), 'load_ms'.padStart(9)].join(' '),
);
for (const r of results) {
  console.log(
    [
      r.model.padEnd(42),
      r.license.padEnd(11),
      String(r.ok).padStart(3),
      String(r.parseFail).padStart(7),
      String(r.overBudget).padStart(5),
      String(r.avgMs).padStart(7),
      String(r.loadMs).padStart(9),
    ].join(' '),
  );
}
console.log('\nsample outputs:');
for (const r of results) console.log(`  ${r.model}\n    ${JSON.stringify(r.sample)}`);
console.log();

export { results };