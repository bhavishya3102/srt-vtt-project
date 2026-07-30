import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.js";

export const qdrant = new QdrantClient({ url: config.qdrant.url });

/**
 * Payload fields we filter or delete by. Qdrant needs an index on each:
 *
 *   courseId  scope a search to the course the user has selected
 *   lessonId  replace or remove exactly one lesson's chunks on re-index
 *   moduleId  reserved for module-level filtering
 */
const KEYWORD_INDEXES = ["courseId", "lessonId", "moduleId"];

/** Qdrant reports a missing collection as a 404-ish error rather than as empty. */
export function isMissingCollection(err) {
  const status = err?.status ?? err?.response?.status;
  return status === 404 || /doesn't exist|not found/i.test(err?.message ?? "");
}

/**
 * Create the collection and its payload indexes if they don't already exist.
 * Vector size must match the embedding model's dimensions.
 *
 * Safe to call on every job: creating an existing index is a server-side no-op.
 */
export async function ensureCollection() {
  const name = config.qdrant.collection;
  const exists = await qdrant.collectionExists(name);

  if (!exists.exists) {
    try {
      await qdrant.createCollection(name, {
        vectors: {
          size: config.openai.embeddingDimensions,
          distance: "Cosine",
        },
      });
      console.log(`🗂️  Created Qdrant collection "${name}"`);
    } catch (err) {
      // Another concurrent worker may have created it first (409 Conflict).
      const stillMissing = !(await qdrant.collectionExists(name)).exists;
      if (stillMissing) throw err;
    }
  }

  await Promise.all(
    KEYWORD_INDEXES.map((field) =>
      qdrant
        .createPayloadIndex(name, { field_name: field, field_schema: "keyword", wait: true })
        .catch(() => {})
    )
  );

  return name;
}

/** A Qdrant filter scoping a search to one course, or null for all courses. */
export function courseFilter(courseId) {
  if (!courseId) return null;
  return { must: [{ key: "courseId", match: { value: courseId } }] };
}

/**
 * Delete every point belonging to one lesson. Run before re-indexing so a
 * lesson can never end up holding a mix of old and new chunks.
 */
export async function deleteLessonPoints(lessonId) {
  try {
    await qdrant.delete(config.qdrant.collection, {
      wait: true,
      filter: { must: [{ key: "lessonId", match: { value: lessonId } }] },
    });
  } catch (err) {
    if (!isMissingCollection(err)) throw err;
  }
}
