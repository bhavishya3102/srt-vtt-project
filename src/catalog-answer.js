import { chatJSON } from "./openai.js";
import { getCourses, renderSyllabus } from "./catalog.js";

/**
 * Answers questions about the shape of the course rather than its content:
 * "how many lessons in module 5", "which module covers navigation", "which is
 * the longest lecture".
 *
 * These used to go through vector search, where they were both slow and wrong —
 * the transcripts don't contain the syllabus, so retrieval had nothing useful to
 * find. Here the whole syllabus goes into the prompt instead. It is about 1200
 * tokens for this course, which is far cheaper than building a query language
 * and covers every phrasing without enumerating question types.
 */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: {
      type: "string",
      description:
        "The answer in markdown. Mirror the language the question was asked in: Hinglish question gets a Hinglish answer, English gets English.",
    },
    lessonTitles: {
      type: "array",
      description:
        "Exact titles, copied character-for-character from the syllabus, of the lessons this answer refers to. Empty when the answer names no specific lesson.",
      items: { type: "string" },
    },
  },
  required: ["answer", "lessonTitles"],
};

const SYSTEM = `You answer questions about the structure of a course, using ONLY the syllabus provided below. The syllabus lists every module, every lesson, and each lesson's length.

Rules:
- Answer only from the syllabus. If it doesn't contain the answer, say so plainly.
- Be concrete: give counts, module names and lesson titles rather than vague summaries.
- Keep it short. A count question deserves a one-line answer.
- When you name specific lessons, copy their titles EXACTLY as written in the
  syllabus into lessonTitles, so they can be turned into links.
- Mirror the user's language. A Hinglish question gets a Hinglish answer
  (romanised Hindi mixed with English technical terms), an English question gets
  English. Never switch languages on the user.
- A lesson marked [mini-project] is a hands-on build, not a regular chapter.
  Mention that distinction when it matters to the question.`;

/**
 * Answer a catalog/structure question.
 *
 * @param {string} query PII-masked question
 * @param {string} [courseId] limit to one course; omit for all of them
 * @param {{ indexedLessonIds?: Set<string> }} [context] indexing status, so
 *        "how many lessons are indexed?" can be answered truthfully
 * @returns {Promise<{ answer: string, citations: Array }>}
 */
export async function answerFromCatalog(query, courseId, context = {}) {
  const syllabus = await renderSyllabus(courseId);
  const { lessons } = await getCourses();

  const scoped = courseId ? lessons.filter((l) => l.courseId === courseId) : lessons;

  let indexingNote = "";
  if (context.indexedLessonIds) {
    const indexed = scoped.filter((l) => context.indexedLessonIds.has(l.id)).length;
    indexingNote =
      `\n\nINDEXING STATUS: ${indexed} of ${scoped.length} lessons have been indexed for ` +
      `content search.${indexed === 0 ? " No content questions can be answered yet." : ""}`;
  }

  const result = await chatJSON({
    name: "catalog_answer",
    schema: SCHEMA,
    system: SYSTEM,
    user: `SYLLABUS:\n${syllabus}${indexingNote}\n\nQUESTION: ${query}`,
    temperature: 0.1,
  });

  return {
    answer: typeof result.answer === "string" ? result.answer.trim() : "",
    citations: resolveLessonTitles(result.lessonTitles, scoped),
  };
}

/**
 * Turn the titles the model echoed back into real lesson citations.
 *
 * Matching is exact-then-loose: the prompt asks for verbatim titles, but a model
 * that reformats one shouldn't cost the user their link. Unmatched titles are
 * dropped rather than guessed at — a citation that jumps to the wrong lesson is
 * worse than no citation.
 */
function resolveLessonTitles(titles, lessons) {
  if (!Array.isArray(titles) || titles.length === 0) return [];

  const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const byExact = new Map(lessons.map((l) => [l.title, l]));
  const byLoose = new Map(lessons.map((l) => [normalise(l.title), l]));

  const seen = new Set();
  const citations = [];

  for (const title of titles) {
    if (typeof title !== "string") continue;
    const lesson = byExact.get(title.trim()) ?? byLoose.get(normalise(title));
    if (!lesson || seen.has(lesson.id)) continue;
    seen.add(lesson.id);

    citations.push({
      n: citations.length + 1,
      lessonId: lesson.id,
      courseId: lesson.courseId,
      moduleTitle: lesson.moduleTitle,
      lessonTitle: lesson.title,
      kind: lesson.kind,
      durationMs: lesson.durationMs,
      // Catalog citations have no quoted passage, so they open the lesson at
      // the start rather than at a timestamp.
      startMs: 0,
      pinpointMs: 0,
    });
  }

  return citations;
}
