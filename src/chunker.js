import { config } from "./config.js";

/**
 * Turns a lesson's subtitle cues into embeddable chunks in three stages:
 *
 *   1. cues -> sentences   (sentence-aware)  never cut mid-sentence
 *   2. sentences -> blocks (structure-aware) prefer breaking on real pauses
 *   3. blocks -> chunks    (target-size)     greedy pack toward a target
 *
 * Every chunk keeps `startMs`, `endMs`, `cueStart` and `cueEnd`. That is the
 * whole point: a citation can only be clickable if the text that produced it
 * still knows when it was spoken.
 *
 * The thresholds are measured against this corpus (19,203 cues), not guessed:
 *   - 75% of cues end on sentence punctuation, so sentence splitting is viable
 *   - average cue is 52 chars, so a 1200-char chunk is ~23 cues (~60-70s)
 *   - a >=1500ms pause occurs every ~871 chars, just under the chunk target,
 *     so most chunks can close on a genuine pause rather than a hard cut
 *
 * Everything here is pure — no I/O — so the invariants are cheap to test.
 */

/**
 * Words that end in a period without ending a sentence. Only consulted when
 * the following character is upper-case, which is the one case the
 * "followed by whitespace + capital" heuristic gets wrong on its own
 * ("etc. We saw..." vs "the end. We saw...").
 */
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "vs", "cf", "al", "approx", "est", "fig", "no", "vol",
  "dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st",
  "inc", "ltd", "co", "dept", "min", "max", "sec", "hr", "hrs", "sq",
]);

/**
 * Sentence openers that signal the instructor moving to a new point. These are
 * only ever a tie-breaker near the size target — in speech they are far too
 * common to treat as hard boundaries.
 */
const DISCOURSE_MARKERS = new Set([
  "so", "now", "next", "alright", "okay", "ok", "perfect", "right",
  "finally", "lastly", "anyway", "however", "but", "and", "then",
]);

/** Characters that may sit between the terminator and the following space. */
const TRAILING_CLOSERS = new Set(['"', "'", "”", "’", ")", "]", "»"]);

/** Characters that may open the next sentence before its first letter. */
const LEADING_OPENERS = new Set(['"', "'", "“", "‘", "(", "[", "«"]);

/* ------------------------------------------------------------------ stage 1 */

/**
 * Join the cues into one string while remembering which cue each character
 * came from. Sentences are found in the joined text, then mapped back.
 */
function buildSpans(cues) {
  const spans = [];
  let text = "";

  for (let i = 0; i < cues.length; i++) {
    if (text !== "") text += " ";
    const start = text.length;
    text += cues[i].text;
    spans.push({ cue: i, start, end: text.length });
  }

  return { text, spans };
}

/** Index of the span containing `offset`; the next span if it lands in a gap. */
function spanAt(spans, offset) {
  let lo = 0;
  let hi = spans.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offset < spans[mid].start) hi = mid - 1;
    else if (offset >= spans[mid].end) lo = mid + 1;
    else return mid;
  }

  // Landed on the separator space between two cues — attribute it forward,
  // clamped so the last cue's trailing edge stays in range.
  return Math.min(lo, spans.length - 1);
}

/**
 * Is the terminator at `i` a real sentence end?
 *
 * Deliberately strict. A missed boundary just yields a longer sentence, which
 * the size cap handles; a false boundary splits mid-sentence, which is exactly
 * what this module exists to prevent. Notably `app.json`, `React.js`, `3.5`
 * and `v2.0` are all rejected by the "must be followed by whitespace" rule.
 */
function isSentenceEnd(text, i) {
  const ch = text[i];
  if (ch !== "." && ch !== "!" && ch !== "?") return false;

  // Skip repeated terminators ("...", "?!") and any closing quote/bracket.
  let j = i;
  while (j + 1 < text.length && (text[j + 1] === "." || text[j + 1] === "!" || text[j + 1] === "?")) j++;
  while (j + 1 < text.length && TRAILING_CLOSERS.has(text[j + 1])) j++;

  // End of input is a boundary.
  if (j + 1 >= text.length) return true;

  // Must be followed by whitespace.
  if (!/\s/.test(text[j + 1])) return false;

  // Find the first meaningful character of what follows.
  let k = j + 1;
  while (k < text.length && (/\s/.test(text[k]) || LEADING_OPENERS.has(text[k]))) k++;
  if (k >= text.length) return true;

  const next = text[k];
  // Spoken transcripts are inconsistently capitalised; requiring a capital or
  // digit keeps us from splitting on "...built with expo. and then we..."
  if (!(next >= "A" && next <= "Z") && !(next >= "0" && next <= "9")) return false;

  // "etc. We" / "e.g. You" — look back at the token before the period.
  if (ch === ".") {
    let s = i;
    while (s > 0 && /[A-Za-z.]/.test(text[s - 1])) s--;
    const word = text.slice(s, i).toLowerCase().replace(/\.+$/, "");
    if (ABBREVIATIONS.has(word)) return false;
    // A lone initial ("J. Doe") is not a sentence end.
    if (word.length === 1) return false;
  }

  return true;
}

