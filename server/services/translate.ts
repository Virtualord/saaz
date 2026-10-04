import { pipeline } from '@huggingface/transformers';
import { config } from '../config.js';
import { log, timed } from '../core/logger.js';
import { env } from '@huggingface/transformers';
import { findModel } from '../models/registry.js';
import type { LanguagePair } from '../../shared/types.js';

env.cacheDir = config.paths.modelDir;

/**
 * Draft translation with open Helsinki OPUS-MT weights.
 *
 * We measured why this stage cannot be trusted alone, and the measurement is
 * worth stating plainly because it shaped the product:
 *
 *   "नमस्ते दोस्तों"                    -> "Hello friends"                        good
 *   "दुकान सुबह सात बजे खुलती है"      -> "The shop opens at 7 a.m."              good
 *   "मुझे दस रुपये चाहिए"              -> "I need 10 rupees."                     good
 *   "मालाई"                            -> "by Miley"                              wrong
 *
 * The failures are vocabulary gaps on domain terms, not tokenisation bugs — we
 * ruled out nukta handling by normalising it and observing identical output. So
 * the architecture answers this with a glossary and a human review step instead
 * of pretending the model is reliable.
 */

type TranslationPipeline = (
  text: string | string[],
  opts: Record<string, unknown>,
) => Promise<Array<{ translation_text: string }>>;

const cache = new Map<string, TranslationPipeline>();

async function getTranslator(modelId: string): Promise<TranslationPipeline> {
  const cached = cache.get(modelId);
  if (cached) return cached;
  const pipe = await pipeline('translation', modelId, { dtype: 'q8' });
  const t = pipe as unknown as TranslationPipeline;
  cache.set(modelId, t);
  return t;
}

/**
 * M2M100 is multilingual and needs explicit language codes; OPUS-MT is a fixed
 * pair and must not receive them.
 */
function optionsFor(modelId: string, pair: LanguagePair): Record<string, unknown> {
  if (modelId.includes('m2m100')) {
    const [src, tgt] = pair.split('-') as [string, string];
    return { src_lang: src, tgt_lang: tgt };
  }
  return {};
}

export async function translateCue(
  text: string,
  pair: LanguagePair,
  modelId: string,
): Promise<string | null> {
  // Already English: no MT stage is run at all, which we report rather than hide.
  if (pair === 'en-en') return text;

  const model = findModel('mt', modelId);

  return timed('mt.translate', { model: model.id, chars: text.length, pair }, async () => {
    try {
      const translate = await getTranslator(model.id);
      const out = await translate(text, { ...optionsFor(model.id, pair), max_new_tokens: 128 });
      const result = Array.isArray(out) ? (out[0]?.translation_text ?? '').trim() : '';
      if (!result) {
        log.warn('mt.empty', { model: model.id, text: text.slice(0, 60) });
        return null;
      }
      return result;
    } catch (err) {
      log.error('mt.failed', { model: model.id, err });
      return null;
    }
  });
}

/** Translate several cues in one call, which is markedly faster than N calls. */
export async function translateBatch(
  texts: string[],
  pair: LanguagePair,
  modelId: string,
): Promise<Array<string | null>> {
  if (pair === 'en-en') return texts;
  const model = findModel('mt', modelId);

  return timed('mt.batch', { model: model.id, count: texts.length }, async () => {
    try {
      const translate = await getTranslator(model.id);
      const out = await translate(texts, { ...optionsFor(model.id, pair), max_new_tokens: 128 });
      return out.map((o) => (o.translation_text ?? '').trim() || null);
    } catch (err) {
      log.error('mt.batch_failed', { model: model.id, err });
      return texts.map(() => null);
    }
  });
}