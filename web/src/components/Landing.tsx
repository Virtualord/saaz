import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { AlertTriangle, ArrowRight, Cpu, HardDrive, Languages, Lock, WifiOff } from "lucide-react";
import type { HealthSlot } from "../lib/api";

/** The five ways a cue can come out of the Fit stage, in pipeline order. */
const ESCALATIONS: Array<{ label: string; tone: StatusTone; detail: string }> = [
  { label: "fits as drafted", tone: "success", detail: "Nothing to do." },
  { label: "split to fit", tone: "info", detail: "Divided at punctuation, then retranslated." },
  { label: "reworded to fit", tone: "info", detail: "The caption model rewrote it inside budget." },
  { label: "held longer", tone: "warning", detail: "Borrowed time from the following gap." },
  { label: "needs a human", tone: "danger", detail: "Nothing worked. Flagged, not truncated." },
];

const GUARANTEES = [
  {
    icon: Lock,
    title: "Nothing leaves the machine",
    body: "Footage, transcript and translation stay in this process. There is no upload to a third party, and no AI API is called at any point.",
  },
  {
    icon: WifiOff,
    title: "Runs with the network unplugged",
    body: "Verified by a script that poisons every outbound request and then runs the full pipeline. It passes.",
  },
  {
    icon: Languages,
    title: "Translation shown as a draft",
    body: "Machine translation is never trusted silently. You see the source, the draft, and every cue the machine adjusted.",
  },
  {
    icon: HardDrive,
    title: "Swap models per job",
    body: "Each stage is a slot with alternatives. Change the trade-off between speed and accuracy without changing any code.",
  },
];

/** Honest answers. Every number here is measured and reproducible via npm scripts. */
const FAQ = [
  {
    q: "Is the transcription actually good?",
    a: "On regional-language audio it is imperfect, and we show you the draft rather than claiming otherwise. Whisper-small scores a 0.165 character error rate on our Hindi test clip; whisper-base scores 1.00 because it emits Arabic script for Hindi audio. You are expected to fix things — that is what the editor is for.",
  },
  {
    q: "How accurate are the cue timings?",
    a: "Word-level timing is approximated. The Whisper export we use cannot emit word timestamps, so we find real speech boundaries with Silero VAD and allocate words to them proportionally. Cue boundaries follow actual speech, which is what matters for subtitles.",
  },
  {
    q: "Why is it slow?",
    a: "Speech recognition runs at roughly 4× realtime on CPU. Keeping footage on the machine means giving up the datacentre GPU, and that is a deliberate trade rather than an optimisation we forgot to make.",
  },
  {
    q: "What does it refuse to do?",
    a: "It will not silently truncate a caption that does not fit, and it will not fabricate a translation when machine translation returns nothing. Those cases are surfaced to you instead.",
  },
];

