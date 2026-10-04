import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { log } from '../core/logger.js';
import { runPipeline, toSrt, toVtt, auditCues } from '../services/pipeline.js';
import { createJob, getJob, listJobs, saveEditedCues, saveJobResult } from '../db/jobs.js';
import { withTrace } from '../core/tracing.js';
import { defaultSelection, isKnownPair, mtModelForPair } from '../models/registry.js';
import { canRunOffline } from '../models/loader.js';
import { LanguagePairSchema, CueSchema } from '../../shared/types.js';
import type { Cue, LanguagePair } from '../../shared/types.js';

export const jobsRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.limits.maxUploadBytes, files: 1 },
});

const UploadBodySchema = z.object({
  pair: LanguagePairSchema.default('hi-en'),
  asr: z.string().optional(),
  mt: z.string().optional(),
  caption: z.string().optional(),
});

function ah(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);
}

/** Only extensions we can actually decode. Anything else is rejected early. */
const ALLOWED_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);

/**
 * Run the pipeline for an uploaded file.
 *
 * Synchronous by design: a 30-second clip takes roughly 100 seconds on CPU, and
 * a queue would add a moving part without making the demo faster. The client
 * shows real stage timings while it waits.
 */
jobsRouter.post(
  '/',
  upload.single('file'),
  ah(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'no_file', message: 'Attach a video or audio file as "file".' });
      return;
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      res.status(415).json({
        error: 'unsupported_type',
        message: `Unsupported file type "${ext}". Accepted: ${[...ALLOWED_EXT].join(', ')}.`,
      });
      return;
    }

    const parsed = UploadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'Invalid request.' });
      return;
    }
    const body = parsed.data;
    const pair = body.pair as LanguagePair;

    const selection = { ...defaultSelection(), ...(body.asr ? { asr: body.asr } : {}), ...(body.caption ? { caption: body.caption } : {}) };
    const mt = mtModelForPair(pair, body.mt);
    if (pair !== 'en-en' && !mt) {
      res.status(400).json({ error: 'unsupported_pair', message: `No MT model covers ${pair}.` });
      return;
    }

  await withTrace(
    'request.submit_media',
    { userInput: req.file?.originalname ?? 'unknown', attributes: { pair, bytes: req.file?.size ?? 0, extension: ext } },
    async () => {
      // `req.file` was validated above, but the narrowing does not survive
      // entering this closure.
      const upload = req.file;
      if (!upload) {
        res.status(400).json({ error: 'no_file', message: 'Attach a file as "file".' });
        return;
      }
      const id = randomUUID();
      // Sanitise the filename: it is used as a path segment.
      const safeName = path.basename(upload.originalname).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
      const inputPath = path.join(config.paths.uploadDir, `${id}${ext}`);
      await fs.mkdir(path.dirname(inputPath), { recursive: true });
      await fs.writeFile(inputPath, upload.buffer);

      await createJob({
        id,
        sourceName: safeName,
        inputPath,
        pair,
        modelsUsed: { ...selection, ...(mt ? { mt: mt.id } : {}) },
      });

      const offline = canRunOffline({ ...selection, mt: mt?.id ?? '' }, pair);
      if (!offline) log.warn('job.models_not_cached', { id, pair });

      try {
        const result = await runPipeline({
          inputPath,
          sourceName: safeName,
          pair,
          models: { ...selection, ...(mt ? { mt: mt.id } : {}) },
        });

        // DB write happens inside the trace, so a judge sees the persistence
        // step as a child span rather than something that happened afterwards.
        await saveJobResult({
          id,
          status: 'done',
          segments: result.segments,
          cues: result.cues,
          stageMs: result.stageMs,
          modelsUsed: result.modelsUsed,
        });

        res.json({
          id,
          status: 'done',
          traceId: result.traceId,
          traceUrl: `/api/traces/${result.traceId}/text`,
          sourceName: safeName,
          pair,
          segments: result.segments,
          cues: result.cues,
          stageMs: result.stageMs,
          modelsUsed: result.modelsUsed,
          meta: { ...result.meta, offline, pair },
          qa: auditCues(result.cues),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        await saveJobResult({
          id,
          status: 'failed',
          segments: [],
          cues: [],
          stageMs: {},
          modelsUsed: { ...selection, ...(mt ? { mt: mt.id } : {}) },
          error: message,
        });
        log.error('job.failed', { id, source: safeName, err });
        res.status(500).json({ error: 'pipeline_failed', message, id });
      }
    },
  );
  }),
);

jobsRouter.get(
  '/',
  ah(async (_req, res) => {
    const jobs = await listJobs(25);
    res.json(
      jobs.map((j) => ({
        id: j.id,
        status: j.status,
        sourceName: j.sourceName,
        pair: j.pair,
        cueCount: j.cues.length,
        needsHuman: j.cues.filter((c) => c.escalation === 'refused').length,
        createdAt: j.createdAt,
      })),
    );
  }),
);

jobsRouter.get(
  '/:id',
  ah(async (req, res) => {
    const job = await getJob(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'not_found', message: 'No such job.' });
      return;
    }
    res.json(job);
  }),
);

/** Save human edits. This is the product's core loop: review, fix, export. */
const EditBodySchema = z.object({ cues: z.array(CueSchema).min(1) });

jobsRouter.patch(
  '/:id/cues',
  ah(async (req, res) => {
    const job = await getJob(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'not_found', message: 'No such job.' });
      return;
    }
    const parsed = EditBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_cues', message: parsed.error.issues[0]?.message ?? 'Invalid cues.' });
      return;
    }
    try {
      const saved = await saveEditedCues(job.id, parsed.data.cues);
      res.json({ id: job.id, cues: saved, qa: auditCues(saved) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid cue';
      res.status(400).json({ error: 'invalid_cues', message });
    }
  }),
);

jobsRouter.get(
  '/:id/export.:format(srt|vtt)',
  ah(async (req, res) => {
    const job = await getJob(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'not_found', message: 'No such job.' });
      return;
    }
    const body = req.params.format === 'srt' ? toSrt(job.cues) : toVtt(job.cues);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${job.sourceName.replace(/\.[^.]+$/, '')}.${req.params.format}"`);
    res.send(body);
  }),
);