import { useCallback, useEffect, useRef, useState } from 'react';
import type { Cue, Segment } from '../../../shared/types';

export interface SlotModel {
  id: string;
  label: string;
  license: string;
  licenseUrl?: string;
  licenseNote?: string;
  dtype: string;
  approxMb: number;
  quality: number;
  speed: number;
}

export interface SlotInfo {
  slot: 'asr' | 'mt' | 'caption';
  task: string;
  purpose: string;
  defaultModelId: string;
  models: SlotModel[];
}

export interface HealthModel extends SlotModel {
  cachedLocally: boolean;
  loaded: boolean;
  loadMs: number | null;
}

export interface HealthSlot {
  slot: 'asr' | 'mt' | 'caption';
  purpose: string;
  defaultModelId: string;
  models: HealthModel[];
}

export interface Health {
  status: string;
  version: string;
  uptimeMs: number;
  inference: {
    runtime: string;
    device: string;
    remoteApisUsed: string[];
    defaultsCachedLocally: boolean;
  };
  slots: HealthSlot[];
}

export interface JobResult {
  id: string;
  status: 'done' | 'failed';
  sourceName: string;
  pair: string;
  segments: Segment[];
  cues: Cue[];
  stageMs: Record<string, number>;
  modelsUsed: Record<string, string>;
  meta: {
    durationMs: number;
    speechRegions: number;
    needsHuman: number;
    glossaryApplied: string[];
    offline: boolean;
  };
  qa: Array<{ index: number; warnings: string[] }>;
}

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  const r = await fetch('/api/health', { signal });
  if (!r.ok) throw new Error(`health check failed: ${r.status}`);
  return r.json() as Promise<Health>;
}

/**
 * Upload and run the pipeline, reporting progress as it goes.
 *
 * The request is synchronous, so "progress" means the stages we can honestly
 * report have started, plus elapsed time. We do not invent a percentage.
 */
export function runJob(
  file: File,
  opts: { pair: string; models: Record<string, string> },
  onStage?: (stage: string) => void,
): { promise: Promise<JobResult>; abort: () => void } {
  const controller = new AbortController();
  const form = new FormData();
  form.append('file', file);
  form.append('pair', opts.pair);
  for (const [k, v] of Object.entries(opts.models)) {
    if (v) form.append(k, v);
  }

  onStage?.('uploading');

  const promise = (async () => {
    const res = await fetch('/api/jobs', { method: 'POST', body: form, signal: controller.signal });
    const payload = (await res.json()) as JobResult | { error: string; message: string };
    if (!res.ok) {
      const message = 'message' in payload ? payload.message : 'Request failed';
      throw new Error(message);
    }
    return payload as JobResult;
  })();

  return { promise, abort: () => controller.abort() };
}

export function useHealth(pollMs = 15000): { health: Health | null; error: string | null } {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      setHealth(await fetchHealth(signal));
      setError(null);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'unreachable');
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void refresh(ac.signal);
    const t = setInterval(() => void refresh(ac.signal), pollMs);
    return () => {
      ac.abort();
      clearInterval(t);
    };
  }, [refresh, pollMs]);

  return { health, error };
}

export function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const ref = useRef<string | null>(null);

  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    ref.current = next;
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
      ref.current = null;
    };
  }, [file]);

  return url;
}