import { config } from "./config.js";
import { qdrant, isMissingCollection } from "./qdrant.js";
import { getCourses } from "./catalog.js";

/**
 * Reports what has actually been indexed, by aggregating the points in Qdrant.
 *
 * The catalog knows every lesson that exists on disk; this tells us which of
 * them are searchable. The UI needs both to say something honest like
 * "12 of 87 lessons indexed — run npm run ingest".
 */

const SCROLL_PAGE = 1024;
// Safety valve so a large collection can't pin the event loop on one request.
const MAX_PAGES = 200;

/**
 * Per-lesson chunk counts from the vector store.
 * Returns an empty Map when nothing has been indexed yet.
 *
 * @returns {Promise<Map<string, { chunks: number, indexedAt: string|null }>>}
 */
export async function getIndexedLessons() {
  const byLesson = new Map();
  let offset;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await qdrant.scroll(config.qdrant.collection, {
        limit: SCROLL_PAGE,
        offset,
        with_payload: ["lessonId", "indexedAt"],
        with_vector: false,
      });

      for (const { payload } of res.points) {
        const id = payload?.lessonId;
        if (!id) continue;

        const existing = byLesson.get(id);
        if (existing) {
          existing.chunks += 1;
        } else {
          byLesson.set(id, { chunks: 1, indexedAt: payload.indexedAt ?? null });
        }
      }

      offset = res.next_page_offset;
      if (!offset) break;
    }
  } catch (err) {
    if (isMissingCollection(err)) return byLesson;
    throw err;
  }

  return byLesson;
}

/** Just the ids, for the catalog answerer's "how many are indexed?" question. */
export async function getIndexedLessonIds() {
  return new Set((await getIndexedLessons()).keys());
}

/**
 * Indexing status for one course, or all of them.
 *
 * @param {string} [courseId]
 */
export async function getStatus(courseId) {
  const [{ courses, lessons }, indexed] = await Promise.all([
    getCourses(),
    getIndexedLessons().catch((err) => {
      // A stopped Qdrant shouldn't take the whole status endpoint down — the
      // catalog half of the answer is still useful and still true.
      if (err?.cause?.code === "ECONNREFUSED" || /fetch failed/i.test(err?.message ?? "")) {
        return null;
      }
      throw err;
    }),
  ]);

  const scoped = courseId ? lessons.filter((l) => l.courseId === courseId) : lessons;

  if (indexed === null) {
    return {
      reachable: false,
      totalCourses: courses.length,
      totalLessons: scoped.length,
      indexedLessons: 0,
      totalChunks: 0,
      pending: scoped.length,
      message: `Can't reach Qdrant at ${config.qdrant.url}. Start it with: npm run services:up`,
    };
  }

  const indexedHere = scoped.filter((l) => indexed.has(l.id));
  const totalChunks = indexedHere.reduce((sum, l) => sum + indexed.get(l.id).chunks, 0);

  return {
    reachable: true,
    totalCourses: courses.length,
    totalLessons: scoped.length,
    indexedLessons: indexedHere.length,
    totalChunks,
    pending: scoped.length - indexedHere.length,
    lastIndexedAt:
      indexedHere
        .map((l) => indexed.get(l.id).indexedAt)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
  };
}

/**
 * Which lessons in a course are indexed, keyed by lesson id — used to draw the
 * "indexed" dots in the module rail.
 *
 * @param {string} [courseId]
 */
export async function getLessonIndexMap(courseId) {
  const indexed = await getIndexedLessons().catch(() => new Map());
  const { lessons } = await getCourses();

  const map = {};
  for (const lesson of lessons) {
    if (courseId && lesson.courseId !== courseId) continue;
    map[lesson.id] = indexed.get(lesson.id)?.chunks ?? 0;
  }
  return map;
}
