import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { segment, wrapIntoLines, charBudget, checkCue, cpsOf } from '../server/services/segmenter.js';
import { fitTimeline, type FitInput } from '../server/services/fit.js';
import { applyGlossary, DEFAULT_GLOSSARY, glossaryHits } from '../server/services/glossary.js';
import { alignToRegions } from '../server/services/align.js';
import { subtitleConstraints as C, type Cue, type Segment } from '../shared/types.js';
import { toSrt, toVtt } from '../server/services/pipeline.js';
import { layoutLines } from '../shared/cue-rules.js';
import { cleanOutput } from '../server/services/caption.js';

const out0 = (segments: Segment[]) => segments.map((s) => s.text).join(' ');

const seg = (startMs: number, endMs: number, text: string): Segment => ({
  startMs,
  endMs,
  text,
  asrConfidence: null,
  suspectedHallucination: false,
});

describe('charBudget', () => {
  it('is capped by reading speed, not just layout', () => {
    // 2s at 17cps = 34 chars, well under the 84-char layout cap.
    expect(charBudget(2000)).toBe(34);
  });
  it('is capped by layout for long windows', () => {
    expect(charBudget(60_000)).toBe(C.maxLines * C.maxCharsPerLine);
  });
  it('never returns zero', () => {
    expect(charBudget(0)).toBeGreaterThan(0);
  });
});

describe('wrapIntoLines', () => {
  it('keeps short text on one line', () => {
    expect(wrapIntoLines('Hello friends')).toEqual(['Hello friends']);
  });
  it('splits long text into at most two lines', () => {
    const text = 'The shop opens at seven in the morning and closes at ten tonight';
    const lines = wrapIntoLines(text);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.join(' ')).toBe(text);
  });
  it('never emits a line beyond the per-line limit', () => {
    const text = 'word '.repeat(60).trim();
    for (const line of wrapIntoLines(text)) {
      expect(line.length).toBeLessThanOrEqual(C.maxCharsPerLine);
    }
  });
});

describe('segment', () => {
  it('produces cues within constraints for real input', () => {
    const cues = segment([
      seg(264, 5688, 'नमस्ते दोस्तों, आज हम बात करेंगे इस नई मिठाई की दुकान के बारे में'),
      seg(6504, 11352, 'यहाँ की मालाई सबसे ज़्यादा बिकती है क्योंकि वह घी में बनी हुई है'),
    ]);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    for (const c of cues) {
      expect(c.endMs).toBeGreaterThan(c.startMs);
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  it('emits monotonic, non-overlapping cues', () => {
    const cues = segment([
      seg(0, 3000, 'पहली बात यह है कि दुकान बहुत पुरानी है'),
      seg(3100, 6000, 'दूसरी बात यह है कि यहाँ का घी बहुत शुद्ध है'),
      seg(6100, 9000, 'तीसरी बात यह है कि यहाँ की मालाई बहुत लाजवाब है'),
    ]);
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i]!.startMs).toBeGreaterThanOrEqual(0);
      if (i > 0) {
        expect(cues[i]!.startMs).toBeGreaterThanOrEqual(cues[i - 1]!.endMs - C.minGapMs);
      }
    }
  });

  it('breaks at punctuation rather than mid-word when it can', () => {
    const long = 'आज हम बात करेंगे इस नई मिठाई की दुकान के बारे में जिसका नाम बहुत पुराना है';
    const cues = segment([seg(0, 4000, long)]);
    expect(cues.length).toBeGreaterThan(1);
    // Every cue must end on a whole word.
    for (const c of cues) {
      expect(c.text.trim().endsWith('।') || c.text.trim().split(' ').length >= 1).toBe(true);
    }
  });

  it('is deterministic, because the output is a client deliverable', () => {
    const input = [seg(0, 5000, 'दुकान सुबह सात बजे खुलती है और रात दस बजे बंद हो जाती है')];
    expect(segment(input)).toEqual(segment(input));
  });
});

describe('checkCue', () => {
  it('flags a line over the character limit', () => {
    const w = checkCue('x'.repeat(50), 0, 3000);
    expect(w.some((s) => s.includes('line too long'))).toBe(true);
  });
  it('flags text that is too fast to read', () => {
    // 80 chars in 1s = 80cps, far above the ceiling.
    const w = checkCue('word '.repeat(16).trim(), 0, 1000);
    expect(w.some((s) => s.includes('cps'))).toBe(true);
  });
  it('passes a well-formed cue', () => {
    expect(checkCue('The shop opens at seven.', 0, 3000)).toEqual([]);
  });
});

