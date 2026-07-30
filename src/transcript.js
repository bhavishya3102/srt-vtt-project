import { findLesson } from "./catalog.js";
import { readSubtitleFile } from "./subtitles.js";

/**
 * Reads full lesson transcripts for the viewer pane.
 *
 * This path deliberately touches neither Qdrant nor OpenAI — the transcript is
 * already on disk, so the pane works before anything has been indexed and
 * costs nothing to open.
 *
 * Parsed cues are cached because the files are read-only for the life of the
 * process and a lesson gets re-opened every time a citation points at it.
 * The cache is bounded: the whole corpus is only ~10 MB parsed, but an
 * unbounded map in a long-lived server is a leak waiting to happen.
 */

const MAX_CACHED_LESSONS = 24;

/** lessonId -> cues. Insertion order is the eviction order (oldest first). */
const cache = new Map();

function readCache(lessonId) {
  if (!cache.has(lessonId)) return null;
  // Refresh recency: delete and re-insert moves it to the end.
  const cues = cache.get(lessonId);
  cache.delete(lessonId);
  cache.set(lessonId, cues);
  return cues;
}

function writeCache(lessonId, cues) {
  cache.set(lessonId, cues);
  while (cache.size > MAX_CACHED_LESSONS) {
    cache.delete(cache.keys().next().value);
  }
}

/** Drop cached transcripts (used by tests). */
export function clearTranscriptCache() {
  cache.clear();
}

/**
 * Full transcript for one lesson, or null when the id is unknown.
 *
 * The id is resolved through the catalog's Map, so no client string ever
 * reaches the filesystem.
 *
 * @param {string} lessonId
 */
export async function getTranscript(lessonId) {
  const lesson = await findLesson(lessonId);
  if (!lesson) return null;

  let cues = readCache(lessonId);
  if (!cues) {
    cues = await readSubtitleFile(lesson.filePath);
    writeCache(lessonId, cues);
  }

  return {
    lesson: {
      id: lesson.id,
      courseId: lesson.courseId,
      title: lesson.title,
      moduleId: lesson.moduleId,
      moduleTitle: lesson.moduleTitle,
      order: lesson.lessonOrder,
      kind: lesson.kind,
      format: lesson.format,
      durationMs: cues.at(-1)?.endMs ?? null,
    },
    cues,
  };
}

/**
 * Cues for a lesson only — used by the retriever when it needs to pinpoint a
 * quote inside an already-retrieved chunk.
 *
 * @param {string} lessonId
 * @returns {Promise<Array|null>}
 */
export async function getCues(lessonId) {
  const cached = readCache(lessonId);
  if (cached) return cached;

  const lesson = await findLesson(lessonId);
  if (!lesson) return null;

  const cues = await readSubtitleFile(lesson.filePath);
  writeCache(lessonId, cues);
  return cues;
}
