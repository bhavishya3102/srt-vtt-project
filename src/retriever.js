import { config } from "./config.js";
import { qdrant, courseFilter, isMissingCollection } from "./qdrant.js";
import { chatJSON, chatText, embedTexts } from "./openai.js";
import { cuesToSentences } from "./chunker.js";
import { getCues } from "./transcript.js";

/**
 * The content pipeline: expand the question into a few complementary queries,
 * search with each, fuse the rankings, then answer strictly from what came back.
 *
 * Each citation resolves to a module, a lesson and a single timestamp — precise
 * enough to click straight to the moment the instructor said it.
 */

/* ------------------------------------------------------- query expansion --- */

const REWRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rewritten: {
      type: "string",
      description:
        "The question with typos and grammar fixed, made explicit and self-contained. Keep the original intent, and write it in English since the transcripts are English.",
    },
    stepBack: {
      type: "string",
      description:
        "One broader background question whose answer gives useful context for the original.",
    },
    isCompound: {
      type: "boolean",
      description:
        "True only when the question genuinely asks about two or more separate topics that would live in different parts of a course. Several clauses about one topic is NOT compound.",
    },
    subQuery: {
      type: "string",
      description:
        "When isCompound is true, one focused question targeting the intent the original wording covers LEAST well. Empty string when isCompound is false.",
    },
  },
  required: ["rewritten", "stepBack", "isCompound", "subQuery"],
};

const REWRITE_SYSTEM = `You prepare a student's question for search over the transcripts of a mobile app development course (Expo / React Native).

Produce:
1. rewritten — the question cleaned up, explicit and self-contained. The
   transcripts are spoken English, so write this in English even when the
   question arrives in Hindi or Hinglish.
2. stepBack — one broader question that supplies background context.
3. isCompound / subQuery — decide whether the question really asks about more
   than one thing. Most student doubts ask about exactly one thing; say false
   then, and leave subQuery empty. Only when there are genuinely separate topics
   (for example "how do dynamic routes work and how do I add auth") set true,
   and write ONE sub-question aimed at whichever intent the original phrasing
   represents most weakly — the other is already covered by rewritten.

Do not decompose for its own sake. An unnecessary sub-query adds a redundant
ranking to the fusion step and makes the results worse, not better.`;

/**
 * Rewrite the query into complementary variants.
 *
 * Decomposition is conditional. Always emitting sub-queries meant most questions
 * were searched three times for the same thing, crowding the fusion with
 * near-duplicate rankings. Now a single-intent question yields two variants plus
 * HyDE, and only a genuinely compound one adds a third.
 *
 * @param {string} query
 */
export async function queryRewriting(query) {
  const parsed = await chatJSON({
    name: "query_rewriting",
    schema: REWRITE_SCHEMA,
    system: REWRITE_SYSTEM,
    user: query,
    temperature: 0.2,
  });

  return normaliseRewrite(parsed, query);
}

/**
 * Coerce a rewrite response into the shape the pipeline expects.
 * Separate from the network call so the variant rules can be tested against
 * fixtures without an API key.
 */
export function normaliseRewrite(parsed, query) {
  const isCompound = parsed?.isCompound === true;
  const subQuery = typeof parsed?.subQuery === "string" ? parsed.subQuery.trim() : "";

  return {
    rewritten: parsed?.rewritten?.trim() || query,
    stepBack: parsed?.stepBack?.trim() || "",
    isCompound,
    // Guard against the model filling this in while reporting false.
    subQueries: isCompound && subQuery !== "" ? [subQuery] : [],
  };
}

/**
 * HyDE (Hypothetical Document Embeddings): write the passage we hope exists,
 * then search with *its* embedding rather than the question's.
 *
 * The register of that passage matters more than its accuracy. This corpus is
 * spoken lecture transcript, so a neutral encyclopedic paragraph embeds a long
 * way from anything we hold — which is why HyDE was close to useless here
 * before. Asking for instructor speech puts the vector in the same neighbourhood
 * as the real chunks.
 *
 * @param {string} query
 */
export async function hydeDocument(query) {
  return chatText({
    system:
      "You write short passages imitating the transcript of a screen-recorded coding tutorial. " +
      "Given a student's question, write 3-5 sentences of what the instructor most likely SAID " +
      "while teaching that topic, as it would appear in an auto-generated subtitle file: first " +
      "person, conversational, present tense, naming the real APIs and files involved. " +
      'Use the spoken register — "so", "let\'s", "right now", "you can see here" — and plain ' +
      "sentences with no headings, bullets or code blocks. Write in English whatever language " +
      "the question is in. Never mention that this is hypothetical.",
    user: query,
    temperature: 0.4,
  });
}

/* ----------------------------------------------------------------- search --- */

/** Search Qdrant for the chunks nearest one embedding, optionally course-scoped. */
async function searchByVector(vector, filter) {
  try {
    return await qdrant.search(config.qdrant.collection, {
      vector,
      limit: config.retrieval.topK,
      with_payload: true,
      ...(filter ? { filter } : {}),
    });
  } catch (err) {
    // "Nothing indexed yet" is a normal state, not a failure.
    if (isMissingCollection(err)) return [];
    throw err;
  }
}

