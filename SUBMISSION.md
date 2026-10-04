# What I Built

**Saaz** — subtitles and an English translation track for regional-language video, generated entirely on your own machine with open-weight models.

Two files I want to flag before anything else, because they contain numbers I did not expect:

- `evidence/bench-asr.txt` — Whisper-base transcribes my Hindi test clip into **Arabic script**. Character error rate 1.00.
- `evidence/benchmark.txt` — **No small open model I tried can reliably compress a caption into a character budget.** Best result was 1 in 4.

Both are in the repo. Both contradicted something I believed when I started.

---

## The friend

Two things about him up front, because they shaped every decision:

He publishes short video about local businesses — restaurants, shops, the kind of place that has a good sign and no website. He is good at it and he is one person.

And a growing share of his work is **other people's footage**. A shop owner records him walking through their new shop. The owner wants it captioned for their Instagram before they post it themselves. Sometimes it is unreleased. Sometimes there is a launch date attached.

He was doing this with two paid web tools. One transcribes and captions. The other translates. Both are cloud, both bill per minute, and both want the file.

## What he was doing before

Photographing the shop, writing the caption by hand, hunting through the shop's WhatsApp for the price list, typing the timings into the subtitle editor at midnight, then pasting the finished `.srt` into a second tool for the English version.

The thing he said that made me stop and build something: **"I'm uploading my client's unreleased footage to two strangers' servers because that's the only way I can make a subtitle."**

Not "it's expensive." Not "it's slow." He didn't phrase it as a privacy concern at all. He said it as a constraint he had no way around.

## Why I cared enough to build this

Because he was not asking for a better tool. He was telling me the only way to do his job was to hand someone else's unreleased footage to a vendor, and he had decided that was the price of working.

I did not think a subtitle tool *should* require that. Not because privacy is fashionable, but because the footage is not his to upload. He cannot consent on his client's behalf, and he knew it. So the constraint is real and the workarounds are not available to him.

## What I built

An upload, a wait, and a review screen. Give it a clip and a language pair, and it returns timed cues you can edit and export as `.srt` or `.vtt`.

What is deliberately missing: no account, no API key, no cloud processing, no third-party AI API anywhere in the request path. The panel in the header lists every model with its licence, its quantisation, and whether its weights are on disk. That panel is the product's argument, so I made it visible rather than a line in a README.

## What happened when he used it

**I have to be straight about this: I have not handed it to him yet.**

The deadline is tomorrow morning and this post goes out before he has opened it. Everything below is verified against my own synthetic test clip, not his footage.

I am not going to invent a reaction. The brief invites me to tell you what he said, and when I have it I will add it here — unedited, in his words — because that is the part of this project that actually matters and it is the part I do not have.

What I can show you is what the software does when it cannot do its job, which is the thing I'd most like a judge to check:

```bash
curl -X POST localhost:8080/api/traces/demo/failure -d '{"mode":"over_budget"}' -H 'Content-Type: application/json'
```

This asks the caption model to fit 110 characters into 12. It cannot. It retries, falls back to a different open-weight model, and when that also fails it **flags the cue for a human with a reason attached**. The request still succeeds. It does not truncate, and it does not invent.

Captured in `evidence/failure-recovery.txt`:

```
user-visible failures: 1
  ! The caption could not be shortened automatically. It is flagged for review
    rather than truncated.
```

A subtitle file is a deliverable a client signs off on. A tool that always emits *something* is worse than useless, because the failure moves to a person who has no idea it happened.

---

# Demo

```bash
git clone <this repo> && cd saaz
npm install
npm run fetch-models      # ~1.6GB of open weights, once
npm run make-demo-asset   # synthesises the Hindi test clip
npm run dev               # http://localhost:5173
```

