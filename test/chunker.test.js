import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { cuesToSentences, chunkSentences, chunkCues } from "../src/chunker.js";
import { parseSubtitles } from "../src/subtitles.js";
import { config } from "../src/config.js";

/** Build cues from `[text, startMs, endMs]` triples. */
const cuesFrom = (rows) =>
  rows.map(([text, startMs, endMs], index) => ({ index, startMs, endMs, text }));

/** Evenly spaced cues, `gapMs` of silence between each. */
function evenCues(texts, { durationMs = 3000, gapMs = 200 } = {}) {
  let t = 0;
  return texts.map((text, index) => {
    const cue = { index, startMs: t, endMs: t + durationMs, text };
    t += durationMs + gapMs;
    return cue;
  });
}

/* ------------------------------------------------------------- sentences --- */

test("a sentence spanning two cues keeps the full cue range", () => {
  const cues = cuesFrom([
    ["This sentence starts here", 0, 2000],
    ["and finishes in the next cue.", 2200, 4000],
  ]);

  const sentences = cuesToSentences(cues);
  assert.equal(sentences.length, 1);
  assert.equal(sentences[0].cueStart, 0);
  assert.equal(sentences[0].cueEnd, 1);
  assert.equal(sentences[0].startMs, 0);
  assert.equal(sentences[0].endMs, 4000);
});

test("two sentences inside one cue are split but share the cue", () => {
  const cues = cuesFrom([["First one. Second one.", 5000, 9000]]);
  const sentences = cuesToSentences(cues);

  assert.equal(sentences.length, 2);
  assert.equal(sentences[0].text, "First one.");
  assert.equal(sentences[1].text, "Second one.");
  assert.equal(sentences[1].cueStart, 0);
  assert.equal(sentences[1].startsCue, false, "the second sentence does not begin the cue");
});

test("does not split on abbreviations, decimals, versions or filenames", () => {
  const traps = [
    "We use e.g. Expo Router for this.",
    "That is i.e. the same thing.",
    "Install version 1.2.3 now.",
    "The value is 3.5 seconds.",
    "Open app.json and edit it.",
    "Import from React.js today.",
    "Upgrade to v2.0 of the SDK.",
    "Check etc. before continuing.",
  ];

  for (const text of traps) {
    const sentences = cuesToSentences(cuesFrom([[text, 0, 4000]]));
    assert.equal(sentences.length, 1, `should not split: ${text}`);
    assert.equal(sentences[0].text, text);
  }
});

test("splits an abbreviation only when a real sentence follows", () => {
  const sentences = cuesToSentences(cuesFrom([["Use etc. We then continue.", 0, 4000]]));
  assert.equal(sentences.length, 1, "'etc. We' is not a boundary");
});

test("caps unpunctuated speech and marks the cut as forced", () => {
  // 12 cues of ~60 chars with no terminator anywhere: ~720 chars, well past the
  // 400-char cap, so the splitter has to fall back to a cue boundary.
  const run = Array.from({ length: 12 }, (_, i) => `this is unpunctuated speech number ${i} running on`);
  const sentences = cuesToSentences(evenCues(run));

  assert.ok(sentences.length > 1, "an overlong run must be broken up");
  assert.ok(
    sentences.some((s) => s.forcedCut),
    "a break with no punctuation available is flagged forcedCut"
  );
  for (const s of sentences) {
    assert.ok(
      s.text.length <= config.chunking.maxSentenceChars + 120,
      `sentence of ${s.text.length} chars exceeds the cap by too much`
    );
  }
});

test("a forced cut lands on the longest pause available", () => {
  // Six unpunctuated cues; the gap before cue 4 is far longer than the others,
  // so that is where the break belongs.
  const cues = [
    { index: 0, startMs: 0, endMs: 3000, text: "a".repeat(90) },
    { index: 1, startMs: 3100, endMs: 6000, text: "b".repeat(90) },
    { index: 2, startMs: 6100, endMs: 9000, text: "c".repeat(90) },
    { index: 3, startMs: 9100, endMs: 12000, text: "d".repeat(90) },
    { index: 4, startMs: 20000, endMs: 23000, text: "e".repeat(90) }, // 8s pause
    { index: 5, startMs: 23100, endMs: 26000, text: "f".repeat(90) },
  ];

  const sentences = cuesToSentences(cues);
  assert.ok(
    sentences.some((s) => s.cueStart === 4),
    "a sentence should begin at the cue after the long pause"
  );
});

