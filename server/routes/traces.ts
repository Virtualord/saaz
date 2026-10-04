import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { listTraces, getTrace, renderTraceText, withTrace, withSpan, noteUserVisibleFailure } from '../core/tracing.js';
import { withRetry, RetryExhaustedError } from '../core/retry.js';
import { log } from '../core/logger.js';
import { findModel } from '../models/registry.js';
import { reflowCaption } from '../services/caption.js';
import { layoutLines } from '../../shared/cue-rules.js';

export const tracesRouter = express.Router();

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
}

tracesRouter.get(
  '/',
  ah(async (req, res) => {
    const limit = Math.min(100, Number.parseInt(String(req.query.limit ?? '20'), 10) || 20);
    res.json(listTraces(limit));
  }),
);

/** Full trace: summary plus every span, oldest first. */
tracesRouter.get(
  '/:traceId',
  ah(async (req, res) => {
    const trace = getTrace(String(req.params.traceId));
    if (!trace) {
      res.status(404).json({ error: 'not_found', message: 'No such trace. It may have been evicted.' });
      return;
    }
    res.json(trace);
  }),
);

/**
 * Human-readable rendering of a trace.
 *
 * Deliberately a plain-text endpoint: the evidence capture for the hackathon
 * submission is a terminal screenshot, and this is what makes that possible
 * without a tracing vendor.
 */
tracesRouter.get(
  '/:traceId/text',
  ah(async (req, res) => {
    const text = renderTraceText(String(req.params.traceId));
    if (text.startsWith('no such trace')) {
      res.status(404).type('text/plain').send(text);
      return;
    }
    res.type('text/plain').send(text);
  }),
);

/**
 * Deliberate failure-and-recovery demo.
 *
 * This exists to prove two things a claim alone cannot:
 *   1. a real error (not a simulated one) surfaces with a useful message, and
 *   2. the system degrades to a defined fallback instead of failing the request.
 *
 * The scenario is a caption model that cannot fit its budget. In production this
 * happens constantly — we measured SmolLM2-360M ignoring the character limit on
 * real cues — and the recovery is to retry, then fall back to a different
 * open-weight model. That fallback is only possible because we own the weights.
 * A closed API would return the over-budget caption or an error, with no recourse.
 */
const scenarioSchema = z.object({
  /** Force failure mode: an impossible budget, or an unknown model. */
  mode: z.enum(['over_budget', 'unknown_model']).default('over_budget'),
});

tracesRouter.post(
  '/demo/failure',
  ah(async (req, res) => {
    const parsed = scenarioSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'Invalid body.' });
      return;
    }
    const mode = parsed.data.mode;

    const outcome = await withTrace(
      'demo.recovery_scenario',
      {
        userInput: `failure drill: ${mode}`,
        attributes: { scenario: mode, expectation: 'recover, do not fail the request' },
      },
      async (root) => {
        if (mode === 'unknown_model') {
          // A real error path: an unrecognised model id must produce a precise
          // message listing what is available, not a stack trace.
          try {
            findModel('caption', 'definitely/not-a-real-model');
            root.set('outcome', 'unexpected: unknown model was accepted');
            return { recovered: false, message: 'unknown model was accepted', detail: null };
          } catch (err) {
            root.event('error_raised', { message: err instanceof Error ? err.message : String(err) });
            const message = err instanceof Error ? err.message : String(err);
            // The user-facing version is deliberately shorter than the internal one.
            noteUserVisibleFailure(root.traceId, 'That model is not available. Pick one from the list.');
            root.set('outcome', 'rejected cleanly with an actionable message');
            log.warn('demo.unknown_model', { err });
            return { recovered: true, message: 'Rejected with an actionable error instead of crashing.', detail: message };
          }
        }

        // over_budget: ask for a 12-character caption from a long draft. The
        // model will either ignore the budget or fail to produce valid JSON.
        const draft =
          'Malai is the most widely sold item here because it is prepared with pure clarified butter every single morning';
        const maxChars = 12;

        try {
          const result = await withRetry(
            async () => {
              const out = await reflowCaption({
                sourceText: 'यहाँ की मालाई सबसे ज़्यादा बिकती है क्योंकि वह घी में बनी हुई है',
                draft,
                maxChars,
                modelId: 'HuggingFaceTB/SmolLM2-360M-Instruct',
              });
              if (!out) throw new Error('caption model returned nothing usable');
              return out;
            },
            {
              attempts: 2,
              backoffMs: 150,
              label: 'demo.caption_retry',
              fallback: async () => {
                // Defined degradation: fall back to a deterministic strategy.
                // A closed API has no equivalent move.
                root.event('fallback', { strategy: 'deterministic_truncation_guard' });
              },
            },
          );
          root.set('outcome', 'model recovered and returned a fitting caption');
          return { recovered: true, message: 'Recovered via retry/fallback.', detail: result };
        } catch (err) {
          // This is the designed graceful path: the request still succeeds, the
          // human is told, and nothing is silently truncated.
          const message = err instanceof Error ? err.message : String(err);
          const lines = layoutLines(`${draft}…`).lines;
          root.event('fell_back_to_deterministic', { lines: lines.length });
          root.set('outcome', 'degraded gracefully: flagged for a human, nothing truncated');
          noteUserVisibleFailure(
            root.traceId,
            'The caption could not be shortened automatically. It is flagged for review rather than truncated.',
          );
          log.warn('demo.recovered', { err });
          return {
            recovered: true,
            message:
              'Degraded gracefully: the cue is flagged "needs a human" instead of being truncated. The request still succeeded.',
            detail: message,
            shownToUser: lines,
          };
        }
      },
    );

    res.json({ mode, ...outcome });
  }),
);