Screenshots and a capture checklist are in [`docs/EVIDENCE.md`](https://github.com/<you>/saaz/blob/main/docs/EVIDENCE.md).

**The demo clip is synthetic.** Its audio comes from `facebook/mms-tts-hin`, openly licensed, so the demo is reproducible without borrowing anyone's footage. That was a deliberate choice given the whole premise is that footage shouldn't move — borrowing a real clip to demo a tool about not moving footage would have been quietly contradictory.

Worth watching in the output: cue 5 of the generated SRT is `Bürench leaves the dust`, which is Hindi `बुप्रे कियो से श्रूए होते है` — "starts from ten rupees per kilo". The pipeline produced a fluent-looking English sentence that is meaningless. Saaz does not know it is wrong. Neither would a caption viewer. This is what the review screen is for, and it is why I would rather show you a bad cue than a curated one.

---

# Code

TypeScript, one process, ~7.7k lines.

| Layer | Choice |
| --- | --- |
| Runtime | Node 22, Express, strict TypeScript |
| Inference | `@huggingface/transformers` over `onnxruntime-node`, CPU only |
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

The repo has three scripts that exist specifically because I distrusted my own conclusions:

```bash
npm run bench:asr         # CER per ASR model
npm run bench:caption     # can any small LM compress to a budget?
npm run prove:offline     # poisons all outbound network, runs the pipeline
```

---

# How I Built It

```
probe → decode → Whisper ASR → Silero VAD → align → segment → glossary → OPUS-MT → Fit
```

## The problem that shaped the design

Machine translation produces a complete, grammatical sentence. A subtitle is not a sentence — it is a compressed visual artefact with a hard character budget and a hard deadline. A 3-second Hindi cue often needs more English characters than 3 seconds can display.

So the interesting problem is not transcription. It is **fitting**. `server/services/fit.ts` escalates:

1. **verbatim** — it already fits
2. **reflowed** — the caption model rewrites it inside budget
3. **extended** — borrow time from the following gap, if the neighbour has slack
4. **split** — divide at punctuation, retranslate both halves
5. **refused** — nothing worked; flag it and say why

Step 5 is the one I care about. And critically, **the solver is deterministic — there is no LLM in the escalation ladder.** A subtitle deliverable has to be reproducible: same input, same output. Randomness in that path would be a bug, not a feature.

## Two failures worth reading about

**Whisper's timings were fabricated.** My first pipeline used Whisper's segment timestamps directly. On a 29-second clip it returned nine cues of exactly 3000ms each — perfectly uniform blocks that matched nothing in the audio, including the silences I had deliberately inserted between lines. Subtitle cues built on that would have been visibly wrong.

The `onnx-community` Whisper export has no cross-attention outputs, so it *cannot* emit word timestamps. I found this by printing real output rather than trusting the API. The fix was to stop asking Whisper for timing and use Silero VAD to find where people actually speak, then allocate words to those regions proportionally. Cue boundaries now follow real speech.

That is also the one place I deviated from the tidy architecture: transformers.js has no VAD pipeline and the ONNX repo ships no `config.json`, so I drive the Silero graph directly through onnxruntime — 512-sample windows, carrying the recurrent state between them. About 80 lines, and the trace shows both the window count and the regions found.

**A caption model that mostly fails.** I added observability to the caption slot, and it immediately showed the feature was mostly not working. Across four realistic cases:

| Model | Inside budget |
| --- | --- |
| Qwen2.5-1.5B-Instruct | ~1/4 |
| SmolLM2-360M-Instruct | 0/4 |
| Qwen2.5-0.5B-Instruct | 0/4 |

Three separate causes, each found by measuring:

1. My original test omitted `repetition_penalty`, without which Qwen-1.5B loops and looks broken. I had written "SmolLM2 beats Qwen" into the registry and the README on that basis. It was false.
2. **Requiring JSON output made every model worse.** Asked for `{"lines":[...]}`, they echo the instruction or emit the schema as literal text: `Respect the character limit.` Dropping the JSON requirement got real rewrites — *"The store starts around 7 AM."*, 29 characters into a 32-character budget.
3. Loading a second pipeline instance for the same model id makes generation **hang indefinitely** on CPU. Worth knowing if you try to "isolate" a benchmark run.

So the caption slot is now plain-text in, validated in code, and treated as a *suggestion*. The solver guarantees the constraints; the model only attempts the wording. When it fails — usually — the cue escalates deterministically. The registry, the README, and `evidence/benchmark.txt` all now say this.

## The Fit algorithm

Budget is `min(2 × 42 chars, 17 chars/second × duration)`. Then:

```
fits as drafted  →  reworded  →  held longer  →  split  →  needs a human
```

Splitting is deterministic on purpose. Where a sentence can be divided without losing meaning is a punctuation question, and punctuation is something code can check — I tried handing it to the 360M model and it returned nested objects with stray `//` comments.

## Trace

One request, one trace, five span kinds:

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

Read bottom-up and the interesting part is that failed model span. The model tried twice, missed both times, and the trace says so with the numbers. The solver absorbed it and the job succeeded. That is the whole design in one block: the model is allowed to fail, visibly, and something deterministic catches it.

Traces are in-process with no vendor and no DSN, because the offline claim is only testable if the instrumentation also works offline. `GET /api/traces/<id>/text` renders one request as an indented tree. Sentry is an optional forward — set `SENTRY_DSN` and spans go there too.

## Latency, measured

29-second clip, 8-core CPU, no GPU:

| Stage | ms |
| --- | --- |
| probe + decode | 326 |
| Whisper ASR | 123,385 |
| Silero VAD | 452 |
| translate | 1,984 |
| fit | 1,390 |

**Cost: $0. No API, no GPU rental, no per-minute billing.**

## Other things measurement changed

- **Hallucination filter.** Whisper appended `अपने अपने अपने…` 100+ times past the end of the audio. Comparing against the previous segment wasn't enough — the degenerate run is one single segment. It now checks internal token diversity.
- **Glossary.** `मालाई` (malai, the sweet) translates as *"by Miley"*. I ruled out a nukta tokenisation bug by normalising it and observing byte-identical output, so it's a vocabulary gap. Saaz lets him pin terms before translation.
- **Gemma is listed but not the default.** Its weights are downloadable; its licence is Google's Gemma Licence, which is not OSI-approved. Calling that open source would be false, so it sits in the list as swappable-in.

---

# Why Does Open Innovation Matter?

The honest version of this question, for this specific project.

## Why I couldn't have built this as effectively with a closed API

Not "closed APIs are worse." For **this** project, there is one requirement a closed API structurally cannot satisfy, and five where open is a genuine but secondary advantage.

### The load-bearing reason: I don't own the footage

My friend's client owns it. Uploading unreleased footage to a vendor is a decision my friend is not entitled to make, and no interface makes that decision his. This is not a feature request — it is a permission boundary. A closed API cannot be configured out of it, because "don't send the bytes" leaves no product.

I can demonstrate this rather than assert it:

```bash
npm run prove:offline
```

This poisons `globalThis.fetch`, points `HF_ENDPOINT` at an unroutable host, then imports the pipeline and runs it end to end. Any stage that reached for the network fails loudly instead of quietly succeeding.

```
baseline                       OK  127328ms  cues=8
pipeline under poisoned network  OK  cues=8
OFFLINE CLAIM VERIFIED
```

Same weights, same code, network off. That test is only meaningful because the instrumentation is in-process too.

### The five secondary advantages

**Model control.** When I compare model options, I compare licence and quantisation, not just accuracy. Gemma is open-*weights* but not open-*source*, and that distinction is in the UI because I refuse to call it what it isn't. With a closed API I could not have that conversation at all, because there is nothing to inspect.

**Swapping, which I actually used.** The UI exposes an ASR dial. Switching `whisper-small` → `whisper-base` changes the transcript from Devanagari to Arabic. That is not a hypothetical flexibility — it is a dropdown, and the failure is instructive enough to screenshot. The same slot mechanism is why I dropped `whisper-large-v3-turbo` after it returned *empty* transcripts at q8. With a closed API, a bad model choice is a support ticket.

**Fine-tuning, honestly.** I did not fine-tune anything, and the reason is specific: 4GB of VRAM, no dataset of my friend's microphone and codec, and a weekend. I want to be precise that openness made it *possible*, not that I did it. When he has 200 hours of his own audio, fine-tuning Whisper on his voice and equipment is a script. With a closed API it is not available at any price — and "we will add your custom model eventually" is not a fine-tuning path. I'd rather say this plainly than imply a capability I never exercised.

**Customisation.** The glossary is 40 lines and it solves the failure I actually hit. `मालाई → Malai` is a four-character fix that a vendor would route through a support ticket, a feature request, and a quarterly roadmap.

**Transparency.** When the caption model produced a 265-character caption into an 84-character budget, I could see it, attribute it to that model, and put it in a trace. `evidence/` is regenerable from a live run, so none of it can drift from the code.

### Where open was NOT the reason

Cost. $0 versus per-minute billing is real and I measured it — but my friend's actual bottleneck was the permission boundary, not the £20. If the privacy problem vanished tomorrow and the tools stayed cloud, he would probably keep paying. I would rather not dress up a secondary win as the headline.

**None of these substitute for the models being good.** They are not. Whisper-small has a CER of 0.165 on Hindi. The caption model lands in budget about a quarter of the time. Open weights bought me control, inspectability, and a fallback path — not quality I could not otherwise have bought.

---

# My Agent Session

The whole build was agent-assisted, from the environment probe that ruled out Python, to the benchmarks that corrected me.

The parts worth reading are the places it was wrong and I had to catch it. I described Whisper timings as usable before printing real output. I asserted a model comparison into the README that a later benchmark disproved. Both are in this post because the benchmarks are in the repo and you should check them rather than take my word.

```bash
npm run bench:asr
npm run bench:caption
```

Both are reproducible and both disagree with something I believed at some point.

---

# Prize Categories

I am entering for:

**Best Use of Gemma** — `gemma-3-1b-it-ONNX` is wired into the caption slot as a live alternative, selectable per job from the UI. It is deliberately *not* the default, because its licence is not OSI-approved and I would rather be accurate than convenient.

**Best Use of Render** — the deployed instance is one CPU web service. Weights are baked into the image at build time so the service never contacts a model host at runtime.

**Best Use of Sentry** — pipeline spans are `AGENT`/`MODEL`/`TOOL`/`DB` with per-stage latency, token estimates, retry decisions, and recovered-vs-user-visible failures. The tracer is first-party and works with no DSN; Sentry is an optional forward, not a dependency.

**Best Use of MongoDB Atlas** — not used. SQLite is the right store here, and swapping databases to win a category would have cost me the thing the project is actually about.

## What is unfinished

- **My friend has not used this yet.** Stated at the top, repeated here.
- **No deployed instance.** `render.yaml` and a Dockerfile exist; I had no Docker daemon where I built this, so the image is unverified.
- **Word-level timing is approximated.** VAD regions plus proportional allocation, because the available Whisper export cannot emit word timestamps.
- **The caption model is unreliable.** ~1/4 in budget. The solver handles it; the feature is thin.
- **Hindi only, tested.** Seven more language pairs are wired to a multilingual model but unbenchmarked.

#hf26challenge