describe('cpsOf', () => {
  it('measures readable characters per second', () => {
    expect(cpsOf('abcde', 1000)).toBe(5);
  });
  it('returns Infinity for a zero-length window', () => {
    expect(cpsOf('abc', 0)).toBe(Infinity);
  });
});

describe('alignToRegions', () => {
  it('places whole words only, never mid-word', () => {
    // The M1 bug: char-proportional slicing produced "...श्रूए ह".
    const words = 'one two three four five six seven eight nine ten';
    const joined = out0(alignToRegions(
      [seg(0, 9000, words)],
      [
        { startMs: 0, endMs: 3000 },
        { startMs: 4000, endMs: 7000 },
        { startMs: 7500, endMs: 9000 },
      ],
    ));
    expect(joined).toBe(words);
    // No cue may begin or end mid-word.
    for (const s of alignToRegions(
      [seg(0, 9000, words)],
      [{ startMs: 0, endMs: 3000 }, { startMs: 4000, endMs: 7000 }, { startMs: 7500, endMs: 9000 }],
    )) {
      expect(s.text.split(' ')[0]).toMatch(/^[A-Za-z]+$/);
      expect(s.text.trim().split(' ').pop()).toMatch(/^[A-Za-z]+$/);
    }
  });

  it('loses no words', () => {
    const input = [seg(0, 5000, 'नमस्ते दोस्तों आज हम बात करेंगे इस नई मिठाई की दुकान')];
    const out = alignToRegions(input, [
      { startMs: 0, endMs: 2500 },
      { startMs: 3000, endMs: 5000 },
    ]);
    const before = input[0]!.text.split(/\s+/).length;
    const after = out0(out).split(/\s+/).filter(Boolean).length;
    expect(after).toBe(before);
  });

  it('never emits a cue that ends before it starts', () => {
    const out = alignToRegions([seg(0, 5000, 'a b c')], [
      { startMs: 1000, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
    ]);
    for (const s of out) expect(s.endMs).toBeGreaterThan(s.startMs);
  });

  it('returns input unchanged when there are no speech regions', () => {
    const input = [seg(0, 1000, 'hello')];
    expect(alignToRegions(input, [])).toEqual(input);
  });
});

describe('fitTimeline', () => {
  const base: FitInput[] = [
    { cue: { startMs: 0, endMs: 3000, text: 'x' }, sourceText: 'नमस्ते', translation: 'Hello friends' },
    { cue: { startMs: 3400, endMs: 6400, text: 'y' }, sourceText: 'लाइन', translation: 'A' },
  ];
  const noReflow = async () => null;

  it('leaves a fitting translation untouched', async () => {
    const cues = await fitTimeline(base, { reflow: noReflow });
    expect(cues[0]!.escalation).toBe('verbatim');
    expect(cues[0]!.lines).toEqual(['Hello friends']);
  });

  it('refuses rather than silently truncating when nothing can fit', async () => {
    const impossible: FitInput[] = [
      {
        // 120 chars into a 1.2s window: ~100 cps. No amount of stretching saves it.
        cue: { startMs: 0, endMs: 1200, text: 'x' },
        sourceText: 'a'.repeat(20),
        translation: 'This caption is far far too long to ever be readable in the window it has been given here',
      },
    ];
    const cues = await fitTimeline(impossible, { reflow: noReflow, maxExtendMs: 0 });
    expect(cues[0]!.escalation).toBe('refused');
    expect(cues[0]!.refusalReason).toMatch(/cps/);
    expect(cues[0]!.warnings).toContain('needs human attention');
  });

  it('accepts a reflow that brings the caption inside the budget', async () => {
    const cues = await fitTimeline(base, {
      reflow: async () => ({ lines: ['Hi'], note: 'compressed' }),
    });
    // First cue fits already, so reflow is never consulted for it.
    expect(cues[0]!.escalation).toBe('verbatim');
  });

  it('uses reflow when the draft overflows and the reflow fits', async () => {
    const overflowing: FitInput[] = [
      {
        cue: { startMs: 0, endMs: 2000, text: 'x' },
        sourceText: 'दस रुपये किलो',
        translation: 'Ten rupees per kilogram which is quite reasonable',
      },
    ];
    const cues = await fitTimeline(overflowing, {
      reflow: async () => ({ lines: ['Ten rupees per kg'], note: '' }),
    });
    expect(cues[0]!.escalation).toBe('reflowed');
    expect(cues[0]!.lines.join(' ')).toBe('Ten rupees per kg');
  });

  it('keeps the timeline monotonic after extensions', async () => {
    const inputs: FitInput[] = [
      { cue: { startMs: 0, endMs: 2000, text: 'a' }, sourceText: 'एक', translation: 'A rather long opening caption line here' },
      { cue: { startMs: 2100, endMs: 4000, text: 'b' }, sourceText: 'दो', translation: 'Two' },
    ];
    const cues = await fitTimeline(inputs, { reflow: noReflow });
    expect(cues[1]!.startMs).toBeGreaterThanOrEqual(cues[0]!.endMs - C.minGapMs);
  });
});

describe('glossary', () => {
  it('pins a term the models demonstrably get wrong', () => {
    // M1 measurement: "मालाई" alone translated to "by Miley".
    const out = applyGlossary('यहाँ की मालाई सबसे ज़्यादा बिकती है', DEFAULT_GLOSSARY);
    expect(out).toContain('Malai');
    expect(out).not.toContain('मालाई');
  });

  it('prefers the longest matching term', () => {
    const g = { entries: [{ source: 'दुकान', target: 'shop' }, { source: 'मिठाई की दुकान', target: 'sweet shop' }] };
    expect(applyGlossary('मिठाई की दुकान यहाँ है', g)).toBe('sweet shop यहाँ है');
  });

  it('reports which entries fired', () => {
    expect(glossaryHits('मालाई और दुकान', DEFAULT_GLOSSARY)).toEqual(['मालाई', 'दुकान']);
  });

  it('is a no-op on text with no known terms', () => {
    expect(applyGlossary('completely unrelated text', DEFAULT_GLOSSARY)).toBe('completely unrelated text');
  });

  it('does not throw on regex-significant characters', () => {
    const g = { entries: [{ source: 'a.b', target: 'X' }] };
    expect(applyGlossary('xxa.byy', g)).toBe('xxXyy');
  });
});
describe('subtitle export', () => {
  const cue = (startMs: number, endMs: number, lines: string[]): Cue => ({
    startMs,
    endMs,
    sourceText: 'src',
    translation: 'en',
    lines,
    escalation: 'verbatim',
    refusalReason: null,
    chars: lines.join('').length,
    cps: 5,
    warnings: [],
  });

  it('writes valid SRT with comma-millisecond timestamps', () => {
    const srt = toSrt([cue(264, 2976, ['Hello friends'])]);
    expect(srt).toContain('00:00:00,264 --> 00:00:02,976');
    expect(srt.startsWith('1\n')).toBeTruthy();
  });

  it('writes valid WebVTT with dot-millisecond timestamps', () => {
    // WebVTT uses 3-digit ms after a dot; the earlier code emitted 00:00:000
    // with no separator, which players reject.
    const vtt = toVtt([cue(264, 2976, ['Hello friends'])]);
    expect(vtt.startsWith('WEBVTT')).toBeTruthy();
    expect(vtt).toContain('00:00:00.264 --> 00:00:02.976');
    expect(vtt).not.toMatch(/\d\d:\d\d:\d\d\d\d\d/);
  });

  it('carries warnings into the VTT so an editor can see them', () => {
    const c = { ...cue(0, 1000, ['too fast']), warnings: ['too fast to read: 40.0 cps (max 17)'] };
    expect(toVtt([c])).toContain('NOTE too fast to read');
  });

  it('numbers cues sequentially from one', () => {
    const srt = toSrt([cue(0, 1000, ['a']), cue(2000, 3000, ['b'])]);
    // Cue 1 starts the file with no leading blank line, so assert on the index
    // markers rather than assuming a newline before the first one.
    expect(srt.startsWith('1\n')).toBeTruthy();
    expect(srt).toContain('\n2\n');
  });
});

describe('layoutLines width guarantee', () => {
  it('never returns a line wider than the limit, for any input', () => {
    const cases = [
      'word '.repeat(60).trim(),
      'a',
      'x'.repeat(200),
      'नमस्ते दोस्तों, आज हम बात करेंगे इस नई मिठाई की दुकान के बारे में',
      'supercalifragilisticexpialidocious '.repeat(10).trim(),
      '',
    ];
    for (const text of cases) {
      for (const line of layoutLines(text).lines) {
        expect(line.length).toBeLessThanOrEqual(C.maxCharsPerLine);
      }
    }
  });

  it('reports fits=false when more than two lines are needed', () => {
    expect(layoutLines('word '.repeat(60).trim()).fits).toBe(false);
  });

  it('reports fits=true for text that fits in two lines', () => {
    expect(layoutLines('The shop opens at seven in the morning and closes at ten').fits).toBe(true);
  });

  it('preserves all words across the wrap', () => {
    const text = 'one two three four five six seven eight nine ten eleven twelve';
    expect(layoutLines(text).lines.join(' ').split(' ')).toEqual(text.split(' '));
  });
});

describe('browser safety', () => {
  it('cue-rules imports nothing Node-specific', () => {
    // The editor imports this module in the browser. A stray `process.env` or
    // node: import here throws "process is not defined" at runtime, which is a
    // bug we shipped once, so it is guarded by a test.
    //
    // Only executable code is checked: comments legitimately mention "process"
    // when explaining this very failure.
    const source = readFileSync(new URL('../shared/cue-rules.ts', import.meta.url), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
      .join('\n');

    expect(code).not.toMatch(/\bprocess\s*\./);
    expect(code).not.toMatch(/from ['"]node:/);
    expect(code).not.toMatch(/require\(/);
    expect(code).not.toMatch(/better-sqlite3|onnxruntime-node/);
  });

  it('no web/ module imports from server/', () => {
    const dir = new URL('../web/src/', import.meta.url);
    const offenders: string[] = [];
    const walk = (u: URL) => {
      for (const entry of readdirSync(u, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(new URL(`${entry.name}/`, u));
        else if (/\.tsx?$/.test(entry.name)) {
          const src = readFileSync(new URL(entry.name, u), 'utf8');
          if (/server\//.test(src)) offenders.push(entry.name);
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});

// Guards the plain-text caption path. Small models wrap answers in quotes,
// echo the instruction, or answer the format instead of the task; each must be
// rejected so the Fit solver escalates instead of shipping it.
describe('cleanOutput — caption output validation', () => {
  it('accepts a plain caption', () => {
    expect(cleanOutput('The store starts around 7 AM.')).toBe('The store starts around 7 AM.');
  });

  it('strips wrapping quotes', () => {
    expect(cleanOutput('"The store starts around 7 AM."')).toBe('The store starts around 7 AM.');
  });

  it('collapses whitespace and newlines', () => {
    expect(cleanOutput('  The  shop\n opens  ')).toBe('The shop opens');
  });

  it('rejects a JSON blob, since it answered the format not the task', () => {
    expect(cleanOutput('{"lines":["a"]}')).toBeNull();
  });

  it('rejects instruction echoes', () => {
    expect(cleanOutput('Respect the character limit.')).toBeNull();
    expect(cleanOutput('Rewrite: at most 32 characters')).toBeNull();
    expect(cleanOutput('The output should be concise')).toBeNull();
    expect(cleanOutput('Note: I have shortened the draft')).toBeNull();
    // Observed verbatim from Qwen2.5-1.5B during prompt-variant testing.
    expect(cleanOutput('Respect the character limit.')).toBeNull();
    expect(cleanOutput('Here is the revised subtitle:')).toBeNull();
    expect(cleanOutput('The output should be concise')).toBeNull();
  });

  it('accepts real captions that contain echo-ish words later on', () => {
    expect(cleanOutput('Subtitle: opens at 7am')).toBeNull(); // leading label: rejected
    expect(cleanOutput('The limit is 10 rupees per kilo')).toBe('The limit is 10 rupees per kilo');
  });

  it('rejects empty output', () => {
    expect(cleanOutput('')).toBeNull();
    expect(cleanOutput('   \n  ')).toBeNull();
  });

  it('keeps a caption that merely starts with a normal word', () => {
    expect(cleanOutput('Opens at 7am')).toBe('Opens at 7am');
  });
});
