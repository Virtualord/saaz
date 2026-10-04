import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, Play, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { Landing } from "./components/Landing";
import { CueEditor } from "./components/CueEditor";
import { ProvenancePanel } from "./components/ProvenancePanel";
import { runJob, useHealth, useObjectUrl, type JobResult } from "./lib/api";
import type { Cue } from "../../shared/types";

const PAIRS = [
  { value: "hi-en", label: "Hindi → English" },
  { value: "bn-en", label: "Bengali → English" },
  { value: "mr-en", label: "Marathi → English" },
  { value: "te-en", label: "Telugu → English" },
  { value: "ta-en", label: "Tamil → English" },
  { value: "gu-en", label: "Gujarati → English" },
  { value: "kn-en", label: "Kannada → English" },
  { value: "pa-en", label: "Punjabi → English" },
  { value: "en-en", label: "English (transcribe only)" },
];

/** Ordered to match the pipeline, so the progress list is not a guess. */
const STAGE_LABELS: Array<[string, string]> = [
  ["uploading", "Uploading"],
  ["probe", "Probing media"],
  ["decode", "Decoding audio"],
  ["transcribe", "Transcribing (Whisper)"],
  ["vad_align", "Finding speech boundaries (Silero VAD)"],
  ["segment", "Building cues"],
  ["translate", "Drafting translation (OPUS-MT)"],
  ["fit", "Fitting to time budget"],
];

type View = "landing" | "app";

