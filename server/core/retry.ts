import { withSpan, type Span } from './tracing.js';
import { log } from './logger.js';

/**
 * Retry with bounded backoff, plus an optional fallback.
 *
 * Two things this buys that a bare try/catch does not:
 *
 *  1. Every attempt is its own span, parented to the logical operation, so a
 *     judge inspecting a trace can see "caption model failed, retried on the
 *     fallback, succeeded" rather than a single opaque span.
 *  2. The distinction that matters for this product: an error that was
 *     *recovered from* is not the same as a failure the user saw. Retries that
 *     succeed mark the span `ok` and record an event; only the final give-up
 *     propagates.
 *
 * Retries are deliberately not applied to every stage. Retrying ffmpeg on a
 * corrupt file just wastes 20 seconds, so callers opt in per operation.
 */

export interface RetryOptions {
  attempts: number;
  /** Base backoff in ms; grows exponentially per attempt. */
  backoffMs?: number;
  /** Only retry these error messages/patterns. Omit to retry everything. */
  retryOn?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, willRetry: boolean) => void;
  /** Label used in the trace, e.g. "model:caption". */
  label?: string;
  /** Alternative attempt, e.g. a different model id. */
  fallback?: () => Promise<void> | void;
}

export class RetryExhaustedError extends Error {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const backoff = opts.backoffMs ?? 250;
  const label = opts.label ?? 'operation';

  return withSpan(
    label,
    { kind: 'agent', attributes: { maxAttempts: opts.attempts, hasFallback: Boolean(opts.fallback) } },
    async (span: Span) => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= opts.attempts; attempt++) {
        try {
          const result = await fn(attempt);
          if (attempt > 1) {
            // Recovered. The logical operation succeeded, so the span is `ok`.
            span.event('recovered', { attempt, afterErrors: attempt - 1 });
          }
          return result;
        } catch (err) {
          lastError = err;
          const willRetry = attempt < opts.attempts;
          span.event('attempt_failed', {
            attempt,
            willRetry,
            error: err instanceof Error ? err.message : String(err),
          });
          log.warn('retry.attempt_failed', {
            label,
            attempt,
            willRetry,
            err,
          });
          opts.onRetry?.(err, attempt, willRetry);

          if (!willRetry) break;
          if (opts.retryOn && !opts.retryOn(err)) {
            span.event('not_retryable', { attempt });
            break;
          }
          await sleep(backoff * 2 ** (attempt - 1));
        }
      }

      // Out of attempts. Try the fallback once before giving up: for this
      // project that usually means a different model, which is exactly the
      // capability open weights give us and a closed API does not.
      if (opts.fallback) {
        span.event('trying_fallback', { afterAttempts: opts.attempts });
        log.info('retry.fallback', { label, afterAttempts: opts.attempts });
        try {
          await opts.fallback();
          const result = await fn(opts.attempts + 1);
          span.event('fallback_succeeded', {});
          span.set('recoveredByFallback', true);
          return result;
        } catch (err) {
          span.event('fallback_failed', { error: err instanceof Error ? err.message : String(err) });
          lastError = err;
        }
      }

      span.fail(lastError);
      throw new RetryExhaustedError(
        `${label} failed after ${opts.attempts} attempt${opts.attempts > 1 ? 's' : ''}: ` +
          (lastError instanceof Error ? lastError.message : String(lastError)),
        opts.attempts,
        lastError,
      );
    },
  );
}