/**
 * Reciprocal Rank Fusion: merge several ranked lists into one.
 *
 * A chunk's fused score is the sum, over every list it appears in, of
 * 1 / (k + rank) with rank 1-based. Chunks found by more than one variant rise
 * to the top, which is the signal we want: agreement between differently phrased
 * searches.
 *
 * @param {Array<{label: string, hits: Array}>} rankedLists
 */
export function reciprocalRankFusion(rankedLists) {
  const k = config.retrieval.rrfK;
  const fused = new Map();

  for (const { label, hits } of rankedLists) {
    hits.forEach((hit, i) => {
      const contribution = 1 / (k + i + 1);
      const existing = fused.get(hit.id);

      if (existing) {
        existing.rrfScore += contribution;
        existing.bestScore = Math.max(existing.bestScore, hit.score ?? 0);
        existing.matchedBy.push(label);
      } else {
        fused.set(hit.id, {
          id: hit.id,
          rrfScore: contribution,
          bestScore: hit.score ?? 0,
          matchedBy: [label],
          payload: hit.payload ?? {},
        });
      }
    });
  }

  return [...fused.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}

/**
 * Expand, search and fuse.
 *
 * @param {string} query
 * @param {{ courseId?: string }} [options]
 */
export async function retrieveChunks(query, { courseId } = {}) {
  const [{ rewritten, stepBack, isCompound, subQueries }, hyde] = await Promise.all([
    queryRewriting(query),
    hydeDocument(query),
  ]);

  const labelled = [
    { label: "rewritten", text: rewritten },
    { label: "stepBack", text: stepBack },
    { label: "hyde", text: hyde },
    ...subQueries.map((text, i) => ({ label: `subQuery${i + 1}`, text })),
  ].filter((v) => typeof v.text === "string" && v.text.trim() !== "");

  const vectors = await embedTexts(labelled.map((v) => v.text));
  const filter = courseFilter(courseId);
  const results = await Promise.all(vectors.map((v) => searchByVector(v, filter)));

  const fused = reciprocalRankFusion(
    labelled.map((v, i) => ({ label: v.label, hits: results[i] }))
  );

  return {
    queries: {
      original: query,
      rewritten,
      stepBack,
      hyde,
      subQueries,
      isCompound,
      variantCount: labelled.length,
    },
    chunks: fused.slice(0, config.retrieval.finalK),
  };
}

/* -------------------------------------------------------------- pinpoint --- */

const tokenize = (text) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Fraction of the quote's tokens that appear in a candidate sentence. */
function overlapScore(quoteTokens, sentence) {
  if (quoteTokens.length === 0) return 0;
  const present = new Set(tokenize(sentence));
  let hits = 0;
  for (const token of quoteTokens) if (present.has(token)) hits++;
  return hits / quoteTokens.length;
}

/** Minimum overlap before a pinpoint is trusted over the chunk's own start. */
const PINPOINT_THRESHOLD = 0.45;

/**
 * Narrow a citation from the chunk's ~60-second span down to the single sentence
 * the model quoted, and return the moment that sentence begins.
 *
 * Deterministic and free — no extra model call. Sentences come from the same
 * splitter the chunker used, so a quote lifted out of a chunk lines up with one.
 * Falls back to the chunk's start when the quote can't be located, which is
 * still correct, just coarser.
 *
 * @param {string} quote
 * @param {Array} cues full cue list for the lesson
 * @param {{cueStart: number, cueEnd: number, startMs: number}} chunk
 */
export function pinpointSentence(quote, cues, chunk) {
  const fallback = { startMs: chunk.startMs, cueIndex: chunk.cueStart, text: "", exact: false };
  if (typeof quote !== "string" || quote.trim() === "" || !Array.isArray(cues)) return fallback;

  const window = cues.slice(chunk.cueStart, chunk.cueEnd + 1);
  if (window.length === 0) return fallback;

  const sentences = cuesToSentences(window);
  if (sentences.length === 0) return fallback;

  const quoteTokens = tokenize(quote);
  let best = null;
  let bestScore = 0;

  for (const sentence of sentences) {
    const score = overlapScore(quoteTokens, sentence.text);
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }

  if (!best || bestScore < PINPOINT_THRESHOLD) return fallback;

  // Sentence cue indices are relative to the sliced window.
  const cueIndex = chunk.cueStart + best.cueStart;
  return {
    startMs: cues[cueIndex]?.startMs ?? best.startMs,
    cueIndex,
    text: best.text,
    exact: bestScore >= 0.9,
  };
}

/* ---------------------------------------------------------------- answer --- */

const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: {
      type: "string",
      description:
        "The answer in markdown. Mirror the question's language exactly: a Hinglish question gets a Hinglish answer, English gets English.",
    },
    covered: {
      type: "boolean",
      description:
        "False when the excerpts don't actually contain the answer. Say so in the answer too.",
    },
    citations: {
      type: "array",
      description:
        "The excerpts the answer relies on, most important first. Empty when covered is false.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          excerpt: { type: "integer", description: "The [n] number of the excerpt used." },
          quote: {
            type: "string",
            description:
              "One sentence copied VERBATIM from that excerpt — the exact words supporting the answer. Never paraphrase; this is matched back against the transcript to find the timestamp.",
          },
        },
        required: ["excerpt", "quote"],
      },
    },
  },
  required: ["answer", "covered", "citations"],
};

