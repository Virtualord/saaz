/**
 * Structured JSON logging to stdout.
 *
 * In production this is what a log shipper ingests; in development it is still
 * one line per event so the terminal stays readable. Every pipeline stage emits
 * through here so a single failed job can be reconstructed from its logs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = JSON.stringify(record, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v,
  );
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit('error', msg, f),
};

/** Measures a named pipeline stage and logs its duration. */
export async function timed<T>(stage: string, fields: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const out = await fn();
    log.info('stage.ok', { stage, ms: Math.round(performance.now() - t0), ...fields });
    return out;
  } catch (err) {
    log.error('stage.fail', { stage, ms: Math.round(performance.now() - t0), ...fields, err });
    throw err;
  }
}