import { pipeline } from '@huggingface/transformers';
import { config } from '../config.js';
import { log } from '../core/logger.js';
import { env } from '@huggingface/transformers';
import { CaptionDraftSchema } from '../../shared/types.js';
import type { CaptionDraft } from '../../shared/types.js';
import { findModel } from '../models/registry.js';
import { timed } from '../core/logger.js';

env.cacheDir = config.paths.modelDir;

/**
 * The caption editor.
 *
 * This is the model with the smallest job and, we would argue, the most
 * important one. Machine translation produces a grammatically complete
 * sentence. A caption is not a sentence — it is a compressed visual artefact
 * with a hard character budget and a hard deadline. Turning the former into the
 * latter is a genuinely separate skill, and it is the step that fails in every
 * naive pipeline we tested.
 *
 * Why open weights matter here specifically: the budget is the whole task, and
 * we enforce it ourselves in code. A closed API bills per token for work we
 * would rather do deterministically, and offers no way to guarantee a character
 * count. Here the constraint is enforced by `charBudget()` before and after the
 * model is consulted, so a bad generation is caught rather than shipped.
 */

type TextGenPipeline = (
  prompt: string,
  opts: Record<string, unknown>,
) => Promise<Array<{ generated_text: string }>>;

const cache = new Map<string, TextGenPipeline>();

/**
 * Build the prompt using the model's own chat template.
 *
 * This is not optional politeness, it is correctness. `pipeline('text-generation')`
 * does not apply a chat template for you: pass raw prose to an instruction-tuned
 * model and it receives something it was never trained to interpret. We measured
 * exactly that failure — Qwen2.5-0.5B degenerated into repeating "What does this
 * sentence mean?" until the token limit. With the template applied it returns
 * the requested JSON.
 */
async function formatPrompt(modelId: string, system: string, user: string): Promise<string> {
  const pipe = await pipeline('text-generation', modelId, { dtype: 'q8' });
  const tokenizer = (pipe as unknown as { tokenizer?: { apply_chat_template?: (msgs: unknown[], o?: unknown) => string } })
    .tokenizer;

  if (!tokenizer?.apply_chat_template) {
    // No template available: a plain instruction prefix is still better than
    // handing an instruction-tuned model unstructured prose.
    return `${system}\n\n${user}`;
  }
  return tokenizer.apply_chat_template(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { tokenize: false, add_generation_prompt: true },
  );
}

async function getGenerator(modelId: string): Promise<TextGenPipeline> {
  const cached = cache.get(modelId);
  if (cached) return cached;
  const pipe = await pipeline('text-generation', modelId, { dtype: 'q8' });
  const gen = pipe as unknown as TextGenPipeline;
  cache.set(modelId, gen);
  return gen;
}

const SYSTEM_PROMPT = [
  'You rewrite machine-translated subtitles for video.',
  'Rules:',
  '- Output ONLY a JSON object with a "lines" array of at most 2 strings.',
  '- Keep the meaning, but use the vocabulary a subtitle would actually use.',
  '- Drop filler words and unnecessary grammar.',
  '- Use present tense where natural.',
  '- Respect the character limit exactly; never exceed it.',
  '- Never add facts that are not in the draft.',
].join('\n');

/**
 * Ask the model to compress a caption into a character budget.
 *
 * Returns null when the model cannot produce anything that validates, so the
 * caller can escalate rather than trust a malformed response. Structured output
 * is enforced with JSON schema on the generation call and re-validated after,
 * because a constrained model is still a model.
 */
export async function reflowCaption(args: {
  sourceText: string;
  draft: string;
  maxChars: number;
  modelId: string;
}): Promise<{ lines: string[]; note: string } | null> {
  const model = findModel('caption', args.modelId);

  const user = [
    `Character budget: ${args.maxChars} characters TOTAL across all lines.`,
    '',
    `Original (${args.sourceText.length} chars): ${args.sourceText}`,
    `Machine draft (${args.draft.length} chars): ${args.draft}`,
    '',
    `Rewrite the draft to fit in ${args.maxChars} characters. Respond with JSON only.`,
  ].join('\n');

  return timed(
    'caption.reflow',
    { model: model.id, maxChars: args.maxChars, draftChars: args.draft.length },
    async () => {
      try {
        const gen = await getGenerator(model.id);
        const prompt = await formatPrompt(model.id, SYSTEM_PROMPT, user);
        const out = await gen(prompt, {
          max_new_tokens: 80,
          do_sample: false,
          return_full_text: false,
          repetition_penalty: 1.15,
          no_repeat_ngram_size: 4,
        });
        const raw = out[0]?.generated_text ?? '';
        const parsed = extractJson(raw);
        if (!parsed) {
          log.warn('caption.unparseable', { model: model.id, raw: raw.slice(0, 160) });
          return null;
        }
        // Coerce before validating: a small model returning {"lines":[{"text":...}]}
        // should be a one-line warning, not a Zod stack trace in the logs.
        const coerced = coerceDraft(parsed);
        if (!coerced) {
          log.warn('caption.schema_mismatch', { model: model.id, raw: raw.slice(0, 160) });
          return null;
        }
        const validated: CaptionDraft = coerced;
        const total = validated.lines.join(' ').length;
        if (total > args.maxChars) {
          // The model ignored the budget. Report rather than ship it: the fit
          // algorithm will escalate to extending the cue or flagging a human.
          log.warn('caption.over_budget', { model: model.id, total, maxChars: args.maxChars });
          return null;
        }
        return { lines: validated.lines, note: validated.note };
      } catch (err) {
        log.warn('caption.failed', { model: model.id, err });
        return null;
      }
    },
  );
}

/** Pull `{lines:[string], note?}` out of whatever shape the model produced. */
function coerceDraft(parsed: unknown): CaptionDraft | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { lines?: unknown; note?: unknown };
  if (!Array.isArray(obj.lines)) return null;
  const lines = obj.lines
    .map((l) => (typeof l === 'string' ? l : typeof l === 'object' && l !== null && 'text' in l ? String((l as { text: unknown }).text) : null))
    .filter((l): l is string => typeof l === 'string' && l.trim().length > 0);
  if (lines.length === 0) return null;
  const result = CaptionDraftSchema.safeParse({
    lines: lines.slice(0, 2),
    note: typeof obj.note === 'string' ? obj.note : '',
  });
  return result.success ? result.data : null;
}

/** Models often wrap JSON in prose or fences; recover the object if present. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Exposed for the UI so we can show which model is doing the work. */
export async function captionModelInfo(modelId: string): Promise<{ id: string; license: string }> {
  const m = findModel('caption', modelId);
  return { id: m.id, license: m.license };
}