import path from 'node:path';
import fs from 'node:fs';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

const modelDir = path.resolve(envStr('SAAZ_MODEL_DIR', './data/models'));

export const config = {
  port: envInt('PORT', 8080),
  nodeEnv: envStr('NODE_ENV', 'development'),
  isProd: envStr('NODE_ENV', 'development') === 'production',

  paths: {
    modelDir,
    uploadDir: path.resolve('./data/uploads'),
    outDir: path.resolve('./data/out'),
    dbFile: path.resolve('./data/saaz.db'),
  },

  limits: {
    maxUploadBytes: envInt('SAAZ_MAX_UPLOAD_MB', 200) * 1024 * 1024,
    /** Hard ceiling on any single media probe, so a malformed file can't hang us. */
    probeTimeoutMs: envInt('SAAZ_PROBE_TIMEOUT_MS', 20_000),
    /** Per-stage budget for ASR. A long file should fail loudly, not silently. */
    asrTimeoutMs: envInt('SAAZ_ASR_TIMEOUT_MS', 30 * 60_000),
  },

  observability: {
    sentryDsn: process.env.SENTRY_DSN ?? null,
    tracesSampleRate: Number.parseFloat(envStr('SENTRY_TRACES_SAMPLE_RATE', '1.0')),
    /**
     * Emit one structured JSON line per finished span.
     *
     * Off by default because the in-memory trace store plus the /api/traces
     * inspector already cover inspection, and a log line per span is noise in
     * normal operation. Turn it on when triaging.
     */
    emitJsonSpans: envStr('SAAZ_EMIT_SPANS', 'false') === 'true',
    /** Retained traces in the ring buffer. */
    traceBufferSize: envInt('SAAZ_TRACE_BUFFER', 60),
  },
} as const;

export function ensureDirs(): void {
  for (const dir of [config.paths.modelDir, config.paths.uploadDir, config.paths.outDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}