export function App() {
  const { health, error: healthError } = useHealth();
  const [view, setView] = useState<View>("landing");

  const [file, setFile] = useState<File | null>(null);
  const [pair, setPair] = useState("hi-en");
  const [models, setModels] = useState<Record<string, string>>({});
  const [job, setJob] = useState<JobResult | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("uploading");
  const [failure, setFailure] = useState<string | null>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
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
    setStage("uploading");
    const { promise, abort } = runJob(file, { pair, models }, setStage);
    abortRef.current = abort;
    try {
      const result = await promise;
      setJob(result);
      setStage("done");
    } catch (err) {
      if ((err as Error).name === "AbortError") setFailure("Cancelled.");
      else setFailure(err instanceof Error ? err.message : "Something went wrong.");
      setStage("idle");
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const needsHuman = cues.filter((c) => c.escalation === "refused").length;
  const stageIndex = STAGE_LABELS.findIndex(([k]) => k === stage);

  if (view === "landing") {
    return <Landing health={health} onStart={() => setView("app")} />;
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-5">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setView("landing")}>
              <ArrowLeft className="mr-1.5 size-3.5" />
              Back
            </Button>
            <Separator orientation="vertical" className="h-4" />
            <span className="text-[15px] font-semibold tracking-tight">Saaz</span>
          </div>
          <StatusBadge tone={health ? "success" : "neutral"}>
            {health
              ? `${health.inference.remoteApisUsed.length} third-party APIs · CPU`
              : "checking service…"}
          </StatusBadge>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-8">
        {/* ---------- intake ---------- */}
        <Card>
          <CardHeader className="pb-4">
            <CardTitle className="text-base">Generate subtitles</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <label
              htmlFor="file"
              className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border bg-muted/40 px-6 py-9 text-center transition-colors hover:border-primary hover:bg-muted/70"
            >
              <Upload className="size-5 text-muted-foreground" />
              <span className="text-sm font-medium">
                {file ? file.name : "Choose a video or audio file"}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {file
                  ? `${(file.size / 1024 / 1024).toFixed(1)} MB · stays on this machine`
                  : "MP4, MOV, WebM, MP3, WAV, M4A · nothing is uploaded anywhere else"}
              </span>
              <input
                id="file"
                ref={fileInput}
                type="file"
                accept="video/*,audio/*"
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="pair">Language</Label>
                <Select value={pair} onValueChange={(v) => v && setPair(v)} disabled={busy}>
                  <SelectTrigger id="pair" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Source → target</SelectLabel>
                      {PAIRS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              {health?.slots.map((slot) => (
                <div key={slot.slot} className="space-y-1.5">
                  <Label htmlFor={`m-${slot.slot}`} className="font-mono text-[11px] uppercase">
                    {slot.slot}
                  </Label>
                  <Select
                    value={models[slot.slot] ?? slot.defaultModelId}
                    onValueChange={(v) => v && setModels((m) => ({ ...m, [slot.slot]: v }))}
                    disabled={busy}
                  >
                    <SelectTrigger id={`m-${slot.slot}`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>{slot.purpose}</SelectLabel>
                        {slot.models.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.label} · {m.license}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={handleRun} disabled={!file || busy}>
                {busy ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Working…
                  </>
                ) : (
                  <>
                    <Play className="mr-2 size-4" />
                    Generate subtitles
                  </>
                )}
              </Button>
              {busy && (
                <Button variant="outline" onClick={() => abortRef.current?.()}>
                  Cancel
                </Button>
              )}
              {file && !busy && !job && (
                <span className="font-mono text-xs text-muted-foreground">
                  ~{Math.ceil(100 * (file.size / 1024 / 1024 > 30 ? 2 : 1))}s on CPU
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        {/* ---------- progress ---------- */}
        {busy && (
          <Card className="mt-5">
            <CardContent className="pt-6">
              <ol className="grid gap-1.5">
                {STAGE_LABELS.map(([key, label], i) => {
                  const state = i < stageIndex ? "done" : i === stageIndex ? "active" : "todo";
                  return (
                    <li
                      key={key}
                      className={`flex items-center gap-2.5 text-sm ${
                        state === "done"
                          ? "text-success"
                          : state === "active"
                            ? "font-medium text-foreground"
                            : "text-muted-foreground"
                      }`}
                    >
                      <span className="grid size-4 shrink-0 place-items-center">
                        {state === "done" ? (
                          <CheckCircle2 className="size-4" />
                        ) : state === "active" ? (
                          <Loader2 className="size-4 animate-spin text-primary" />
                        ) : (
                          <span className="size-1.5 rounded-full bg-border" />
                        )}
                      </span>
                      {label}
                    </li>
                  );
                })}
              </ol>
              <p className="mt-4 text-xs text-muted-foreground">
                Running on CPU. All of it local — no stage is waiting on a network call.
              </p>
            </CardContent>
          </Card>
        )}

        {failure && (
          <Alert variant="destructive" className="mt-5">
            <AlertTriangle />
            <AlertTitle>Could not process that file</AlertTitle>
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}

        {/* ---------- result ---------- */}
        {job && (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {[
                { k: "cues", v: String(cues.length) },
                {
                  k: "needs you",
                  v: String(needsHuman),
                  tone: needsHuman > 0 ? ("warning" as const) : ("success" as const),
                },
                {
                  k: "reading speed",
                  v: `${cues.length ? Math.max(...cues.map((c) => c.cps)).toFixed(1) : 0} cps`,
                },
                { k: "clip", v: `${(job.meta.durationMs / 1000).toFixed(1)}s` },
                {
                  k: "elapsed",
                  v: `${(Object.values(job.stageMs).reduce((a, b) => a + b, 0) / 1000).toFixed(0)}s`,
                },
              ].map((s) => (
                <Card key={s.k} className="shadow-none">
                  <CardContent className="px-4 py-3">
                    <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                      {s.k}
                    </div>
                    <div
                      className={`mt-0.5 font-mono text-xl font-semibold ${
                        s.tone === "warning"
                          ? "text-warning"
                          : s.tone === "success"
                            ? "text-success"
                            : ""
                      }`}
                    >
                      {s.v}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {videoUrl && (
              <Card className="mt-5">
                <CardContent className="pt-6">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    controls
                    preload="metadata"
                    className="aspect-video w-full rounded-lg bg-black"
                  />
                  <p className="mt-3 text-xs text-muted-foreground">
                    Subtitles are not burned in. Export{" "}
                    <code>.srt</code> or <code>.vtt</code> to load into any player or editor.
                  </p>
                </CardContent>
              </Card>
            )}

            <Tabs defaultValue="review" className="mt-6">
              <TabsList>
                <TabsTrigger value="review">Review</TabsTrigger>
                <TabsTrigger value="models">Models</TabsTrigger>
                <TabsTrigger value="timings">Timings</TabsTrigger>
              </TabsList>

              <TabsContent value="review" className="mt-4">
                <CueEditor
                  jobId={job.id}
                  cues={cues}
                  onChange={setCues}
                  dirty={dirty}
                  modelsUsed={job.modelsUsed}
                />
              </TabsContent>

              <TabsContent value="models" className="mt-4">
                <ProvenancePanel health={health} error={healthError} />
              </TabsContent>

              <TabsContent value="timings" className="mt-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="grid gap-2">
                      {Object.entries(job.stageMs).map(([k, v]) => {
                        const total = Object.values(job.stageMs).reduce((a, b) => a + b, 0);
                        return (
                          <div key={k} className="flex items-center gap-3">
                            <span className="w-36 shrink-0 font-mono text-xs">{k}</span>
                            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary/70"
                                style={{ width: `${Math.max(1, (v / total) * 100)}%` }}
                              />
                            </div>
                            <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">
                              {v}ms
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-4 text-xs text-muted-foreground">
                      Speech recognition dominates. That is the trade for keeping footage local
                      instead of using a datacentre GPU.
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        )}

        {!job && !busy && (
          <Card className="mt-5 border-dashed shadow-none">
            <CardContent className="pt-6">
              <h2 className="text-base font-semibold">Why this exists</h2>
              <p className="mt-2 max-w-2xl text-pretty text-sm leading-relaxed text-muted-foreground">
                Captioning a client&rsquo;s unreleased footage means the footage, the transcript and
                the translation all sit on someone else&rsquo;s server. Saaz keeps all three on
                your own machine, using open-weight models you can inspect, swap, and run with the
                network unplugged.
              </p>
              <ul className="mt-4 grid gap-1.5 text-sm text-muted-foreground">
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="size-3.5 text-success" />
                  No closed AI API is called. Ever.
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="size-3.5 text-success" />
                  Every model is MIT or Apache-2.0, listed with its licence.
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle2 className="size-3.5 text-success" />
                  Machine translation is shown as a draft, never silently trusted.
                </li>
              </ul>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}