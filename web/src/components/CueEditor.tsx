import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Pencil } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Textarea } from "@/components/ui/textarea";
import { checkCue, layoutLines } from "../../../shared/cue-rules";
import { subtitleConstraints as C } from "../../../shared/types";
import type { Cue, FitEscalation } from "../../../shared/types";

const ESCALATION: Record<FitEscalation, { label: string; tone: StatusTone }> = {
  verbatim: { label: "fits as drafted", tone: "success" },
  resegmented: { label: "split to fit", tone: "info" },
  reflowed: { label: "reworded to fit", tone: "info" },
  extended: { label: "held longer", tone: "warning" },
  refused: { label: "needs a human", tone: "danger" },
};

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

interface Props {
  jobId: string;
  cues: Cue[];
  onChange: (cues: Cue[]) => void;
  dirty: boolean;
  modelsUsed: Record<string, string>;
}

export function CueEditor({ jobId, cues, onChange, dirty, modelsUsed }: Props) {
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const problems = useMemo(
    () =>
      cues
        .map((c, i) => ({ i, warnings: checkCue(c.lines.join("\n"), c.startMs, c.endMs) }))
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
    const text = lines.join("\n");
    const warnings = checkCue(text, cue.startMs, cue.endMs);
    update(index, {
      lines,
      chars: text.replace(/\s+/g, "").length,
      warnings: warnings.length > 0 ? warnings : ["edited by hand"],
      // A human edit resolves any machine refusal by definition.
      escalation: cue.escalation === "refused" ? "reflowed" : cue.escalation,
      refusalReason: null,
    });
    setEditing(null);
    setDraft("");
  }

  /** Move a boundary only while paused, so seeking stays predictable. */
  function nudge(index: number, edge: "startMs" | "endMs", deltaMs: number) {
    const cue = cues[index];
    if (!cue) return;
    const v = videoRef.current;
    if (v && !v.paused) v.pause();
    const next = Math.max(0, cue[edge] + deltaMs);
    update(index, {
      [edge]: next,
      warnings: checkCue(
        cue.lines.join("\n"),
        Math.min(cue.startMs, next),
        Math.max(cue.endMs, next),
      ),
    });
  }

  async function save() {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/cues`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cues }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { message?: string }).message ?? "save failed");
      setSaveMsg("Saved");
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (err) {
      setSaveMsg(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Translation is a draft. Fix what reads badly — that is the job, not a workaround.
        </p>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            {saveMsg ?? "Save edits"}
          </Button>
          {/* Plain anchors: this shadcn style is Base UI, whose Button has no asChild. */}
          <a
            href={`/api/jobs/${jobId}/export.srt`}
            download
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            .srt
          </a>
          <a
            href={`/api/jobs/${jobId}/export.vtt`}
            download
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            .vtt
          </a>
        </div>
      </div>

      {problems.length > 0 && (
        <Alert>
          <AlertTriangle className="text-warning" />
          <AlertTitle>
            {problems.length} cue{problems.length > 1 ? "s" : ""} outside the readability limits
          </AlertTitle>
          <AlertDescription>
            Max {C.maxLines} lines, {C.maxCharsPerLine} characters per line, {C.maxCps} characters
            per second.
          </AlertDescription>
        </Alert>
      )}

      <ol className="grid gap-2">
        {cues.map((cue, i) => {
          const bad = cue.warnings.length > 0;
          const meta = ESCALATION[cue.escalation];
          return (
            <li key={`${cue.startMs}-${i}`}>
              <Card
                className={`shadow-none transition-colors ${
                  cue.escalation === "refused"
                    ? "border-danger/40"
                    : bad
                      ? "border-warning/40"
                      : ""
                }`}
                onMouseEnter={() => {
                  const v = document.querySelector("video");
                  if (v) v.currentTime = cue.startMs / 1000;
                }}
              >
                <CardContent className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const v = document.querySelector("video");
                        if (v) {
                          v.currentTime = cue.startMs / 1000;
                          void v.play();
                        }
                      }}
                      className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-primary hover:border-primary"
                      title="Play from here"
                    >
                      {formatTime(cue.startMs)}
                    </button>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {(cue.endMs - cue.startMs) / 1000}s
                    </span>
                    <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                    <span
                      className={`font-mono text-[11px] ${
                        cue.cps > C.maxCps ? "font-semibold text-danger" : "text-muted-foreground"
                      }`}
                    >
                      {cue.cps.toFixed(1)} cps
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      {(["startMs", "endMs"] as const).map((edge) =>
                        (
                          [
                            [edge === "startMs" ? -100 : 100, edge === "startMs" ? "start earlier" : "start later"],
                            [edge === "endMs" ? -100 : 100, edge === "endMs" ? "end earlier" : "end later"],
                          ] as const
                        ).map(([delta, label]) => (
                          <button
                            key={`${edge}-${delta}`}
                            type="button"
                            onClick={() => nudge(i, edge, delta)}
                            aria-label={label}
                            className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-foreground"
                          >
                            {edge === "startMs" ? (delta < 0 ? "⇤" : "⇥") : delta < 0 ? "↤" : "↦"}
                          </button>
                        )),
                      )}
                    </span>
                  </div>

                  {cue.translation !== null && cue.sourceText !== cue.translation && (
                    <p className="mt-2 text-[13px] italic text-muted-foreground">{cue.sourceText}</p>
                  )}

                  {editing === i ? (
                    <div className="mt-2.5">
                      <Textarea
                        value={draft}
                        autoFocus
                        rows={2}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder={`Max ${C.maxCharsPerLine * C.maxLines} characters for this window`}
                        className="font-sans text-base"
                      />
                      <div className="mt-2 flex items-center gap-2">
                        <Button size="sm" onClick={() => commitEdit(i)}>
                          <Check className="mr-1.5 size-3.5" />
                          Save cue
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {draft.length} / {C.maxCharsPerLine * C.maxLines}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(i);
                        setDraft(cue.lines.join(" "));
                      }}
                      className="group mt-2 flex w-full flex-col gap-0.5 text-left"
                    >
                      {cue.lines.map((l, li) => (
                        <span
                          key={li}
                          className="rounded px-1 text-base leading-relaxed group-hover:bg-muted"
                        >
                          {l || "\u00a0"}
                        </span>
                      ))}
                      <span className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                        <Pencil className="size-2.5" />
                        edit
                      </span>
                    </button>
                  )}

                  {cue.refusalReason && (
                    <p className="mt-2 text-[12px] leading-relaxed text-danger">{cue.refusalReason}</p>
                  )}
                  {cue.warnings.length > 0 && (
                    <p className="mt-1.5 font-mono text-[11px] text-warning">
                      {cue.warnings.join(" · ")}
                    </p>
                  )}
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ol>

      <p className="font-mono text-[11px] text-muted-foreground">
        models:{" "}
        {Object.entries(modelsUsed)
          .map(([k, v]) => `${k}=${v.split("/").pop()}`)
          .join(" · ")}
      </p>
    </div>
  );
}