export function Landing({
  health,
  onStart,
}: {
  health: { slots: HealthSlot[]; inference: { remoteApisUsed: string[] } } | null;
  onStart: () => void;
}) {
  const slots = health?.slots ?? [];
  const modelCount = slots.reduce((n, s) => n + s.models.length, 0);

  return (
    <div className="min-h-screen bg-background">
      {/* ---------- header ---------- */}
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-[13px] font-bold text-primary-foreground">
              S
            </span>
            <span className="text-[15px] font-semibold tracking-tight">Saaz</span>
            <Badge variant="outline" className="hidden sm:inline-flex">
              offline subtitles
            </Badge>
          </div>
          <nav className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onStart}>
              Open app
            </Button>
            <Button size="sm" onClick={onStart}>
              Generate subtitles
              <ArrowRight className="ml-1.5 size-3.5" />
            </Button>
          </nav>
        </div>
      </header>

      {/* ---------- hero ---------- */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="grid-noise pointer-events-none absolute inset-0 opacity-40" aria-hidden />
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-primary/8 to-transparent"
          aria-hidden
        />
        <div className="relative mx-auto max-w-6xl px-5 py-16 sm:py-24">
          <div className="grid items-start gap-12 lg:grid-cols-[1.05fr_0.95fr]">
            <div>
              <StatusBadge tone="info" className="mb-5">
                <Cpu className="size-3" />
                4 open models, CPU only, no API keys
              </StatusBadge>

              <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
                Subtitles that never
                <br />
                leave your laptop.
              </h1>

              <p className="mt-5 max-w-xl text-pretty text-[17px] leading-relaxed text-muted-foreground">
                Saaz captions regional-language video and drafts an English translation using
                open-weight models running in your own process. When you are subtitling a
                client&rsquo;s unreleased footage, the footage, the transcript and the translation
                all belong on your machine — not on a vendor&rsquo;s.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Button size="lg" onClick={onStart}>
                  Open the app
                  <ArrowRight className="ml-2 size-4" />
                </Button>
                <Button size="lg" variant="outline" onClick={onStart}>
                  See the models
                </Button>
              </div>

              <p className="mt-4 font-mono text-xs text-muted-foreground">
                A 30-second clip takes roughly 100 seconds on CPU. All of it local.
              </p>
            </div>

            {/* Live pipeline preview */}
            <Card className="shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">The pipeline</CardTitle>
                <CardDescription className="text-xs">
                  Every stage runs in this process, on open weights.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {(
                  [
                    ["probe", "ffmpeg", "read the container"],
                    ["transcribe", "Whisper small", "MIT"],
                    ["vad", "Silero VAD", "MIT"],
                    ["align", "word allocation", "ours"],
                    ["segment", "cue builder", "ours"],
                    ["glossary", "pinned terms", "ours"],
                    ["translate", "OPUS-MT", "Apache-2.0"],
                    ["fit", "budget solver", "ours"],
                  ] as const
                ).map(([stage, model, licence], i, arr) => (
                  <div key={stage}>
                    <div className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/60">
                      <span className="w-4 shrink-0 font-mono text-[11px] text-muted-foreground">
                        {i + 1}
                      </span>
                      <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">
                        {stage}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px]">{model}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {licence}
                      </span>
                    </div>
                    {i < arr.length - 1 && <div className="ml-[26px] h-2 w-px bg-border" />}
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* ---------- subtitle example ---------- */}
      <section className="border-b border-border bg-muted/30">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">
                A translation is not a caption
              </h2>
              <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
                Machine translation produces a complete, grammatical sentence. A subtitle is
                something else: a compressed visual artefact with a hard character budget and a
                hard deadline. Most tools conflate the two and hand you a file nobody can read at
                1.5&times; speed.
              </p>
              <p className="mt-4 text-pretty leading-relaxed text-muted-foreground">
                So Saaz treats fitting as the actual problem. When a cue cannot be displayed in the
                time it has, it escalates through five steps — and if none of them work, it tells
                you instead of quietly shipping something unreadable.
              </p>
            </div>

            <div className="space-y-3">
              <div className="cue-preview">
                <span className="block">The shop opens at seven in the morning</span>
                <span className="block">and closes at ten at night</span>
              </div>
              <div className="grid gap-1.5">
                {ESCALATIONS.map((e) => (
                  <div
                    key={e.label}
                    className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2"
                  >
                    <StatusBadge tone={e.tone}>{e.label}</StatusBadge>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                      {e.detail}
                    </span>
                  </div>
                ))}
              </div>
              <p className="flex items-start gap-2 pt-1 text-[13px] text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                The last row is the point. A tool that always emits something is worse than
                useless when a client signs off on the file.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- guarantees ---------- */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">
            What open weights buy you here
          </h2>
          <p className="mt-3 max-w-2xl text-pretty leading-relaxed text-muted-foreground">
            Not "no per-token cost" in the abstract — four concrete things that only work because
            the weights are inspectable and the code is ours.
          </p>

          <div className="mt-9 grid gap-5 sm:grid-cols-2">
            {GUARANTEES.map(({ icon: Icon, title, body }) => (
              <Card key={title} className="shadow-none">
                <CardHeader className="pb-2">
                  <div className="mb-2 grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
                    <Icon className="size-4" />
                  </div>
                  <CardTitle className="text-[15px]">{title}</CardTitle>
                </CardHeader>
                <CardContent className="text-[13.5px] leading-relaxed text-muted-foreground">
                  {body}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- models + honesty ---------- */}
      <section className="border-b border-border bg-muted/30">
        <div className="mx-auto max-w-6xl px-5 py-16">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Every model, and its licence</h2>
              <p className="mt-3 max-w-2xl text-pretty leading-relaxed text-muted-foreground">
                Read from the running service, not from this page. {modelCount > 0 && (
                  <>
                    {" "}
                    {modelCount} candidates across {slots.length} swappable slots.
                  </>
                )}
              </p>
            </div>
            <StatusBadge tone={health ? "success" : "neutral"}>
              {health ? `${health.inference.remoteApisUsed.length} third-party APIs` : "checking service…"}
            </StatusBadge>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {slots.map((slot) => (
              <Card key={slot.slot} className="shadow-none">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="font-mono text-[13px]">{slot.slot}</CardTitle>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {slot.models.length} options
                    </Badge>
                  </div>
                  <CardDescription className="text-xs leading-relaxed">
                    {slot.purpose}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {slot.models.map((m) => (
                    <div key={m.id} className="rounded-md border border-border/70 p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[13px] font-medium leading-tight">{m.label}</span>
                        {m.id === slot.defaultModelId && (
                          <StatusBadge tone="info" className="shrink-0">
                            default
                          </StatusBadge>
                        )}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                        <span className="rounded border border-border px-1 py-px">{m.license}</span>
                        <span className="rounded border border-border px-1 py-px">{m.dtype}</span>
                        <span>~{m.approxMb}MB</span>
                      </div>
                      {m.licenseNote && (
                        <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                          {m.licenseNote}
                        </p>
                      )}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>

          <Separator className="my-10" />

          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <h3 className="text-[15px] font-semibold">Gemma is listed, but not the default</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
                Gemma&rsquo;s weights are downloadable, but its licence is Google&rsquo;s Gemma
                Licence, which is not OSI-approved. Calling that "open source" would be false, so it
                sits in the list as a swappable option and is never described as open source.
              </p>
            </div>
            <div>
              <h3 className="text-[15px] font-semibold">Defaults were measured, not assumed</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
                Qwen2.5 0.5B and 1.5B both failed at this task: no parseable JSON, and they
                degenerated into repetition. SmolLM2-360M returned valid JSON on the first attempt,
                2.5&times; faster. The benchmarks are in the repository, so none of this has to be
                taken on trust.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- faq ---------- */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-2xl px-5 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">Honest answers</h2>
          {/* Base UI accordion uses value/defaultValue, not Radix's type/collapsible. */}
          {/* Base UI's accordion value is always an array, even in single-open mode. */}
          <Accordion defaultValue={[FAQ[0]!.q]} className="mt-7">
            {FAQ.map((item) => (
              <AccordionItem key={item.q} value={item.q}>
                <AccordionTrigger className="text-left text-[15px]">{item.q}</AccordionTrigger>
                <AccordionContent className="text-[13.5px] leading-relaxed text-muted-foreground">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {/* ---------- cta ---------- */}
      <footer className="bg-primary text-primary-foreground">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-5 py-14 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">
              Your footage stays yours.
            </h2>
            <p className="mt-2 max-w-lg text-pretty leading-relaxed text-primary-foreground/80">
              Open the app, drop in a clip, and watch every stage run locally. No account, no API
              key, no upload.
            </p>
          </div>
          <Button size="lg" variant="secondary" onClick={onStart}>
            Open the app
            <ArrowRight className="ml-2 size-4" />
          </Button>
        </div>
      </footer>
    </div>
  );
}