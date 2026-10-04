import { z } from 'zod';

/**
 * Subtitle geometry and constraints.
 *
 * These are the invariants the whole pipeline exists to protect. Broadcast and
 * platform subtitling conventions: at most two lines, roughly 42 characters per
 * line, and a maximum reading speed (characters per second) below which a
 * viewer cannot actually read.
 */
export const subtitleConstraints = {
  maxLines: 2,
  maxCharsPerLine: 42,
  /** Reading-speed ceiling, characters per second. */
  maxCps: 17,
  /** Never display a cue shorter than this, it reads as a flicker. */
  minCueMs: 900,
  /** Prefer this much silence between cues. */
  minGapMs: 80,
  /** Hard ceiling used when a cue has to be extended into a neighbour's gap. */
  maxExtensionMs: 1200,
} as const;

export const LanguagePairSchema = z.enum(['hi-en', 'bn-en', 'mr-en', 'te-en', 'ta-en', 'gu-en', 'kn-en', 'pa-en', 'en-en']);
export type LanguagePair = z.infer<typeof LanguagePairSchema>;

/** A single timed piece of dialogue, straight from ASR. */
export const SegmentSchema = z.object({
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  text: z.string(),
  /** Model-reported confidence, 0..1. ASR-stage only. */
  asrConfidence: z.number().min(0).max(1).nullable(),
  /** True when ASR produced this from silence or music. */
  suspectedHallucination: z.boolean(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const FitEscalationSchema = z.enum(['verbatim', 'resegmented', 'reflowed', 'extended', 'refused']);
export type FitEscalation = z.infer<typeof FitEscalationSchema>;

/**
 * The machine-readable result for one cue. This schema is the contract every
 * model in the `caption` slot must satisfy — it is what makes swapping a model
 * safe rather than reckless.
 */
export const CueSchema = z.object({
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  sourceText: z.string().min(1),
  /** Present when the source and target language differ. */
  translation: z.string().nullable(),
  lines: z.array(z.string().min(1)).min(1).max(subtitleConstraints.maxLines),
  escalation: FitEscalationSchema,
  /** Populated when escalation === 'refused', explaining what a human must fix. */
  refusalReason: z.string().nullable(),
  /** Derived QA measurements, filled by the solver rather than the model. */
  chars: z.number().int().nonnegative(),
  cps: z.number().nonnegative(),
  warnings: z.array(z.string()),
});
export type Cue = z.infer<typeof CueSchema>;

/** Structured output the caption model must emit. Validated before it is trusted. */
export const CaptionDraftSchema = z.object({
  lines: z.array(z.string().min(1)).min(1).max(subtitleConstraints.maxLines),
  /** Model's own note when it could not fit the meaning into the budget. */
  note: z.string().default(''),
});
export type CaptionDraft = z.infer<typeof CaptionDraftSchema>;

export const JobStatusSchema = z.enum(['queued', 'probing', 'transcribing', 'translating', 'fitting', 'rendering', 'done', 'failed']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSchema = z.object({
  id: z.string().uuid(),
  status: JobStatusSchema,
  /** Wall-clock ms per stage, for the observability panel and for tuning. */
  stageMs: z.record(z.string(), z.number()),
  sourceName: z.string(),
  pair: LanguagePairSchema,
  modelsUsed: z.record(z.string(), z.string()),
  segments: z.array(SegmentSchema),
  cues: z.array(CueSchema),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Job = z.infer<typeof JobSchema>;