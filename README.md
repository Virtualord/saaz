# Saaz

Subtitles and English translation for regional-language video, generated **entirely on your own machine** with open-weight models.

No closed AI API is called at any point. The whole pipeline — speech recognition, translation, caption
rewriting — runs in-process on CPU, and can be verified to run with the network unplugged.

```bash
npm install
npm run fetch-models        # download open weights once
npm run make-demo-asset     # generate a Hindi test clip
npm run dev                 # http://localhost:5173
```

## Why it exists

Captioning a client's unreleased footage means the footage, its transcript and its translation
all sit on somebody else's server. That is the problem this solves. Every byte stays local, every
model carries a permissive licence, and the models are swappable rather than fixed behind an API.

## The pipeline

```
probe → decode → Whisper ASR → Silero VAD → align → segment → glossary → OPUS-MT → Fit
```

| Stage | Model | Licence | Role |
|---|---|---|---|
| Speech recognition | `onnx-community/whisper-small` | MIT | audio → timed dialogue |
| Speech boundaries | `onnx-community/silero-vad` | MIT | where people actually speak |
| Translation draft | `Xenova/opus-mt-hi-en` | Apache-2.0 | Hindi → English draft |
| Caption rewrite | `HuggingFaceTB/SmolLM2-360M-Instruct` | Apache-2.0 | rewrite to fit the time budget |

