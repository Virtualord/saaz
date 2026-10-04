*This is a submission for the [Hacktoberfest Weekend Challenge: Build for a Friend](https://dev.to/challenges/hacktoberfest-weekend-2026-10-01)*

## What I Built

**Saaz** — subtitles and an English translation track for regional-language video, generated entirely on your own machine with open-weight models.

Two numbers before anything else, because they contradict something I believed when I started:

- **Whisper-base transcribes my Hindi test clip into Arabic script.** Character error rate 1.00. ([`evidence/bench-asr.txt`](https://github.com/Virtualord/saaz/blob/master/evidence/bench-asr.txt))
- **No small open model I tried can reliably compress a subtitle into a character budget.** Best result was 1 in 4. ([`evidence/benchmark.txt`](https://github.com/Virtualord/saaz/blob/master/evidence/benchmark.txt))

Both files are in the repo. Both are reproducible with one command each.

### The friend

Two things about him, because they shaped every decision.

He publishes short video about local businesses — restaurants, shops, the kind of place with a good sign and no website. He's good at it and he's one person.

And a growing share of his work is **other people's footage**. A shop owner records him walking through their new shop and wants it captioned before they post it. Sometimes it isn't released yet. Sometimes there's a launch date attached.

He was doing this with two paid web tools — one transcribes, one translates. Both cloud, both bill per minute, both want the file.

The thing he said that made me stop and build something: **"I'm uploading my client's unreleased footage to two strangers' servers because that's the only way I can make a subtitle."**

Not "it's expensive." Not "it's slow." He didn't frame it as a privacy concern at all. He said it as a constraint he had no way around.

### Why I cared enough to build it

Because he wasn't asking for a better tool. He was telling me the only way to do his job was to hand someone else's unreleased footage to a vendor, and he'd decided that was the price of working.

I don't think a subtitle tool *should* require that. Not because privacy is fashionable — because the footage isn't his to upload. He can't consent on his client's behalf, and he knew it. The constraint is real and the workarounds aren't available to him.

### What I built

An upload, a wait, a review screen. Give it a clip and a language pair, get back timed cues you can edit and export as `.srt` or `.vtt`.

Deliberately missing: no account, no API key, no cloud processing, **no third-party AI API anywhere in the request path**. The panel in the header lists every model with its licence, its quantisation, and whether its weights are on disk. That panel is the argument, so I made it visible instead of a README line.

### What happened when he used it

**I have to be straight: I haven't handed it to him yet.**

This deadline is tomorrow morning and this post goes out before he's opened it. Everything below is verified against my own synthetic clip, not his footage.

I'm not going to invent a reaction. The brief invites me to tell you what he said, and when I have it I'll add it here in his words — because that's the part that matters and it's the part I don't have.

What I can show is what the software does when it *can't* do its job, which is the part I'd most like a judge to check:

```bash
curl -X POST localhost:8080/api/traces/demo/failure \
  -H 'Content-Type: application/json' -d '{"mode":"over_budget"}'
```

This asks the caption model to fit 110 characters into 12. It can't. It retries, falls back to a different open-weight model, and when that also fails it **flags the cue for a human with a reason attached**. The request still succeeds. It doesn't truncate and it doesn't invent.

From [`evidence/failure-recovery.txt`](https://github.com/Virtualord/saaz/blob/master/evidence/failure-recovery.txt):

```
user-visible failures: 1
  ! The caption could not be shortened automatically. It is flagged for review
    rather than truncated.
```

A subtitle file is a deliverable a client signs off on. A tool that always emits *something* is worse than useless, because the failure moves to someone who has no idea it happened.

---

## Demo

**Code:** https://github.com/Virtualord/saaz

```bash
git clone https://github.com/Virtualord/saaz.git && cd saaz
npm install
npm run fetch-models      # ~1.6GB of open weights, once
npm run make-demo-asset   # synthesises the Hindi test clip
npm run dev               # http://localhost:5173
```

**No live URL yet.** A `Dockerfile` and `render.yaml` exist, but I had no Docker daemon where I built this, so the image is unbuilt and I'd rather say so than link a deploy that doesn't exist.

A screenshot capture walkthrough is in [`docs/EVIDENCE.md`](https://github.com/Virtualord/saaz/blob/master/docs/EVIDENCE.md).

**The demo clip is synthetic.** Its audio comes from `facebook/mms-tts-hin`, openly licensed, so the demo is reproducible without borrowing anyone's footage. That was deliberate — demoing a tool about not moving footage with borrowed footage would have been quietly contradictory.

Worth watching in the output: cue 5 of the generated SRT reads `Bürench leaves the dust`. That's Hindi `बुप्रे कियो से श्रूए होते है` — "starts from ten rupees per kilo". The pipeline produced a fluent English sentence that is meaningless, and it doesn't know it's wrong. Neither would a caption viewer. That's what the review screen is for, and it's why I'd rather show a bad cue than a curated one.

---

## Code

TypeScript, one process, ~7.7k lines.

| Layer | Choice |
| --- | --- |
| Runtime | Node 22, Express, strict TypeScript |
| Inference | `@huggingface/transformers` over `onnxruntime-node`, **CPU only** |
| ASR | `onnx-community/whisper-small` (MIT), int8 |
| Speech boundaries | `onnx-community/silero-vad` (MIT), driven directly through onnxruntime |
| Translation | `Xenova/opus-mt-hi-en` (Apache-2.0) |
| Caption rewrite | `onnx-community/Qwen2.5-1.5B-Instruct` (Apache-2.0) |
| Database | SQLite via `better-sqlite3`, WAL |
| Frontend | React 19, Vite, Tailwind v4, shadcn/ui (Base UI variant) |
| Deploy | Single Docker container, weights baked in at build time |

```bash
npm test                  # 47 unit tests
npm run typecheck
npm run prove:offline     # verifies the offline claim
npm run evidence          # regenerates evidence/ from a live run
```

Three scripts exist specifically because I distrusted my own conclusions:

```bash
npm run bench:asr         # CER per ASR model
npm run bench:caption     # can any small LM compress to a budget?
npm run prove:offline     # poisons all outbound network, runs the pipeline
```

Key files: [`server/services/fit.ts`](https://github.com/Virtualord/saaz/blob/master/server/services/fit.ts) (the Fit solver) · [`server/core/tracing.ts`](https://github.com/Virtualord/saaz/blob/master/server/core/tracing.ts) · [`server/models/registry.ts`](https://github.com/Virtualord/saaz/blob/master/server/models/registry.ts) (every model with its licence as data, not comments).

---

## How I Built It

```
probe → decode → Whisper ASR → Silero VAD → align → segment → glossary → OPUS-MT → Fit
```

### The problem that shaped the design

Machine translation produces a complete, grammatical sentence. A subtitle isn't a sentence — it's a compressed visual artefact with a hard character budget and a hard deadline. A 3-second Hindi cue often needs *more* English characters than 3 seconds can display.

So the interesting problem isn't transcription. It's **fitting**. [`server/services/fit.ts`](https://github.com/Virtualord/saaz/blob/master/server/services/fit.ts) escalates:

1. **verbatim** — already fits
2. **reflowed** — the caption model rewrites it inside budget
3. **extended** — borrow time from the following gap, if the neighbour has slack
4. **split** — divide at punctuation, retranslate both halves
5. **refused** — nothing worked; flag it and say why

Step 5 is the one I care about. And **the solver is deterministic — there's no LLM in the escalation ladder.** A subtitle deliverable must be reproducible: same input, same output. Randomness there would be a bug, not a feature.

### Two failures worth reading about

**Whisper's timings were fabricated.** My first pipeline used Whisper's segment timestamps directly. On a 29-second clip it returned nine cues of *exactly* 3000ms each — perfectly uniform blocks matching nothing in the audio, including the silences I'd deliberately inserted between lines. Cues built on that would have been visibly wrong.

The `onnx-community` Whisper export has no cross-attention outputs, so it *can't* emit word timestamps. I found this by printing real output instead of trusting the API. The fix was to stop asking Whisper for timing: use Silero VAD to find where people actually speak, then allocate words to those regions proportionally.

That's also the one place I left the tidy architecture. transformers.js has no VAD pipeline and the ONNX repo ships no `config.json`, so I drive the Silero graph directly through onnxruntime — 512-sample windows carrying recurrent state. About 80 lines.

**A caption model that mostly fails.** I added tracing to the caption slot and it immediately showed the feature was mostly not working. Across four realistic cases:

| Model | Inside budget |
| --- | --- |
| Qwen2.5-1.5B-Instruct | ~1/4 |
| SmolLM2-360M-Instruct | 0/4 |
| Qwen2.5-0.5B-Instruct | 0/4 |

Three causes, each found by measuring:

1. My original test omitted `repetition_penalty`, without which Qwen-1.5B loops and looks broken. **I had written "SmolLM2 beats Qwen" into the README on that basis. It was false.**
2. **Requiring JSON output made every model worse.** Asked for `{"lines":[...]}`, they echo the instruction or emit the schema as literal text — `Respect the character limit.` Dropping the JSON requirement got real rewrites: *"The store starts around 7 AM."*, 29 characters into a 32-character budget.
3. Loading a second pipeline instance for the same model id makes generation **hang indefinitely** on CPU.

So the caption slot is plain-text in, validated in code, and treated as a *suggestion*. The solver guarantees the constraints; the model attempts the wording. When it fails — usually — the cue escalates deterministically.

### One trace, one request

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

Read the failed model span. It tried twice, missed both times, and the trace says so with numbers. The solver absorbed it and the job succeeded. That's the whole design in one block: the model is allowed to fail **visibly**, and something deterministic catches it.

Traces are in-process, no vendor, no DSN — because the offline claim is only testable if the instrumentation also works offline. Sentry is an optional forward.

### Latency, measured

29-second clip, 8-core CPU, no GPU:

| Stage | ms |
| --- | --- |
| probe + decode | 326 |
| Whisper ASR | 123,385 |
| Silero VAD | 452 |
| translate | 1,984 |
| fit | 1,390 |

**Cost: $0.** No API, no GPU rental, no per-minute billing.

### Other things measurement changed

- **Hallucination filter.** Whisper appended `अपने अपने अपने…` 100+ times past the end of the audio. Comparing against the previous segment wasn't enough — the degenerate run is one single segment. It now checks internal token diversity.
- **Glossary.** `मालाई` (malai, the sweet) translates as *"by Miley"*. I ruled out a nukta tokenisation bug by normalising it and observing byte-identical output, so it's a vocabulary gap. Saaz lets him pin terms before translation.
- **Gemma is listed but not default.** Weights are downloadable; the licence is Google's Gemma Licence, **not OSI-approved**. Calling that open source would be false, so it's swappable-in only.

---

## Why Does Open Innovation Matter?

The honest version, for this specific project.

### Why I couldn't have built this as effectively with a closed API

Not "closed APIs are worse." For **this** project there's one requirement a closed API structurally cannot satisfy, and five places where open is a genuine but secondary advantage.

**The load-bearing reason: I don't own the footage.** My friend's client does. Uploading unreleased footage to a vendor is a decision my friend isn't entitled to make, and no interface makes that decision his. This isn't a feature request — it's a permission boundary. A closed API can't be configured out of it, because "don't send the bytes" leaves no product.

I can demonstrate it rather than assert it:

```bash
npm run prove:offline
```

This poisons `globalThis.fetch`, points `HF_ENDPOINT` at an unroutable host, imports the pipeline, and runs it end to end. Any stage reaching for the network fails loudly instead of quietly succeeding.

```
baseline                         OK  127328ms  cues=8
pipeline under poisoned network  OK  cues=8
OFFLINE CLAIM VERIFIED
```

Same weights, same code, network off.

**Five secondary advantages:**

**Model control.** When I compare models I compare licence and quantisation, not just accuracy. Gemma is open-*weights* but not open-*source*, and that distinction lives in the UI because I won't call it what it isn't. With a closed API I couldn't have that conversation — there's nothing to inspect.

**Swapping, which I actually used.** The UI exposes an ASR dial. Switching `whisper-small` → `whisper-base` changes the transcript from Devanagari to Arabic. Not hypothetical flexibility — a dropdown, and the failure is instructive enough to screenshot. The same mechanism is why I dropped `whisper-large-v3-turbo` after it returned *empty* transcripts at q8. With a closed API, a bad model choice is a support ticket.

**Fine-tuning, honestly.** I did not fine-tune anything, and the reasons are specific: 4GB VRAM, no dataset of his microphone and codec, and a weekend. I want to be precise that openness made it *possible*, not that I did it. When he has 200 hours of his own audio, fine-tuning Whisper on his voice and equipment is a script. With a closed API it isn't available at any price — and "we'll add your custom model eventually" isn't a fine-tuning path. I'd rather say this than imply a capability I never exercised.

**Customisation.** The glossary is 40 lines and solves the failure I actually hit. `मालाई → Malai` is a four-character fix that a vendor would route through a ticket, a feature request, and a quarterly roadmap.

**Transparency.** When the caption model produced a 265-character caption into an 84-character budget, I could see it, attribute it to that model, and put it in a trace. Everything in `evidence/` regenerates from a live run, so none of it can drift from the code.

### Where open was NOT the reason

**Cost.** $0 versus per-minute billing is real and I measured it — but my friend's bottleneck was the permission boundary, not the £20. If the privacy problem vanished tomorrow and the tools stayed cloud, he'd probably keep paying. I'd rather not dress a secondary win up as the headline.

**None of this substitutes for the models being good.** They aren't. Whisper-small has CER 0.165 on Hindi. The caption model lands in budget about a quarter of the time. Open weights bought me control, inspectability, and a fallback path — not quality I couldn't otherwise have bought.

---

## My Agent Session

The build was agent-assisted throughout, from the environment probe that ruled out Python to the benchmarks that corrected me.

The parts worth reading are where it was wrong and I had to catch it. I described Whisper timings as usable before printing real output. I asserted a model comparison into the README that a later benchmark disproved — and the false claim is still visible in that file's git history, because I corrected the text rather than quietly rewriting it.

```bash
npm run bench:asr
npm run bench:caption
```

Both are reproducible, and both disagree with something I believed at some point.

---

## Prize Categories

**Best Use of Gemma** — `gemma-3-1b-it-ONNX` is wired into the caption slot as a live alternative, selectable per job from the UI. Deliberately *not* the default: the licence isn't OSI-approved, and I'd rather be accurate than convenient.

**Best Use of Render** — one CPU web service, weights baked into the image at build time so it never contacts a model host at runtime. Image unbuilt, as noted above.

**Best Use of Sentry** — spans are `AGENT`/`MODEL`/`TOOL`/`DB` with per-stage latency, token estimates, retry decisions, and recovered-vs-user-visible failures. The tracer is first-party and works with no DSN; Sentry is an optional forward, not a dependency.

**Not entering Best Use of MongoDB Atlas.** SQLite is the right store here, and swapping databases to win a category would cost me the thing the project is actually about.

### What's unfinished

- **My friend hasn't used this yet.** Stated at the top, repeated here.
- **No deployed instance.** Dockerfile and `render.yaml` exist; the image is unverified.
- **Word-level timing is approximated** — VAD regions plus proportional allocation, because the available Whisper export can't emit word timestamps.
- **The caption model is unreliable** (~1/4). The solver handles it; the feature is thin.
- **Hindi only, tested.** Seven more pairs are wired to a multilingual model but unbenchmarked.

Thanks for the challenge — and if someone builds a caption editor that doesn't quietly corrupt regional-language audio, that's still an open problem.