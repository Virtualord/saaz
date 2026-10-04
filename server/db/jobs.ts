import Database from 'better-sqlite3';
import { config, ensureDirs } from '../config.js';
import { log } from '../core/logger.js';
import { CueSchema, JobSchema, type Cue, type Job, type JobStatus, type Segment } from '../../shared/types.js';

/**
 * Job persistence.
 *
 * SQLite rather than a hosted database, for the same reason as everything else:
 * the data never leaves the machine. A subtitle job holds someone's unreleased
 * footage transcript, which is exactly the material we promised not to hand to a
 * third party.
 */

ensureDirs();

const db = new Database(config.paths.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    status       TEXT NOT NULL,
    source_name  TEXT NOT NULL,
    input_path   TEXT NOT NULL,
    pair         TEXT NOT NULL,
    models_used  TEXT NOT NULL,
    stage_ms     TEXT NOT NULL,
    segments     TEXT NOT NULL,
    cues         TEXT NOT NULL,
    meta         TEXT NOT NULL,
    error        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
`);

interface JobRow {
  id: string;
  status: string;
  source_name: string;
  input_path: string;
  pair: string;
  models_used: string;
  stage_ms: string;
  segments: string;
  cues: string;
  meta: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const insertStmt = db.prepare(`
  INSERT INTO jobs (id, status, source_name, input_path, pair, models_used, stage_ms, segments, cues, meta, error, created_at, updated_at)
  VALUES (@id, @status, @source_name, @input_path, @pair, @models_used, @stage_ms, @segments, @cues, @meta, @error, @created_at, @updated_at)
`);

const updateStmt = db.prepare(`
  UPDATE jobs SET status=@status, cues=@cues, stage_ms=@stage_ms, models_used=@models_used, error=@error, updated_at=@updated_at
  WHERE id=@id
`);

const selectStmt = db.prepare('SELECT * FROM jobs WHERE id = ?');
const listStmt = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?');

function rowToJob(row: JobRow): Job {
  return JobSchema.parse({
    id: row.id,
    status: row.status,
    stageMs: JSON.parse(row.stage_ms),
    sourceName: row.source_name,
    pair: row.pair,
    modelsUsed: JSON.parse(row.models_used),
    segments: JSON.parse(row.segments),
    cues: JSON.parse(row.cues),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function createJob(input: {
  id: string;
  sourceName: string;
  inputPath: string;
  pair: string;
  modelsUsed: Record<string, string>;
}): void {
  const now = new Date().toISOString();
  insertStmt.run({
    id: input.id,
    status: 'queued',
    source_name: input.sourceName,
    input_path: input.inputPath,
    pair: input.pair,
    models_used: JSON.stringify(input.modelsUsed),
    stage_ms: '{}',
    segments: '[]',
    cues: '[]',
    meta: '{}',
    error: null,
    created_at: now,
    updated_at: now,
  });
  log.info('db.create_job', { id: input.id, source: input.sourceName });
}

export function saveJobResult(input: {
  id: string;
  status: JobStatus;
  segments: Segment[];
  cues: Cue[];
  stageMs: Record<string, number>;
  modelsUsed: Record<string, string>;
  error?: string | null;
}): void {
  // Validate before persisting: a malformed cue must never reach a render.
  const cues = input.cues.map((c) => CueSchema.parse(c));
  updateStmt.run({
    id: input.id,
    status: input.status,
    cues: JSON.stringify(cues),
    stage_ms: JSON.stringify(input.stageMs),
    models_used: JSON.stringify(input.modelsUsed),
    error: input.error ?? null,
    updated_at: new Date().toISOString(),
  });
  log.info('db.save_job', { id: input.id, status: input.status, cues: cues.length });
}

/** Replace the cues after a human edit, so exports reflect the review. */
export function saveEditedCues(id: string, cues: Cue[]): Cue[] {
  const validated = cues.map((c) => CueSchema.parse(c));
  db.prepare('UPDATE jobs SET cues = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(validated),
    new Date().toISOString(),
    id,
  );
  return validated;
}

export function getJob(id: string): Job | null {
  const row = selectStmt.get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function listJobs(limit = 25): Job[] {
  return (listStmt.all(limit) as JobRow[]).map(rowToJob);
}