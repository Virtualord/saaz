# Evidence

Every file here is regenerable with:

```bash
npm run evidence      # ~4 min: runs the pipeline live and rewrites these files
```

Committed deliberately. The submission post cites these numbers, and a judge
should not have to trust prose that a script could contradict.

| File | What it shows |
| --- | --- |
| `trace.txt` | one request as an indented tree: `AGENT → MODEL → TOOL → DB`, with latency, tokens, retry events |
| `trace.json` | the same trace, structured |
| `failure-recovery.txt` | a real failure (110 chars into a 12-char budget) degrading instead of truncating |
| `srt-sample.srt` / `vtt-sample.vtt` | real subtitle output |
| `summary.json` | headline numbers, machine-readable |
| `bench-asr.txt` | CER per ASR model — includes whisper-base emitting Arabic script for Hindi |
| `benchmark.txt` | caption-slot benchmark — includes the result that corrected a claim in the README |

Two of these contradict something I believed when writing the post. That is the
point of committing them.

Regenerating requires the model weights (`npm run fetch-models`) and takes a few
minutes on CPU. Nothing here is hand-edited.
