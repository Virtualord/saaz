import { z } from 'zod';
import { LanguagePairSchema, type LanguagePair } from '../../shared/types.js';

/**
 * The model registry.
 *
 * Every AI model the product uses is declared here with its licence, its
 * quantisation, and its measured footprint. Licence is a first-class field on
 * purpose: it is a product decision (what may we redistribute to our user's
 * laptop?) and a claim we make in the write-up, so it is data, not a comment.
 *
 * `dtype` is likewise first-class. Quantisation is what allows three models to
 * run on a CPU-only machine with no GPU, so it is a load-bearing product
 * decision rather than an optimisation detail.
 */
export type Slot = 'asr' | 'mt' | 'caption';
export type DType = 'q8' | 'int8' | 'fp32' | 'fp16' | 'q4';

export interface ModelSpec {
  /** Hugging Face repo id. */
  id: string;
  label: string;
  /** SPDX identifier. `gemma` is deliberately NOT presented as open source. */
  license: string;
  licenseUrl?: string;
  /** One-line note on provenance or restrictions, surfaced in the UI. */
  licenseNote?: string;
  dtype: DType;
  /** Approximate on-disk footprint in MB. Verified by `fetch-models`. */
  approxMb: number;
  /** Relative within its slot. Higher is better. */
  quality: 1 | 2 | 3 | 4 | 5;
  /** Relative within its slot. Higher is faster. */
  speed: 1 | 2 | 3 | 4 | 5;
}

export interface SlotSpec {
  slot: Slot;
  task: 'automatic-speech-recognition' | 'translation' | 'text-generation';
  /** What this stage is for, in one sentence. Shown in the UI. */
  purpose: string;
  defaultModelId: string;
  models: ModelSpec[];
  /** For the `mt` slot: which model handles which language pair. */
  pairCoverage?: Record<LanguagePair, string[]>;
}

const WHISPER_MIT = 'https://github.com/openai/whisper/blob/main/LICENSE';

export const ASR_SLOT: SlotSpec = {
  slot: 'asr',
  task: 'automatic-speech-recognition',
  purpose: 'Turn the audio into timed dialogue.',
  defaultModelId: 'onnx-community/whisper-small',
  models: [
    {
      id: 'onnx-community/whisper-small',
      label: 'Whisper small',
      license: 'MIT',
      licenseUrl: WHISPER_MIT,
      dtype: 'q8',
      approxMb: 85,
      quality: 4,
      speed: 3,
    },
    {
      id: 'onnx-community/whisper-base',
      label: 'Whisper base',
      license: 'MIT',
      licenseUrl: WHISPER_MIT,
      dtype: 'q8',
      approxMb: 45,
      quality: 3,
      speed: 5,
      licenseNote:
        'Fastest, but measured CER 1.00 on Hindi: it emits Arabic script. Kept as the\n        cheap end of the quality dial, not as a default. We also tried\n        whisper-large-v3-turbo and removed it: at q8 it returned empty transcripts\n        (CER 1.00) and cost RTF 13.9, so it was unusable rather than merely slow.',
    },
  ],
};

export const MT_SLOT: SlotSpec = {
  slot: 'mt',
  task: 'translation',
  purpose: 'Draft an English line for each cue.',
  defaultModelId: 'Xenova/opus-mt-hi-en',
  models: [
    {
      id: 'Xenova/opus-mt-hi-en',
      label: 'OPUS-MT Hindi→English',
      license: 'Apache-2.0',
      licenseUrl: 'https://huggingface.co/Helsinki-NLP/opus-mt-hi-en',
      dtype: 'q8',
      approxMb: 80,
      quality: 4,
      speed: 5,
      licenseNote: 'Best quality for Hindi. Narrow coverage: one pair only.',
    },
    {
      id: 'Xenova/m2m100_418M',
      label: 'M2M100 418M',
      license: 'MIT',
      licenseUrl: 'https://huggingface.co/facebook/m2m100_418M',
      dtype: 'q8',
      approxMb: 420,
      quality: 3,
      speed: 4,
      licenseNote: 'Covers all pairs in one model. Slower and less fluent.',
    },
  ],
  pairCoverage: {
    'hi-en': ['Xenova/opus-mt-hi-en'],
    'bn-en': ['Xenova/m2m100_418M'],
    'mr-en': ['Xenova/m2m100_418M'],
    'te-en': ['Xenova/m2m100_418M'],
    'ta-en': ['Xenova/m2m100_418M'],
    'gu-en': ['Xenova/m2m100_418M'],
    'kn-en': ['Xenova/m2m100_418M'],
    'pa-en': ['Xenova/m2m100_418M'],
    // Source already English: no MT stage is run at all.
    'en-en': [],
  },
};

