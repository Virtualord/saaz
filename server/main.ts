import path from 'node:path';
import fs from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import * as Sentry from '@sentry/node';
import { config, ensureDirs } from './config.js';
import { log } from './core/logger.js';
import { modelHealth, vadCachedLocally } from './models/loader.js';
import { SLOTS } from './models/registry.js';
import { jobsRouter } from './routes/jobs.js';
import { tracesRouter } from './routes/traces.js';

if (config.observability.sentryDsn) {
  Sentry.init({
    dsn: config.observability.sentryDsn,
    tracesSampleRate: config.observability.tracesSampleRate,
  });
  log.info('sentry.init', { tracesSampleRate: config.observability.tracesSampleRate });
} else {
  log.info('sentry.disabled', { reason: 'SENTRY_DSN not set — tracing goes to stdout' });
}

ensureDirs();

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

/** Wraps an async route so a rejected promise reaches the error handler. */
function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

const startedAt = Date.now();

app.get(
  '/api/health',
  ah(async (_req, res) => {
    const slots = modelHealth();
    const defaultsCached = slots.every((s) => {
      const def = s.models.find((m) => m.id === s.defaultModelId);
      return def?.cachedLocally ?? false;
    });

    res.json({
      status: 'ok',
      version: process.env.npm_package_version ?? '0.1.0',
      uptimeMs: Date.now() - startedAt,
      // Honest by construction: computed from the filesystem, never assumed.
      inference: {
        runtime: 'transformers.js over onnxruntime-node',
        device: 'cpu',
        remoteApisUsed: [],
        vadCachedLocally: vadCachedLocally(),
        defaultsCachedLocally: defaultsCached && vadCachedLocally(),
      },
      slots,
    });
  }),
);

app.use('/api/jobs', jobsRouter);
app.use('/api/traces', tracesRouter);

app.get('/api/slots', (_req, res) => {
  res.json(
    Object.values(SLOTS).map((s) => ({
      slot: s.slot,
      task: s.task,
      purpose: s.purpose,
      defaultModelId: s.defaultModelId,
      models: s.models.map(({ id, label, license, licenseUrl, licenseNote, dtype, approxMb, quality, speed }) => ({
        id,
        label,
        license,
        licenseUrl,
        licenseNote,
        dtype,
        approxMb,
        quality,
        speed,
      })),
    })),
  );
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Unknown API route.' });
});

// Serve the built frontend, and fall back to index.html so client routing works.
const webDir = path.resolve('dist/web');
if (fs.existsSync(webDir)) {
  app.use(express.static(webDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(webDir, 'index.html'));
  });
  log.info('web.serving', { dir: webDir });
} else {
  app.get('/', (_req, res) => {
    res.status(503).send('Frontend not built. Run: npm run build:web');
  });
  log.warn('web.missing_build', { expected: webDir });
}

// Central error handler. Never leak a stack trace to the client.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : 'Unknown error';
  log.error('http.error', { path: req.path, err });
  if (config.observability.sentryDsn) Sentry.captureException(err);
  res.status(500).json({ error: 'internal_error', message });
});

const server = app.listen(config.port, () => {
  log.info('server.listening', { port: config.port, env: config.nodeEnv });
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('server.shutdown', { signal });
    server.close(() => process.exit(0));
    // Don't let a hung connection block the exit forever.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}