const ANSWER_SYSTEM = `You answer a student's question using ONLY the numbered transcript excerpts provided. They are auto-generated subtitles from a mobile app development course (Expo / React Native).

Rules:

- Ground everything in the excerpts. If they don't contain the answer, set
  covered to false and say plainly that this isn't covered in the course
  material you can see. Never fill the gap from outside knowledge.

- The excerpts are machine transcriptions of speech, so expect mangled words and
  missing punctuation ("some while development" is "so, mobile development";
  "dot tsx" is ".tsx"). Read them charitably and answer the intended meaning.

- Mirror the student's language. A Hinglish question gets a Hinglish answer
  (romanised Hindi with English technical terms); an English question gets
  English. Never reply in a different language than you were asked in.

- Be direct and practical. Lead with the answer, then the detail. Short markdown
  — a few sentences, a list only if there are real steps. Don't pad.

- For every claim, cite the excerpt it came from and quote one sentence VERBATIM
  from it. Those quotes are matched back against the transcript to locate the
  exact second the instructor said it, so an invented or paraphrased quote breaks
  the link the student clicks on.`;

/**
 * Full content pipeline for one question.
 *
 * @param {string} query PII-masked question
 * @param {{ courseId?: string }} [options]
 */
export async function answerQuery(query, { courseId } = {}) {
  const { queries, chunks } = await retrieveChunks(query, { courseId });

  if (chunks.length === 0) {
    return {
      query,
      queries,
      answer:
        "I couldn't find anything about that in the indexed transcripts. " +
        "If the course hasn't been indexed yet, run `npm run ingest` first.",
      covered: false,
      citations: [],
      chunks: [],
    };
  }

  const context = chunks
    .map((chunk, i) => {
      const p = chunk.payload;
      return `[${i + 1}] ${p.moduleTitle} — ${p.lessonTitle}\n${p.text}`;
    })
    .join("\n\n");

  const result = await chatJSON({
    name: "grounded_answer",
    schema: ANSWER_SCHEMA,
    system: ANSWER_SYSTEM,
    user: `TRANSCRIPT EXCERPTS:\n${context}\n\nQUESTION: ${query}`,
    temperature: 0.2,
  });

  return {
    query,
    queries,
    answer: result.answer?.trim() ?? "",
    covered: result.covered !== false,
    citations: await buildCitations(result.citations, chunks),
    // Everything retrieved, for the trace panel.
    chunks: chunks.map((c, i) => ({
      n: i + 1,
      lessonId: c.payload.lessonId,
      moduleTitle: c.payload.moduleTitle,
      lessonTitle: c.payload.lessonTitle,
      startMs: c.payload.startMs,
      endMs: c.payload.endMs,
      score: c.bestScore,
      rrfScore: c.rrfScore,
      matchedBy: c.matchedBy,
    })),
  };
}

/**
 * Turn the model's `{excerpt, quote}` references into clickable citations,
 * resolving each quote down to a single timestamp.
 *
 * References to excerpts that were never offered are dropped — a citation
 * pointing somewhere the answer didn't come from is worse than one fewer.
 */
async function buildCitations(raw, chunks) {
  if (!Array.isArray(raw)) return [];

  const citations = [];
  const seen = new Set();

  for (const item of raw) {
    const chunk = chunks[Number(item?.excerpt) - 1];
    if (!chunk) continue;

    const p = chunk.payload;
    const key = `${p.lessonId}#${p.chunkIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // A cached disk read, not a network call.
    const cues = await getCues(p.lessonId).catch(() => null);
    const pin = pinpointSentence(item.quote, cues, {
      cueStart: p.cueStart,
      cueEnd: p.cueEnd,
      startMs: p.startMs,
    });

    citations.push({
      n: citations.length + 1,
      lessonId: p.lessonId,
      courseId: p.courseId,
      moduleTitle: p.moduleTitle,
      lessonTitle: p.lessonTitle,
      kind: p.kind,

      // the chunk's span — washes the cited range in the transcript pane
      startMs: p.startMs,
      endMs: p.endMs,
      cueStart: p.cueStart,
      cueEnd: p.cueEnd,

      // the one line the answer leans on
      pinpointMs: pin.startMs,
      cueIndex: pin.cueIndex,
      quote: pin.text || item.quote,
      exactQuote: pin.exact,

      score: chunk.bestScore,
      rrfScore: chunk.rrfScore,
      matchedBy: chunk.matchedBy,
    });
  }

  return citations;
}
