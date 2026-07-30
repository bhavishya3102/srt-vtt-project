import { maskPII, countMasked, describeMasked } from "./guardrails.js";
import { classifyQuery } from "./router.js";
import { answerQuery } from "./retriever.js";
import { answerFromCatalog } from "./catalog-answer.js";
import { getIndexedLessonIds } from "./status.js";

/**
 * One entry point for every question, so the ordering of guardrails and routing
 * lives in a single readable place rather than being spread across the worker.
 *
 *   query
 *     |- maskPII()        regex, no model call
 *     |- classifyQuery()  one model call: in-scope gate AND intent
 *     |
 *     |- blocked   -> polite refusal, nothing else runs
 *     |- metadata  -> answered from the syllabus, no vector search
 *     `- content   -> full retrieval pipeline
 *
 * Combining the gate with the router is what makes the gate free: the same call
 * that filters out off-topic questions also steers catalog questions away from
 * vector search, where they were both slower and wrong.
 */

/**
 * Answer one question.
 *
 * @param {string} rawQuery straight from the client
 * @param {{ courseId?: string }} [options]
 * @returns {Promise<object>} the shape the UI renders
 */
export async function handleQuery(rawQuery, { courseId } = {}) {
  // 1. Redact secrets before anything leaves the process.
  const { text: query, found } = maskPII(rawQuery);
  const masked =
    countMasked(found) > 0
      ? { count: countMasked(found), summary: describeMasked(found) }
      : null;

  // 2. Gate and route in one call.
  const { allowed, reason, intent } = await classifyQuery(query);

  if (!allowed) {
    return {
      kind: "blocked",
      query,
      masked,
      answer: reason,
      citations: [],
    };
  }

  // 3a. Questions about the course's shape never touch the vector store.
  if (intent === "metadata") {
    const indexedLessonIds = await getIndexedLessonIds().catch(() => null);
    const { answer, citations } = await answerFromCatalog(query, courseId, {
      ...(indexedLessonIds ? { indexedLessonIds } : {}),
    });

    return {
      kind: "metadata",
      query,
      masked,
      courseId: courseId ?? null,
      answer,
      citations,
      covered: citations.length > 0 || answer !== "",
    };
  }

  // 3b. Everything else goes through retrieval.
  const result = await answerQuery(query, { courseId });

  return {
    kind: "content",
    masked,
    courseId: courseId ?? null,
    ...result,
  };
}
