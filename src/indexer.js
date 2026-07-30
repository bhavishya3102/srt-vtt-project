import fs from "node:fs/promises";
import crypto from "node:crypto";
import { findLesson } from "./catalog.js";
import { parseSubtitles } from "./subtitles.js";
import { chunkCues } from "./chunker.js";
import { embedTexts } from "./openai.js";
import { qdrant, ensureCollection, deleteLessonPoints, isMissingCollection } from "./qdrant.js";
import { config } from "./config.js";

/**
 * Indexes one lesson: read subtitles -> chunk -> embed -> upsert into Qdrant.
 *
 * Every point carries the module, the lesson and the exact millisecond range its
 * text was spoken in. That payload is what makes a citation clickable later —
 * without it the retriever could say *what* the answer is but never *where* in
 * the course to find it.
 */

/**
 * Thrown when a lesson can never be indexed however often we retry (missing
 * file, no parsable cues). The worker converts this into a BullMQ
 * UnrecoverableError so the job fails once instead of burning every attempt.
 */
export class UnprocessableLessonError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnprocessableLessonError";
  }
}

/**
 * Deterministic UUID for a chunk, so re-indexing overwrites in place instead of
 * accumulating duplicates. Qdrant requires point ids to be a UUID or an integer.
 */
function chunkId(lessonId, chunkIndex) {
  const hex = crypto.createHash("sha1").update(`${lessonId}#${chunkIndex}`).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * The contentHash already stored for this lesson, or null if it isn't indexed.
 * Lets a re-run skip lessons whose transcript hasn't changed, which is the
 * difference between re-embedding the whole course and paying nothing.
 */
async function storedHash(lessonId) {
  try {
    const res = await qdrant.scroll(config.qdrant.collection, {
      limit: 1,
      filter: { must: [{ key: "lessonId", match: { value: lessonId } }] },
      with_payload: ["contentHash"],
      with_vector: false,
    });
    return res.points[0]?.payload?.contentHash ?? null;
  } catch (err) {
    if (isMissingCollection(err)) return null;
    throw err;
  }
}

/**
 * Index a single lesson.
 *
 * @param {{ lessonId: string, force?: boolean }} input
 * @returns {Promise<{lessonId, title, chunks, cues, skipped, contentHash, indexedAt}>}
 */
export async function indexLesson({ lessonId, force = false }) {
  const lesson = await findLesson(lessonId);
  if (!lesson) throw new UnprocessableLessonError(`Unknown lesson id: ${lessonId}`);

  let raw;
  try {
    raw = await fs.readFile(lesson.filePath, "utf8");
  } catch (err) {
    throw new UnprocessableLessonError(
      `Can't read subtitles for "${lesson.title}": ${err.message}`
    );
  }

  const contentHash = crypto.createHash("sha256").update(raw).digest("hex");

  if (!force && (await storedHash(lessonId)) === contentHash) {
    return {
      lessonId,
      title: lesson.title,
      chunks: 0,
      cues: 0,
      skipped: true,
      contentHash,
      indexedAt: null,
    };
  }

  const cues = parseSubtitles(raw);
  if (cues.length === 0) {
    throw new UnprocessableLessonError(
      `No subtitle cues found in "${lesson.title}" — the file may be empty or malformed`
    );
  }

  const chunks = chunkCues(cues);
  if (chunks.length === 0) {
    throw new UnprocessableLessonError(`"${lesson.title}" produced no chunks`);
  }

  const collection = await ensureCollection();
  const vectors = await embedTexts(chunks.map((c) => c.text));
  const indexedAt = new Date().toISOString();

  const points = chunks.map((chunk, i) => ({
    id: chunkId(lessonId, i),
    vector: vectors[i],
    payload: {
      text: chunk.text,

      // where in the course this came from
      courseId: lesson.courseId,
      lessonId: lesson.id,
      moduleId: lesson.moduleId,
      moduleTitle: lesson.moduleTitle,
      lessonTitle: lesson.title,
      lessonOrder: lesson.lessonOrder,
      moduleOrder: lesson.moduleOrder,
      kind: lesson.kind,

      // when it was spoken — the basis of every clickable citation
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      cueStart: chunk.cueStart,
      cueEnd: chunk.cueEnd,

      chunkIndex: i,
      chunkCount: chunks.length,
      contentHash,
      indexedAt,
    },
  }));

  // Replace rather than merge: chunk boundaries shift whenever the chunker
  // changes, so stale points from an earlier run would otherwise linger.
  await deleteLessonPoints(lessonId);
  await qdrant.upsert(collection, { wait: true, points });

  return {
    lessonId,
    title: lesson.title,
    chunks: chunks.length,
    cues: cues.length,
    skipped: false,
    contentHash,
    indexedAt,
  };
}