test("marks discourse-marker openings", () => {
  const sentences = cuesToSentences(cuesFrom([["So we begin. The next part follows.", 0, 5000]]));
  assert.equal(sentences[0].isDiscourseStart, true);
  assert.equal(sentences[1].isDiscourseStart, false);
});

test("returns an empty array for no cues", () => {
  assert.deepEqual(cuesToSentences([]), []);
  assert.deepEqual(cuesToSentences(null), []);
});

/* ---------------------------------------------------------------- chunks --- */

test("a short lesson produces one chunk covering every cue", () => {
  const cues = evenCues(["First sentence here.", "Second sentence here.", "Third one."]);
  const chunks = chunkCues(cues);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].cueStart, 0);
  assert.equal(chunks[0].cueEnd, 2);
  assert.equal(chunks[0].startMs, cues[0].startMs);
  assert.equal(chunks[0].endMs, cues.at(-1).endMs);
});

test("prefers closing on a long pause once past the minimum size", () => {
  // One sentence per cue at ~46 chars, so cue index == sentence index and the
  // packed size is roughly 47 * (n + 1) chars.
  const texts = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} is a reasonable length here.`);

  // Put the pause where a close is actually permitted: after 15 sentences the
  // chunk holds ~705 chars, past minChars (600) but short of targetChars (1200),
  // which is exactly the window where a structural break should win over size.
  const PAUSE_BEFORE = 15;
  const cues = evenCues(texts);
  cues.slice(PAUSE_BEFORE).forEach((cue) => {
    cue.startMs += 3000;
    cue.endMs += 3000;
  });

  const chunks = chunkCues(cues);
  assert.ok(
    chunks.some((c) => c.cueEnd === PAUSE_BEFORE - 1),
    `a chunk should end on cue ${PAUSE_BEFORE - 1}, right before the pause; ` +
      `got ends at ${chunks.map((c) => c.cueEnd).join(", ")}`
  );
});

test("a pause below the minimum size is ignored in favour of filling the chunk", () => {
  // Same shape, but the pause lands after only ~470 chars. Closing there would
  // emit an undersized chunk, so size has to win.
  const texts = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} is a reasonable length here.`);
  const cues = evenCues(texts);
  cues.slice(10).forEach((cue) => {
    cue.startMs += 3000;
    cue.endMs += 3000;
  });

  const chunks = chunkCues(cues);
  assert.ok(
    !chunks.some((c) => c.cueEnd === 9),
    "an early pause must not produce a chunk under minChars"
  );
});

test("never exceeds maxChars and never dips under minChars except at the end", () => {
  const texts = Array.from({ length: 200 }, (_, i) => `Line ${i} of the lecture transcript here.`);
  const chunks = chunkCues(evenCues(texts));

  chunks.forEach((chunk, i) => {
    assert.ok(
      chunk.text.length <= config.chunking.maxChars,
      `chunk ${i} is ${chunk.text.length} chars, over max`
    );
    if (i < chunks.length - 1) {
      assert.ok(
        chunk.text.length >= config.chunking.minChars,
        `chunk ${i} is ${chunk.text.length} chars, under min`
      );
    }
  });
});

test("overlap repeats whole sentences, never a partial word", () => {
  const texts = Array.from({ length: 120 }, (_, i) => `Sentence ${i} carries some real content along.`);
  const cues = evenCues(texts);
  const chunks = chunkCues(cues);

  assert.ok(chunks.length > 1, "need multiple chunks to have overlap");

  const sentences = cuesToSentences(cues).map((s) => s.text);
  for (const chunk of chunks) {
    // Every sentence in a chunk must be a sentence the splitter produced,
    // which can only be true if no chunk boundary cut through one.
    for (const piece of chunk.text.split(/(?<=[.!?])\s+/)) {
      if (piece.trim() === "") continue;
      assert.ok(sentences.includes(piece.trim()), `chunk contains a partial sentence: "${piece}"`);
    }
  }
});