/**
 * Where to break a stretch of speech that carries no punctuation at all.
 *
 * Candidates are cue starts inside the current run; we take the one with the
 * longest silence in front of it, restricted to the back half of the run so the
 * cut still makes real progress. That puts the break where the speaker drew
 * breath rather than at an arbitrary character count.
 */
function bestForcedCut(spans, gapBefore, runStart, at, maxChars) {
  const earliest = runStart + Math.floor(maxChars * 0.5);
  let best = -1;
  let bestGap = -1;
  let nearest = -1;

  for (let s = spanAt(spans, runStart); s < spans.length; s++) {
    const { start, cue } = spans[s];
    if (start <= runStart) continue;
    if (start > at) break;

    nearest = start;
    if (start < earliest) continue;

    if (gapBefore[cue] > bestGap) {
      bestGap = gapBefore[cue];
      best = start;
    }
  }

  if (best > runStart) return best;
  if (nearest > runStart) return nearest;
  return at + 1; // one enormous cue with no internal boundary — hard cut
}

/**
 * Split cues into sentences, each carrying the cue range it spans.
 *
 * A sentence flagged `forcedCut` did not end on punctuation — it was closed by
 * the size cap because the speaker went that long without a terminator.
 * Downstream code uses the flag to tell "no sentence boundary existed" apart
 * from "we ignored one".
 *
 * @param {Array<{index:number,startMs:number,endMs:number,text:string}>} cues
 * @param {{ maxSentenceChars?: number }} [options]
 * @returns {Array<{text,startMs,endMs,cueStart,cueEnd,startsCue,isDiscourseStart,forcedCut}>}
 */
export function cuesToSentences(cues, options = {}) {
  if (!Array.isArray(cues) || cues.length === 0) return [];

  const maxChars = options.maxSentenceChars ?? config.chunking.maxSentenceChars;
  const { text, spans } = buildSpans(cues);
  const gapBefore = cues.map((c, i) => (i === 0 ? 0 : c.startMs - cues[i - 1].endMs));

  // Cut points: real sentence ends, plus forced cuts for runs of speech that
  // never get punctuated (25% of cues don't end on a terminator).
  const cuts = [];
  let sinceCut = 0;

  for (let i = 0; i < text.length; i++) {
    sinceCut++;

    if (isSentenceEnd(text, i)) {
      let j = i;
      while (j + 1 < text.length && (text[j + 1] === "." || text[j + 1] === "!" || text[j + 1] === "?")) j++;
      while (j + 1 < text.length && TRAILING_CLOSERS.has(text[j + 1])) j++;
      cuts.push({ at: j + 1, forced: false });
      sinceCut = 0;
      i = j;
      continue;
    }

    if (sinceCut >= maxChars) {
      const runStart = cuts.at(-1)?.at ?? 0;
      const at = bestForcedCut(spans, gapBefore, runStart, i, maxChars);
      cuts.push({ at, forced: true });
      sinceCut = 0;
      i = at - 1;
    }
  }

  const lastCut = cuts.at(-1)?.at ?? 0;
  if (lastCut < text.length) cuts.push({ at: text.length, forced: false });

  const sentences = [];
  let from = 0;

  for (const { at: to, forced } of cuts) {
    const raw = text.slice(from, to);
    const trimmedStart = from + (raw.length - raw.trimStart().length);
    const body = raw.trim();

    if (body !== "") {
      const startIdx = spanAt(spans, trimmedStart);
      const endIdx = spanAt(spans, trimmedStart + body.length - 1);
      const first = cues[startIdx];
      const last = cues[endIdx];
      const firstWord = body.replace(/^[^A-Za-z]+/, "").split(/[\s,.!?]/, 1)[0].toLowerCase();

      sentences.push({
        text: body,
        startMs: first.startMs,
        endMs: last.endMs,
        cueStart: startIdx,
        cueEnd: endIdx,
        // Only a sentence that begins a cue can be preceded by a real pause.
        startsCue: trimmedStart === spans[startIdx].start,
        isDiscourseStart: DISCOURSE_MARKERS.has(firstWord),
        forcedCut: forced,
      });
    }

    from = to;
  }

  return sentences;
}

