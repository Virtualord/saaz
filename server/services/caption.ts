import { config } from '../config.js';
import { log } from '../core/logger.js';
import { pipeline, env } from '@huggingface/transformers';
import { withSpan } from '../core/tracing.js';
import { withRetry } from '../core/retry.js';
import { findModel, CAPTION_SLOT } from '../models/registry.js';

/**
 * The caption editor.
 *
 * ## What the measurements actually showed
 *
 * We expected a small open LLM to reliably compress a machine draft into a
 * character budget. It does not. `npm run bench:caption` and several rounds of
 * prompt variants established this:
 *
 *   - Requiring JSON makes it worse. Both Qwen2.5-1.5B and SmolLM2-360M echo
 *     the instruction ("Respect the character limit.") or emit `{"lines": ...}`
 *     as literal text instead of complying. Schema-following is the weakest
 *     thing about models this small.
 *   - Dropping the JSON requirement gets real rewrites. "Reply with the subtitle
 *     only" produced "The store starts around 7 AM." — correct meaning, 29
 *     characters, inside a 32-character budget.
 *   - But reliability is low. Across four realistic cases, Qwen2.5-1.5B landed
 *     in budget on roughly one. SmolLM2-360M is fluent but overran every budget.
 *
 * An earlier version of this file and of the model registry claimed the opposite
 * — that SmolLM2-360M succeeded where Qwen failed. That claim came from a test
 * that omitted `repetition_penalty`, and it was wrong. The registry now records
 * the measured truth.
 *
 * ## What we do about it
 *
 * The LLM is kept, because it is the one step that can genuinely improve
 * caption *wording* when it succeeds. But it is treated as a best-effort
 * suggestion, never as a guarantee:
 *
 *   1. Plain-text output, no JSON. We do the schema ourselves.
 *   2. Every result is validated against the real budget in code.
 *   3. A failure is normal and expected, not exceptional. The Fit algorithm
 *      escalates deterministically instead of depending on this step.
 *
 * This is the honest version of the feature. The alternative — pretending the
 * model is reliable — would produce unreadable subtitles on a real user's
 * deliverable, which is the one thing a subtitle tool must never do.
 */

type TextGenPipeline = (prompt: string, opts: Record<string, unknown>) => Promise<Array<{ generated_text: string }>>;

const cache = new Map<string, TextGenPipeline>();

/**
 * Plain-text instruction. No JSON, no schema, no example containing braces —
 * every one of those reliably made the model echo the instruction instead of
 * answering it.
 */
const SYSTEM_PROMPT =
  'You rewrite subtitles to be shorter while preserving meaning. ' +
  'Reply with the rewritten subtitle only, nothing else.';

/**
 * Build the prompt using the model's own chat template.
 *
 * This is not optional politeness, it is correctness. `pipeline('text-generation')`
 * does not apply a chat template for you: pass raw prose to an instruction-tuned
 * model and it receives something it was never trained to interpret. We measured
 * exactly that failure — the model degenerated into repeating "What does this
 * sentence mean?" until the token limit.
 */
async function formatPrompt(modelId: string, system: string, user: string): Promise<string> {
  const pipe = await loadPipe(modelId);
  const tokenizer = (pipe as unknown as {
    tokenizer?: { apply_chat_template?: (msgs: unknown[], o?: unknown) => string };
  }).tokenizer;

  if (!tokenizer?.apply_chat_template) {
    return `${system}\n\n${user}`;
  }
  // Must stay bound to the tokenizer: apply_chat_template reads `this`.
  return tokenizer.apply_chat_template(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { tokenize: false, add_generation_prompt: true },
  );
}

async function loadPipe(modelId: string): Promise<unknown> {
  const cached = cache.get(modelId);
  if (cached) return cached;

  const model = findModel('caption', modelId);
  return withSpan(
    'model.load',
    { kind: 'model', attributes: { slot: 'caption', modelId, license: model.license, dtype: model.dtype } },
    async () => {
      const pipe = await pipeline('text-generation', modelId, { dtype: model.dtype as 'q8' });
      const typed = pipe as unknown as TextGenPipeline;
      cache.set(modelId, typed);
      return pipe;
    },
  );
}

/** Rough token estimate; Qwen/Smol tokenizers average ~3.7 characters. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 3.7));
}

/**
 * Ask the model for a shorter caption, then decide whether to trust it.
 *
 * Returns null on anything we cannot verify: over budget, empty, or wrapped in
 * chat. The caller escalates deterministically. `null` here is a normal outcome,
 * not an error.
 */