export const CAPTION_SLOT: SlotSpec = {
  slot: 'caption',
  task: 'text-generation',
  purpose: 'Suggest a shorter caption. Best-effort: the Fit solver guarantees the constraints, not the model.',
  /**
   * Selected by measurement, and the measurement is unflattering.
   *
   * We wanted a small open model that reliably compresses a draft into a
   * character budget. None of these does. Across four realistic cases:
   *
   *   Qwen2.5-1.5B-Instruct   ~1/4 inside budget, and best wording when it hits
   *   SmolLM2-360M-Instruct    0/4, fluent but overruns every budget
   *   Qwen2.5-0.5B-Instruct    0/4, echoes the instruction
   *
   * Requiring JSON output made every model worse: they echo the instruction or
   * emit the schema as literal text. Dropping the JSON requirement got real
   * rewrites, so the prompt is plain text and we do the formatting ourselves.
   *
   * An earlier version of this file asserted the opposite, based on a test that
   * omitted `repetition_penalty`. The claim was wrong; `npm run bench:caption`
   * is what caught it. Qwen2.5-1.5B is the default because it wins on the cases
   * it wins, but the Fit solver treats every suggestion as optional.
   */
  defaultModelId: 'onnx-community/Qwen2.5-1.5B-Instruct',
  models: [
    {
      id: 'onnx-community/Qwen2.5-1.5B-Instruct',
      label: 'Qwen2.5 1.5B Instruct',
      license: 'Apache-2.0',
      licenseUrl: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct',
      dtype: 'q8',
      approxMb: 1650,
      quality: 4,
      speed: 2,
      licenseNote: 'Default. Best wording of the three, but only ~1 in 4 rewrites lands inside budget.',
    },
    {
      id: 'HuggingFaceTB/SmolLM2-360M-Instruct',
      label: 'SmolLM2 360M Instruct',
      license: 'Apache-2.0',
      licenseUrl: 'https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct',
      dtype: 'q8',
      approxMb: 400,
      quality: 3,
      speed: 5,
      licenseNote: 'Fastest. Fluent but overran the character budget on all four test cases.',
    },
    {
      id: 'onnx-community/Qwen2.5-0.5B-Instruct',
      label: 'Qwen2.5 0.5B Instruct',
      license: 'Apache-2.0',
      licenseUrl: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct',
      dtype: 'q8',
      approxMb: 520,
      quality: 2,
      speed: 4,
      licenseNote: 'Largest per byte and least useful: echoes the instruction rather than rewriting.',
    },
    {
      id: 'onnx-community/gemma-3-1b-it-ONNX',
      label: 'Gemma 3 1B Instruct',
      license: 'gemma',
      licenseUrl: 'https://ai.google.dev/gemma/terms',
      dtype: 'q8',
      approxMb: 1100,
      quality: 4,
      speed: 3,
      licenseNote:
        'Open weights, but NOT open source: Google Gemma Licence, not OSI-approved. Swappable in, not our default.',
    },
  ],
};

export const SLOTS: Record<Slot, SlotSpec> = {
  asr: ASR_SLOT,
  mt: MT_SLOT,
  caption: CAPTION_SLOT,
};

/** Look up a spec, throwing on an unknown id rather than silently falling back. */
export function findModel(slot: Slot, modelId: string): ModelSpec {
  const spec = SLOTS[slot].models.find((m) => m.id === modelId);
  if (!spec) {
    throw new Error(
      `Unknown model ${JSON.stringify(modelId)} for slot ${slot}. Available: ${SLOTS[slot].models.map((m) => m.id).join(', ')}`,
    );
  }
  return spec;
}

/** Pick the best available MT model for a pair, or null when none is needed. */
export function mtModelForPair(pair: LanguagePair, preferred?: string): ModelSpec | null {
  const coverage = MT_SLOT.pairCoverage?.[pair] ?? [];
  if (coverage.length === 0) return null;
  if (preferred && coverage.includes(preferred)) return findModel('mt', preferred);
  return findModel('mt', coverage[0]!);
}

export const ModelSelectionSchema = z.object({
  asr: z.string().optional(),
  mt: z.string().optional(),
  caption: z.string().optional(),
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

/** Defaults resolved once at boot so every job starts from a known state. */
export function defaultSelection(): Required<ModelSelection> {
  return {
    asr: ASR_SLOT.defaultModelId,
    mt: MT_SLOT.defaultModelId,
    caption: CAPTION_SLOT.defaultModelId,
  };
}

export const RequestedPairSchema = LanguagePairSchema;

export function isKnownPair(value: string): value is LanguagePair {
  return LanguagePairSchema.safeParse(value).success;
}