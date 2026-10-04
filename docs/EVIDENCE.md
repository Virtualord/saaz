# Evidence checklist — Hacktoberfest Weekend Challenge

Everything here is regenerable with `npm run evidence`. Nothing is hand-written, so nothing can
drift from the code.

## Before you capture anything

```bash
cd saaz
npm run fetch-models       # weights on disk
npm run make-demo-asset    # the Hindi clip
npm run build              # frontend + server
npm run evidence           # regenerates evidence/ from a live run (~4 min)
npm run prove:offline      # the headline verification
npm test                   # 47 tests
```

## Screenshots to take

Set a 1440×900 window and a light theme. Use the **landing page** for anything about the product,
and the **app** for anything about behaviour.

### 1. Landing page, full height
`npm run dev` → open `http://localhost:5173`.

Shows the hero, the eight-stage pipeline, the five fit outcomes, and the licence table. Frame it so
the hero and the pipeline card are both visible — that pairing is the whole pitch.

### 2. "What is running?" panel
Scroll to it, or click **What is running?** in the header.

This is the panel that backs the central claim. Every model with its licence, dtype, size, and
whether it is on disk. Screenshot the `asr`, `mt` and `caption` slots together.

### 3. A real job running
Upload `data/out/demo-hi.wav`.

Capture the **progress list mid-run**, showing `Transcribing (Whisper)` active. This is honest
evidence that the stages are real and sequential, not a spinner.

### 4. The result
Same job, after it finishes.

Frame the stat cards and the first two or three cues. The `needs you` card is the one that matters:
if it reads `0`, the Fit solver handled everything; if it reads `1`, that is the refusal working.

### 5. A cue flagged `needs a human`
If step 4 shows one, scroll to it and capture the card with the red `needs a human` badge and the
refusal reason. This single screenshot answers "what happens when the AI can't do it?"

### 6. The Timings tab
Shows per-stage latency as bars, with speech recognition dominating at ~80s of a ~130s job. Use it
when someone asks why it is slow, and to show the cost split is real.

### 7. Model swapping
Change **asr** from `whisper-small` to `whisper-base`, re-run, capture the transcript difference.

`whisper-base` emits Arabic script for Hindi audio. Seeing that happen is more persuasive than any
claim about it.

## Terminal captures

These are the strongest evidence, and they are text — so they go in the post as code blocks, no
screenshot needed.

```bash
# The headline verification
npm run prove:offline

# One complete request, as a trace tree
npm run evidence
cat evidence/trace.txt

# The deliberate failure drill
cat evidence/failure-recovery.txt

# Model selection, with numbers
cat evidence/bench-asr.txt
cat evidence/benchmark.txt

# The subtitle output itself
cat evidence/srt-sample.srt
```

## What each artifact proves

| File | Claim it backs |
| --- | --- |
| `evidence/trace.txt` | one request → `AGENT → MODEL → TOOL → DB → RESULT`, with latency, tokens, retries |
| `evidence/failure-recovery.txt` | a real failure degrades gracefully; nothing is silently truncated |
| `evidence/srt-sample.srt` | it produces a real, loadable subtitle file |
| `evidence/bench-asr.txt` | model defaults were measured, not assumed |
| `evidence/benchmark.txt` | the caption model is unreliable, and we say so |
| `evidence/summary.json` | headline numbers, machine-readable |

## Honesty checks before you submit

- [ ] The post does **not** claim any model is reliable at caption compression. It is not.
- [ ] The post does **not** claim word-level timings. They are approximated from VAD regions.
- [ ] Gemma is described as open-weights, not open source. Its licence is not OSI-approved.
- [ ] If you quote the benchmarks, quote the *current* numbers, not the earlier claim that
      SmolLM2 beat Qwen. That claim was wrong and was caught by the benchmark.
- [ ] The demo clip is synthetic (open TTS). Say so.
- [ ] The deployed instance is untested. Say so, or deploy it first.

## If you get the handover done

Add a screenshot of the actual `.srt` loaded in a player with his real footage, and quote him
directly. The brief rewards handing the project over, and that evidence is worth more than every
screenshot above combined.