test("consecutive chunks overlap rather than butting up against each other", () => {
  const texts = Array.from({ length: 120 }, (_, i) => `Sentence ${i} carries some real content along.`);
  const chunks = chunkCues(evenCues(texts));

  const overlapping = chunks.slice(1).filter((chunk, i) => chunk.cueStart <= chunks[i].cueEnd);
  assert.ok(overlapping.length > 0, "at least some chunks should share cues with their predecessor");
});

test("respects option overrides without touching config", () => {
  const texts = Array.from({ length: 60 }, (_, i) => `Line ${i} here with a little text.`);
  const cues = evenCues(texts);

  const small = chunkCues(cues, { targetChars: 300, minChars: 150, maxChars: 500, overlapChars: 0 });
  const large = chunkCues(cues, { targetChars: 2000, minChars: 900, maxChars: 3000, overlapChars: 0 });

  assert.ok(small.length > large.length, "a smaller target must yield more chunks");
  for (const chunk of small) assert.ok(chunk.text.length <= 500);
});

test("chunkSentences on an empty list yields no chunks", () => {
  assert.deepEqual(chunkSentences([], []), []);
});

/* -------------------------------------------------- the real corpus, if present */

const COURSE_ROOT = config.course.path;

async function collectSrtFiles(dir, found = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSrtFiles(full, found);
    else if (entry.name.toLowerCase().endsWith(".srt")) found.push(full);
  }
  return found;
}

test("holds its invariants across the real corpus", async (t) => {
  const files = await collectSrtFiles(COURSE_ROOT);
  if (files.length === 0) {
    t.skip(`no subtitle files under ${COURSE_ROOT}`);
    return;
  }

  const { minChars, maxChars } = config.chunking;
  let totalChunks = 0;

  for (const file of files) {
    const cues = parseSubtitles(await fs.readFile(file, "utf8"));
    if (cues.length === 0) continue;

    const chunks = chunkCues(cues);
    totalChunks += chunks.length;
    assert.ok(chunks.length > 0, `${file} produced no chunks`);

    // No cue may be dropped: the union of chunk ranges must cover every cue.
    const covered = new Set();
    for (const chunk of chunks) {
      for (let i = chunk.cueStart; i <= chunk.cueEnd; i++) covered.add(i);
    }
    assert.equal(covered.size, cues.length, `${file} lost ${cues.length - covered.size} cue(s)`);

    let previousStart = -1;
    chunks.forEach((chunk, i) => {
      assert.ok(chunk.startMs <= chunk.endMs, `${file} chunk ${i}: startMs after endMs`);
      assert.ok(chunk.cueStart <= chunk.cueEnd, `${file} chunk ${i}: cueStart after cueEnd`);
      assert.ok(chunk.cueStart >= previousStart, `${file} chunk ${i}: cueStart went backwards`);
      previousStart = chunk.cueStart;

      assert.ok(chunk.text.length <= maxChars, `${file} chunk ${i}: ${chunk.text.length} > max`);

      const isLast = i === chunks.length - 1;
      if (!isLast) {
        assert.ok(chunk.text.length >= minChars, `${file} chunk ${i}: ${chunk.text.length} < min`);
        // Either it closed on punctuation, or there was none to close on.
        const endsOnTerminator = /[.!?]["'”’)\]]?$/.test(chunk.text.trim());
        assert.ok(
          endsOnTerminator || chunk.endsOnForcedCut,
          `${file} chunk ${i} ends mid-sentence: ...${chunk.text.slice(-60)}`
        );
      }
    });
  }

  assert.ok(totalChunks > 0);
  t.diagnostic(`${files.length} lessons → ${totalChunks} chunks`);
});