export async function reflowCaption(args: {
  sourceText: string;
  draft: string;
  maxChars: number;
  modelId: string;
}): Promise<{ lines: string[]; note: string } | null> {
  const model = findModel('caption', args.modelId);

  return withSpan(
    'model.caption_reflow',
    {
      kind: 'model',
      attributes: {
        slot: 'caption',
        modelId: model.id,
        license: model.license,
        dtype: model.dtype,
        maxChars: args.maxChars,
        draftChars: args.draft.length,
        strategy: 'plain_text_no_json',
      },
    },
    async (span) => {
      const fallbackModel =
        CAPTION_SLOT.models.find((m) => m.id !== args.modelId && m.license !== 'gemma')?.id;

      try {
        const lines = await withRetry(
          async (attempt) => {
            const pipe = (await loadPipe(args.modelId)) as TextGenPipeline;
            const user = [
              `Original: ${args.sourceText}`,
              `Draft: ${args.draft}`,
              `Rewrite to at most ${args.maxChars} characters.`,
            ].join('\n');
            const prompt = await formatPrompt(args.modelId, SYSTEM_PROMPT, user);

            const t0 = performance.now();
            const out = await pipe(prompt, {
              max_new_tokens: 60,
              // Retry warms the sampling slightly to escape a repetition loop.
              do_sample: attempt > 1,
              temperature: attempt > 1 ? 0.4 : undefined,
              return_full_text: false,
              repetition_penalty: 1.15,
              no_repeat_ngram_size: 4,
            });
            const genMs = Math.round(performance.now() - t0);
            const raw = out[0]?.generated_text ?? '';

            span.set('generationMs', genMs);
            span.setUsage({
              inputTokens: estimateTokens(prompt),
              outputTokens: estimateTokens(raw),
              totalTokens: estimateTokens(prompt) + estimateTokens(raw),
              estimated: true,
            });

            const text = cleanOutput(raw);
            if (!text) {
              span.event('empty_output', { attempt });
              throw new Error('caption model returned nothing usable');
            }
            if (text.length > args.maxChars) {
              span.event('over_budget', { attempt, chars: text.length, maxChars: args.maxChars });
              throw new Error(`caption ${text.length} chars exceeds budget ${args.maxChars}`);
            }

            span.event('accepted', { attempt, chars: text.length });
            return [text];
          },
          {
            attempts: 2,
            backoffMs: 150,
            label: 'caption.retry',
            fallback: fallbackModel
              ? async () => {
                  args.modelId = fallbackModel;
                  log.info('caption.fallback_model', { to: fallbackModel });
                }
              : undefined,
          },
        );
        return { lines, note: '' };
      } catch (err) {
        // Expected most of the time. The Fit algorithm escalates without us.
        span.fail(err);
        log.debug('caption.declined', { model: model.id, err });
        return null;
      }
    },
  );
}

/**
 * Strip the wrappers small models add around an answer.
 *
 * Deliberately conservative: we only remove quotation marks and stray
 * whitespace, and reject anything that still looks like an instruction echo or
 * a JSON object rather than a caption.
 */
export function cleanOutput(raw: string): string | null {
  let text = raw.trim().replace(/\s+/g, ' ');

  // Models sometimes wrap the whole answer in quotes.
  const quoted = text.match(/^["'`](.*)["'`]$/);
  if (quoted?.[1]) text = quoted[1].trim();

  // A JSON blob means it answered the format instead of the task.
  if (text.startsWith('{') || text.startsWith('[')) return null;

  /**
 * Instruction echoes: the model restating the prompt instead of answering.
 *
 * Tuned against observed failures, not guesswork. Qwen2.5-1.5B literally
 * answered "Respect the character limit." to a rewrite request.
 *
 * Kept deliberately narrow. An earlier, broader version also rejected
 * "The limit is 10 rupees per kilo" — a perfectly good caption — which would
 * have thrown away valid output. So we reject only openings that are clearly
 * meta-commentary, and let the caller enforce the character budget, which is
 * the check that actually matters.
 */
const META_OPENING =
  /^(here (is|are)|below (is|are)|above (is|are)|sure|okay|ok[,!.]|certainly|of course|i (can|will|have)|as (an? )?(ai )?(language )?model)\b/i;
if (META_OPENING.test(text)) return null;

/** "Rewrite: ...", "Original: ...", "Note: ..." — labels, not captions. */
const LABEL_OPENING = /^["']?(rewrite|rewritten|output|reply|task|note|original|draft|subtitle|budget)\s*[:\-–]/i;
if (LABEL_OPENING.test(text)) return null;

/** Restating the constraint rather than satisfying it. */
if (/^(respect|ensure|remember|keep)\s+(the\s+)?(character|word|length|limit|budget)/i.test(text)) return null;
if (/^(the\s+)?(output|task|draft|original|response)\s+(should|must|needs? to|is)\b/i.test(text)) return null;

  if (text.length === 0) return null;
  return text;
}

export async function captionModelInfo(modelId: string): Promise<{ id: string; license: string }> {
  const m = findModel('caption', modelId);
  return { id: m.id, license: m.license };
}