Every model runs through one runtime ([transformers.js](https://github.com/huggingface/transformers.js)
over `onnxruntime-node`), quantised to `q8` so all four fit in CPU RAM without a GPU.

### The Fit stage

The part that makes this a subtitle tool rather than a transcription toy. A translation often
needs more characters than the time window can display. `server/services/fit.ts` escalates:

1. **verbatim** — it already fits
2. **reflowed** — the caption model rewrites it inside the budget
3. **extended** — borrow time from the following gap
4. **split** — deterministically divide the cue, then retranslate both halves
5. **refused** — nothing works; flag it for a human and say why

Step 5 is the important one. A subtitle file is a deliverable a client signs off on, so a tool that
always emits *something* is worse than useless. Saaz tells you which cues need a person.

Constraints enforced in code (`shared/types.ts`): max 2 lines, max 42 chars per line, max 17
characters per second.

## What we measured rather than assumed

Every default was chosen from a benchmark, not from reputation. Both are reproducible:

```bash
npm run bench:asr        # Whisper size vs accuracy (CER) on Hindi
npm run bench:caption    # can any small LM compress a caption to a character budget?
npm run prove:offline    # runs the pipeline with all outbound network poisoned
npm run evidence         # regenerates everything in evidence/ from a live run
```

Findings worth knowing — including the ones that contradicted us:

- **Whisper-base emits Arabic script for Hindi audio** (CER 1.00). whisper-small scores 0.165.
  We also tried `whisper-large-v3-turbo`: at `q8` it returned *empty* transcripts and cost RTF 13.9,
  so it was removed rather than shipped broken.
- **No small open model we tried can reliably compress a caption to a character budget.**
  Qwen2.5-1.5B lands inside budget on roughly 1 in 4 attempts; SmolLM2-360M is fluent and overran
  all four; Qwen2.5-0.5B echoes the instruction. Requiring JSON output made every one of them
  worse — they emit the schema as literal text — so the prompt is plain text and we do the
  formatting ourselves.

  An earlier version of this README claimed the opposite, that SmolLM2-360M succeeded where Qwen
  failed. That came from a test that omitted `repetition_penalty`. The benchmark caught it; the
  registry now records the measured numbers.

  **This is why the Fit solver is deterministic.** The model suggests wording; the solver enforces
  the constraints. If the model fails, the cue is flagged for a human, never truncated.
- **The `onnx-community` Whisper export has no cross-attention outputs**, so it cannot emit word
  timestamps. Its segment timings collapse into uniform 3-second blocks that match nothing in the
  audio. We found this by inspecting real output, and fixed it with Silero VAD instead of pretending
  the timings were good enough.
- **Open MT has vocabulary gaps on domain terms.** `मालाई` (malai, the sweet) translates to *"by
  Miley"*. We ruled out tokenisation bugs by normalising nukta and observing identical output. So
  Saaz ships a **glossary**: terms the user pins, substituted before translation.

## Observability

Traces are first-party and in-process. No vendor, no DSN, no network — which is the only way the
"runs offline" claim stays testable.

| Span kind | Covers |
| --- | --- |
| `AGENT` | the request root, the pipeline, and each retry/fallback policy |
| `MODEL` | ASR, VAD, translation, caption rewrite — with model id, licence, dtype, token usage |
| `TOOL` | ffmpeg / ffprobe, with exit code and whether we killed it on timeout |
| `DB` | every SQLite statement, with row counts and payload bytes |

```
curl localhost:8080/api/traces            # recent traces
curl localhost:8080/api/traces/<id>/text  # one request as an indented tree
```

The text rendering exists so a judge can read one request end to end in a terminal:

```
+ AGENT  request.submit_media          181353ms
  + DB     db.insert_job                      1ms
  + AGENT  pipeline.generate_subtitles    181331ms
    + TOOL   transcribe                   80406ms
      + MODEL  model.transcribe           80405ms   license=MIT dtype=q8
          @24921ms word_timestamps_unavailable
          @80723ms hallucinations_dropped {count:1}
    + TOOL   fit                         96406ms
      x MODEL  model.caption_reflow      50906ms
          @117762ms over_budget {chars:265, maxChars:84}
```

Set `SENTRY_DSN` to forward spans to Sentry as well; without it everything stays local.
`SAAZ_EMIT_SPANS=true` additionally writes one JSON line per finished span.

### Handled failure

`POST /api/traces/demo/failure` runs a real drill: ask the caption model to fit 110 characters
into 12. It cannot, and that is the point. The system retries, falls back to a different
open-weight model, and when that also fails, **flags the cue for a human instead of truncating**.
The request still succeeds. `evidence/failure-recovery.txt` is the captured transcript.

## Architecture notes

- **One process, no queue.** A 30-second clip takes ~100s on CPU. Synchronous with real stage
  timings is more honest than a job queue for a demo.
- **SQLite, not a hosted database.** A job holds someone's unreleased transcript.
- **No agent loop in the fit path.** A subtitle deliverable must be reproducible, so escalation is
  deterministic. Randomness there would be a bug.
- **Gemma is listed but is not the default.** Its weights are open, but the licence is Google's
  Gemma Licence, which is not OSI-approved. It is swappable in; it is not what we call open source.

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | runtime, device, licences, and whether weights are on disk |
| `GET /api/slots` | every swappable model with licence and dtype |
| `POST /api/jobs` | upload media, run the pipeline, return cues + stage timings |
| `GET /api/jobs/:id` | fetch a stored job |
| `PATCH /api/jobs/:id/cues` | save human edits |
| `GET /api/jobs/:id/export.srt` | SubRip download |
| `GET /api/jobs/:id/export.vtt` | WebVTT download, warnings as `NOTE` comments |

## Configuration

All optional — it runs with no configuration at all.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `SAAZ_MODEL_DIR` | `./data/models` | weight cache |
| `SAAZ_MAX_UPLOAD_MB` | `200` | upload cap |
| `SENTRY_DSN` | unset | tracing; falls back to JSON on stdout |
| `SAAZ_FFMPEG` / `SAAZ_FFPROBE` | `ffmpeg` / `ffprobe` | binary override |

## The UI

Landing page and app, both light theme, built with shadcn/ui on Tailwind v4:

- `web/src/components/Landing.tsx` — hero, live pipeline listing, subtitle example,
  guarantees, model/licence table, FAQ
- `web/src/App.tsx` — upload, progress, results, cue editor, stage timings
- `web/src/components/ui/` — shadcn primitives plus `status-badge.tsx`, which maps the five
  fit outcomes onto semantic colours

The palette lives in exactly one place, `web/src/styles.css`. There is deliberately **no dark
theme**: this is a tool people open next to a video editor in daylight, so dark mode would be a
preference rather than a feature.

The browser bundle is guarded against importing server code — CI fails if `dist/web` ever
references `process.env` or a Node builtin. That guard exists because the editor once imported
the server's segmenter, which dragged `process.env` into the bundle and threw
`ReferenceError: process is not defined` at runtime.

## Deploying

`render.yaml` is a Render blueprint. Weights are baked into the image at build time, so the deployed
service never contacts Hugging Face. CPU-only plan by design.

### GitLab

`.gitlab-ci.yml` defines three stages:

| Stage | Job | What it does |
| --- | --- | --- |
| `verify` | `typecheck`, `test`, `build` | strict TS, 39 unit tests, production build, plus a bundle-leak guard |
| `image` | `container` | builds the container, pushes to the GitLab registry (`main` only) |
| `deploy` | `deploy` | manual job that triggers a Render deploy hook |

Model weights are **not** fetched per commit — they are immutable artefacts pinned in
`server/models/registry.ts`, and re-downloading 1.6GB on every push would cost several minutes per
pipeline for no benefit.

Publishing:

```bash
git remote add origin git@gitlab.com:<namespace>/saaz.git
git push -u origin main
```

Then set `RENDER_DEPLOY_HOOK_URL` as a masked, protected CI/CD variable if you want the manual
deploy job to work.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite + API with reload |
| `npm run build` | frontend + server build |
| `npm test` | unit tests (segmenter, fit, align, glossary, export) |
| `npm run typecheck` | strict TypeScript, no emit |
| `npm run fetch-models` | download the default weights |
| `npm run fetch:vad` | download the VAD weights |
| `npm run make-demo-asset` | synthesise the Hindi demo clip |
| `npm run smoke:pipeline` | full run, printed for inspection |
| `npm run bench:asr` / `bench:caption` | model selection benchmarks |
| `npm run prove:offline` | prove the offline claim |

## Honest limitations

- **Whisper transcription quality on regional languages is imperfect.** We show the draft and
  provide an editor; we do not claim the output is publishable unattended.
- **Word-level timing is approximated.** We align text to VAD regions proportionally, because the
  available Whisper export cannot emit word timestamps.
- **Cue splitting between languages is a proportional guess.** There is no word-level correspondence
  between Hindi and English; halves are retranslated individually rather than split blindly.
- **CPU inference is slow** — roughly 4× realtime for ASR. That is the trade for keeping footage
  local on a laptop.
- **The demo clip is synthetic**, generated from an openly licensed TTS, so the demo is reproducible
  without borrowing anyone's footage.

## Licence

Apache-2.0. Bundled models keep their own licences, listed per-model in
`server/models/registry.ts` and shown in the UI.