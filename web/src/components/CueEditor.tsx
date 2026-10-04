import { useMemo, useRef, useState } from 'react';
import { checkCue, layoutLines } from '../../../shared/cue-rules';
import { subtitleConstraints as C } from '../../../shared/types';
import type { Cue } from '../../../shared/types';

const ESCALATION_LABEL: Record<Cue['escalation'], string> = {
  verbatim: 'fits as drafted',
  resegmented: 'split to fit',
  reflowed: 'reworded to fit',
  extended: 'held longer',
  refused: 'needs a human',
};

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

interface Props {
  jobId: string;
  cues: Cue[];
  onChange: (cues: Cue[]) => void;
  dirty: boolean;
  videoUrl: string | null;
  modelsUsed: Record<string, string>;
}

export function CueEditor({ jobId, cues, onChange, dirty, videoUrl, modelsUsed }: Props) {
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);

  const problems = useMemo(
    () =>
      cues
        .map((c, i) => ({ i, warnings: checkCue(c.lines.join('\n'), c.startMs, c.endMs) }))
        .filter((r) => r.warnings.length > 0),
    [cues],
  );

  function update(index: number, next: Partial<Cue>) {
    onChange(cues.map((c, i) => (i === index ? { ...c, ...next } : c)));
  }

  function commitEdit(index: number) {
    const cue = cues[index];
    if (!cue) return;
    const lines = layoutLines(draft).lines;
    const text = lines.join('\n');
    const warnings = checkCue(text, cue.startMs, cue.endMs);
    update(index, {
      lines,
      chars: text.replace(/\s+/g, '').length,
      warnings: warnings.length > 0 ? warnings : ['edited by hand'],
      // A human edit resolves any machine refusal by definition.
      escalation: cue.escalation === 'refused' ? 'reflowed' : cue.escalation,
      refusalReason: null,
    });
    setEditing(null);
    setDraft('');
  }

  /** Move a boundary only while the video is paused, so seeking is predictable. */
  function nudge(index: number, edge: 'startMs' | 'endMs', deltaMs: number) {
    const cue = cues[index];
    if (!cue) return;
    const v = videoRef.current;
    if (v && !v.paused) v.pause();
    const next = Math.max(0, cue[edge] + deltaMs);
    update(index, { [edge]: next, warnings: checkCue(cue.lines.join('\n'), Math.min(cue.startMs, next), Math.max(cue.endMs, next)) });
  }

  async function save() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/cues`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cues }),
      });
      if (!res.ok) throw new Error((await res.json()).message ?? 'save failed');
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : 'save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="editor">
      <div className="editor-head">
        <div>
          <h2>Review</h2>
          <p className="note">
            Translation is a draft. Fix what reads badly — that is the job, not a workaround.
          </p>
        </div>
        <div className="editor-actions">
          <button className="primary" onClick={save} disabled={!dirty || saving}>
            {saving ? 'Saving…' : saveMsg ?? 'Save edits'}
          </button>
          <a className="ghost" href={`/api/jobs/${jobId}/export.srt`} download>
            .srt
          </a>
          <a className="ghost" href={`/api/jobs/${jobId}/export.vtt`} download>
            .vtt
          </a>
        </div>
      </div>

      {problems.length > 0 && (
        <div className="banner warn" role="status">
          <strong>
            {problems.length} cue{problems.length > 1 ? 's' : ''} outside the readability limits
          </strong>
          <span>
            Max {C.maxLines} lines, {C.maxCharsPerLine} characters per line, {C.maxCps} characters per
            second.
          </span>
        </div>
      )}

      <div className="legend">
        {Object.entries(ESCALATION_LABEL).map(([k, label]) => (
          <span key={k} className={`chip chip-${k}`}>
            {label}
          </span>
        ))}
      </div>

      <ol className="cues">
        {cues.map((cue, i) => {
          const bad = cue.warnings.length > 0;
          return (
            <li
              key={`${cue.startMs}-${i}`}
              className={`cue cue-${cue.escalation} ${bad ? 'has-warning' : ''}`}
              onMouseEnter={() => {
                const v = videoRef.current;
                if (v) v.currentTime = cue.startMs / 1000;
              }}
            >
              <div className="cue-head">
                <button
                  className="time"
                  onClick={() => {
                    const v = videoRef.current;
                    if (v) {
                      v.currentTime = cue.startMs / 1000;
                      void v.play();
                    }
                  }}
                  title="Play from here"
                >
                  {formatTime(cue.startMs)}
                </button>
                <span className="dur">{(cue.endMs - cue.startMs) / 1000}s</span>
                <span className={`chip chip-${cue.escalation}`}>{ESCALATION_LABEL[cue.escalation]}</span>
                <span className={`cps ${cue.cps > C.maxCps ? 'over' : ''}`}>{cue.cps.toFixed(1)} cps</span>
              </div>

              {pairIsNonEnglish(cue) && <div className="source">{cue.sourceText}</div>}

              {editing === i ? (
                <div className="edit">
                  <textarea
                    value={draft}
                    autoFocus
                    rows={3}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={`Max ${C.maxCharsPerLine * C.maxLines} characters for this window`}
                  />
                  <div className="edit-actions">
                    <button className="primary" onClick={() => commitEdit(i)}>
                      Save cue
                    </button>
                    <button className="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <span className="note">{draft.length} chars</span>
                  </div>
                </div>
              ) : (
                <button
                  className="caption"
                  onClick={() => {
                    setEditing(i);
                    setDraft(cue.lines.join(' '));
                  }}
                >
                  {cue.lines.map((l, li) => (
                    <span key={li} className="line">
                      {l || ' '}
                    </span>
                  ))}
                </button>
              )}

              {cue.refusalReason && <p className="refusal">{cue.refusalReason}</p>}
              {cue.warnings.length > 0 && (
                <p className="warnings">{cue.warnings.join(' · ')}</p>
              )}

              <div className="nudge">
                <span>timing</span>
                <button onClick={() => nudge(i, 'startMs', -100)} aria-label="start 100ms earlier">
                  ← in
                </button>
                <button onClick={() => nudge(i, 'startMs', 100)} aria-label="start 100ms later">
                  in →
                </button>
                <button onClick={() => nudge(i, 'endMs', -100)} aria-label="end 100ms earlier">
                  ← out
                </button>
                <button onClick={() => nudge(i, 'endMs', 100)} aria-label="end 100ms later">
                  out →
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <p className="note models">
        models: {Object.entries(modelsUsed).map(([k, v]) => `${k}=${v.split('/').pop()}`).join(' · ')}
      </p>
    </section>
  );
}

/** Source and caption differ only when we actually translated. */
function pairIsNonEnglish(cue: Cue): boolean {
  return cue.translation !== null && cue.sourceText !== cue.translation;
}