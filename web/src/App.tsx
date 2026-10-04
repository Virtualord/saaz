import { useEffect, useMemo, useRef, useState } from 'react';
import { runJob, useHealth, useObjectUrl, type JobResult } from './lib/api';
import { CueEditor } from './components/CueEditor';
import { ProvenancePanel } from './components/ProvenancePanel';
import type { Cue } from '../../shared/types';

const PAIRS = [
  { value: 'hi-en', label: 'Hindi → English' },
  { value: 'bn-en', label: 'Bengali → English' },
  { value: 'mr-en', label: 'Marathi → English' },
  { value: 'te-en', label: 'Telugu → English' },
  { value: 'ta-en', label: 'Tamil → English' },
  { value: 'gu-en', label: 'Gujarati → English' },
  { value: 'kn-en', label: 'Kannada → English' },
  { value: 'pa-en', label: 'Punjabi → English' },
  { value: 'en-en', label: 'English (transcribe only)' },
];

/** Ordered to match the pipeline, so the progress list is not a guess. */
const STAGE_LABELS: Array<[string, string]> = [
  ['uploading', 'Uploading'],
  ['probe', 'Probing media'],
  ['decode', 'Decoding audio'],
  ['transcribe', 'Transcribing (Whisper)'],
  ['vad_align', 'Finding speech boundaries (Silero VAD)'],
  ['segment', 'Building cues'],
  ['translate', 'Drafting translation (OPUS-MT)'],
  ['fit', 'Fitting to time budget'],
];

export function App() {
  const { health, error: healthError } = useHealth();
  const [file, setFile] = useState<File | null>(null);
  const [pair, setPair] = useState('hi-en');
  const [models, setModels] = useState<Record<string, string>>({});
  const [job, setJob] = useState<JobResult | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string>('uploading');
  const [failure, setFailure] = useState<string | null>(null);
  const [showProvenance, setShowProvenance] = useState(false);
  const abortRef = useRef<(() => void) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const videoUrl = useObjectUrl(file);

  useEffect(() => {
    if (job) setCues(job.cues);
  }, [job]);

  const dirty = useMemo(
    () => (job ? JSON.stringify(job.cues) !== JSON.stringify(cues) : false),
    [job, cues],
  );

  async function handleRun() {
    if (!file || busy) return;
    setBusy(true);
    setFailure(null);
    setJob(null);
    setStage('uploading');
    const { promise, abort } = runJob(file, { pair, models }, setStage);
    abortRef.current = abort;
    try {
      const result = await promise;
      setJob(result);
      setStage('done');
    } catch (err) {
      if ((err as Error).name === 'AbortError') setFailure('Cancelled.');
      else setFailure(err instanceof Error ? err.message : 'Something went wrong.');
      setStage('idle');
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.();
  }

  const needsHuman = cues.filter((c) => c.escalation === 'refused').length;

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <h1>Saaz</h1>
          <p className="tagline">Subtitles and translation, generated on this machine.</p>
        </div>
        <button
          className="ghost"
          onClick={() => setShowProvenance((v) => !v)}
          aria-expanded={showProvenance}
        >
          {showProvenance ? 'Hide' : 'What is running?'}
        </button>
      </header>

      {showProvenance && <ProvenancePanel health={health} error={healthError} />}

      <section className="intake">
        <label className="drop" htmlFor="file">
          <input
            id="file"
            ref={fileInput}
            type="file"
            accept="video/*,audio/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <span className="drop-title">{file ? file.name : 'Choose a video or audio file'}</span>
          <span className="drop-hint">
            {file
              ? `${(file.size / 1024 / 1024).toFixed(1)} MB · stays on this machine`
              : 'MP4, MOV, WebM, MP3, WAV, M4A · nothing is uploaded anywhere else'}
          </span>
        </label>

        <div className="controls">
          <label>
            <span>Language</span>
            <select value={pair} onChange={(e) => setPair(e.target.value)} disabled={busy}>
              {PAIRS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          {health && (
            <div className="model-dials">
              {health.slots.map((slot) => (
                <label key={slot.slot}>
                  <span title={slot.purpose}>{slot.slot}</span>
                  <select
                    value={models[slot.slot] ?? slot.defaultModelId}
                    onChange={(e) => setModels((m) => ({ ...m, [slot.slot]: e.target.value }))}
                    disabled={busy}
                  >
                    {slot.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {m.license}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          )}

          <button className="primary" onClick={handleRun} disabled={!file || busy}>
            {busy ? 'Working…' : 'Generate subtitles'}
          </button>
          {busy && (
            <button className="ghost" onClick={cancel}>
              Cancel
            </button>
          )}
        </div>
      </section>

      {busy && (
        <div className="progress" role="status" aria-live="polite">
          <ol>
            {STAGE_LABELS.map(([key, label], i) => {
              const currentIndex = STAGE_LABELS.findIndex(([k]) => k === stage);
              const state = i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'todo';
              return (
                <li key={key} className={state}>
                  {label}
                </li>
              );
            })}
          </ol>
          <p className="note">
            Running on CPU. A 30-second clip takes roughly 100 seconds — all of it local.
          </p>
        </div>
      )}

      {failure && (
        <div className="banner error" role="alert">
          <strong>Could not process that file.</strong>
          <span>{failure}</span>
        </div>
      )}

      {job && (
        <>
          <div className="summary">
            <div className="stat">
              <span className="k">cues</span>
              <span className="v">{cues.length}</span>
            </div>
            <div className="stat">
              <span className="k">needs you</span>
              <span className={`v ${needsHuman > 0 ? 'warn' : 'good'}`}>{needsHuman}</span>
            </div>
            <div className="stat">
              <span className="k">reading speed</span>
              <span className="v">
                {cues.length ? Math.max(...cues.map((c) => c.cps)).toFixed(1) : 0} cps max
              </span>
            </div>
            <div className="stat">
              <span className="k">clip</span>
              <span className="v">{(job.meta.durationMs / 1000).toFixed(1)}s</span>
            </div>
            <div className="stat">
              <span className="k">elapsed</span>
              <span className="v">
                {(Object.values(job.stageMs).reduce((a, b) => a + b, 0) / 1000).toFixed(0)}s
              </span>
            </div>
          </div>

          {videoUrl && (
            <div className="player">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video src={videoUrl} controls preload="metadata" />
              <p className="note">
                Play the clip with the timeline below. Subtitles are not burned in — export the
                <code> .srt</code> or <code>.vtt</code> to load into any player or editor.
              </p>
            </div>
          )}

          <CueEditor
            jobId={job.id}
            cues={cues}
            onChange={setCues}
            dirty={dirty}
            videoUrl={videoUrl}
            modelsUsed={job.modelsUsed}
          />
        </>
      )}

      {!job && !busy && (
        <section className="empty">
          <h2>Why this exists</h2>
          <p>
            Captioning a client's unreleased footage means the footage, the transcript and the
            translation all sit on someone else's server. Saaz keeps all three on your own machine,
            using open-weight models you can inspect, swap and run with the network unplugged.
          </p>
          <ul>
            <li>No closed AI API is called. Ever.</li>
            <li>Every model is MIT or Apache-2.0, listed with its licence.</li>
            <li>Machine translation is shown as a draft, never silently trusted.</li>
          </ul>
        </section>
      )}
    </div>
  );
}