/* ------------------------------------------------------------- stages 2 & 3 */

/**
 * True when the speaker paused long enough before this sentence to treat it as
 * the start of a new block. Requires the sentence to begin a cue — a sentence
 * starting mid-cue has no pause in front of it.
 */
function startsNewBlock(sentence, cues, strongPauseMs) {
  if (!sentence.startsCue || sentence.cueStart === 0) return false;
  const gap = cues[sentence.cueStart].startMs - cues[sentence.cueStart - 1].endMs;
  return gap >= strongPauseMs;
}

/** Assemble a chunk record from the sentences packed into it. */
function makeChunk(sentences) {
  return {
    text: sentences.map((s) => s.text).join(" "),
    startMs: sentences[0].startMs,
    endMs: sentences.at(-1).endMs,
    cueStart: sentences[0].cueStart,
    cueEnd: sentences.at(-1).cueEnd,
    sentences: sentences.length,
    // True when the chunk's last sentence had no punctuation to end on, so it
    // closed at a pause instead. Kept for tests and diagnostics.
    endsOnForcedCut: sentences.at(-1).forcedCut === true,
  };
}

/**
 * Trailing sentences to repeat at the head of the next chunk, so an answer
 * straddling a boundary is still retrievable from one chunk. Whole sentences
 * only — a mid-word overlap would be worse than none.
 */
function overlapTail(sentences, overlapChars) {
  if (overlapChars <= 0 || sentences.length < 2) return [];

  const tail = [];
  let chars = 0;

  // Always leave at least one sentence behind, or a chunk could repeat whole.
  for (let i = sentences.length - 1; i >= 1; i--) {
    const next = chars + sentences[i].text.length;
    if (tail.length > 0 && next > overlapChars) break;
    tail.unshift(sentences[i]);
    chars = next;
    if (chars >= overlapChars) break;
  }

  return tail;
}

/**
 * Pack sentences into target-sized chunks, preferring to close on a pause.
 *
 * @param {ReturnType<typeof cuesToSentences>} sentences
 * @param {Array} cues the same cues the sentences came from
 * @param {object} [options] overrides for config.chunking
 */
export function chunkSentences(sentences, cues, options = {}) {
  if (sentences.length === 0) return [];

  const {
    targetChars = config.chunking.targetChars,
    minChars = config.chunking.minChars,
    maxChars = config.chunking.maxChars,
    overlapChars = config.chunking.overlapChars,
    strongPauseMs = config.chunking.strongPauseMs,
  } = options;

  // Pre-compute block starts once; stage 3 consults them as lookahead.
  const blockStart = sentences.map((s) => startsNewBlock(s, cues, strongPauseMs));

  const chunks = [];
  let current = [];
  let chars = 0;

  const close = () => {
    if (current.length === 0) return;
    chunks.push(makeChunk(current));
    const tail = overlapTail(current, overlapChars);
    current = [...tail];
    chars = tail.reduce((sum, s) => sum + s.text.length + 1, 0);
  };

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const length = sentence.text.length + 1; // +1 for the joining space

    // Hard ceiling: never let a chunk grow past maxChars.
    if (chars > 0 && chars + length > maxChars) close();

    current.push(sentence);
    chars += length;

    const isLast = i === sentences.length - 1;
    if (isLast) break;

    const nextIsPause = blockStart[i + 1];
    const nextIsMarker = sentences[i + 1].isDiscourseStart;

    if (chars >= targetChars) {
      close(); // at size — stop here regardless of what follows
    } else if (chars >= minChars && nextIsPause) {
      close(); // under target but the speaker paused: a better seam than size
    } else if (chars >= targetChars * 0.75 && nextIsMarker) {
      close(); // near target and the instructor is changing subject
    }
  }

  if (current.length > 0) chunks.push(makeChunk(current));

  return chunks;
}

/** cues -> chunks, running all three stages. */
export function chunkCues(cues, options = {}) {
  const sentences = cuesToSentences(cues, options);
  return chunkSentences(sentences, cues, options);
}
