import fs from 'node:fs';
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';
import { config } from '../config.js';
import { log } from '../core/logger.js';
import { SLOTS, type ModelSpec, type Slot, findModel } from './registry.js';

/**
 * One runtime for all three model kinds.
 *
 * Whisper (seq2seq), OPUS-MT (seq2seq) and Qwen/Gemma (text-gen) all run through
 * transformers.js on onnxruntime-node. That is a deliberate architectural
 * choice: a single inference runtime keeps the process small enough to explain
 * on one diagram, and keeps CPU memory in one place we can budget.
 */
env.cacheDir = config.paths.modelDir;
env.allowLocalModels = true;
env.allowRemoteModels = true;

export type AnyPipeline = Awaited<ReturnType<typeof pipeline>>;

const loaded = new Map<string, AnyPipeline>();
const loadMs = new Map<string, number>();

function cacheKey(slot: Slot, model: ModelSpec): string {
  return `${slot}:${model.id}:${model.dtype}`;
}

/**
 * Load (or reuse) a pipeline. Serialised per key so two concurrent jobs asking
 * for the same model trigger exactly one load rather than racing to write the
 * same cache files.
 */
const inFlight = new Map<string, Promise<AnyPipeline>>();

export async function loadModel(slot: Slot, modelId: string): Promise<AnyPipeline> {
  const model = findModel(slot, modelId);
  const key = cacheKey(slot, model);

  const existing = loaded.get(key);
  if (existing) return existing;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const t0 = performance.now();
    log.info('model.load.start', { slot, model: model.id, dtype: model.dtype, license: model.license });
    try {
      const pipe = (await pipeline(SLOTS[slot].task, model.id, {
        dtype: model.dtype as 'q8',
      })) as AnyPipeline;
      const ms = Math.round(performance.now() - t0);
      loaded.set(key, pipe);
      loadMs.set(key, ms);
      log.info('model.load.ok', { slot, model: model.id, ms });
      return pipe;
    } catch (err) {
      log.error('model.load.fail', { slot, model: model.id, err });
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}

/**
 * Whether a model's weights are on disk right now.
 *
 * This is what backs the "runs with the network unplugged" claim, so it is read
 * from the filesystem rather than assumed. transformers.js nests weights under
 * an `onnx/` subdirectory, so we check the whole subtree for a real `.onnx` file
 * and reject a download that never finished.
 */
export function isCachedLocally(modelId: string): boolean {
  const dir = path.join(config.paths.modelDir, ...modelId.split('/'));
  if (!fs.existsSync(dir)) return false;

  let sawModel = false;
  const walk = (current: string, depth: number): boolean => {
    if (depth > 3) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (walk(full, depth + 1)) return true;
      } else if (entry.name.endsWith('.onnx')) {
        // A zero-byte file is a stub, not a usable model.
        try {
          if (fs.statSync(full).size > 1024) sawModel = true;
        } catch {
          /* ignore */
        }
      }
    }
    return sawModel;
  };

  return walk(dir, 0);
}

/** Silero VAD is loaded directly from a fixed path, outside the transformers cache. */
export function vadCachedLocally(): boolean {
  const p = path.join(config.paths.modelDir, 'silero-vad', 'model_int8.onnx');
  try {
    return fs.statSync(p).size > 10_000;
  } catch {
    return false;
  }
}

export interface SlotHealth {
  slot: Slot;
  purpose: string;
  defaultModelId: string;
  models: Array<
    ModelSpec & {
      cachedLocally: boolean;
      loaded: boolean;
      loadMs: number | null;
    }
  >;
}

/**
 * Truthful model status. `cachedLocally` is what lets us claim the app runs
 * with the network off, so it is computed from the filesystem rather than
 * assumed.
 */
export function modelHealth(): SlotHealth[] {
  return (Object.keys(SLOTS) as Slot[]).map((slot) => {
    const spec = SLOTS[slot];
    return {
      slot,
      purpose: spec.purpose,
      defaultModelId: spec.defaultModelId,
      models: spec.models.map((m) => {
        const key = cacheKey(slot, m);
        return {
          ...m,
          cachedLocally: isCachedLocally(m.id),
          loaded: loaded.has(key),
          loadMs: loadMs.get(key) ?? null,
        };
      }),
    };
  });
}

/**
 * True when every model a job needs is already on disk, including the VAD.
 * Reported honestly: the offline claim is only true if all of it is present.
 */
export function canRunOffline(selection: Record<Slot, string>, pair: string): boolean {
  const needed: string[] = [selection.asr];
  if (pair !== 'en-en' && selection.mt) needed.push(selection.mt);
  needed.push(selection.caption);
  return needed.every((id) => isCachedLocally(id)) && vadCachedLocally();
}