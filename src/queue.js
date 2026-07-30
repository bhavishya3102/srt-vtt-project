import { Queue } from "bullmq";
import { config, INDEXING_QUEUE, QUERY_QUEUE } from "./config.js";

// BullMQ needs `maxRetriesPerRequest: null` on the connection it uses.
export const connection = {
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null,
};

export const indexingQueue = new Queue(INDEXING_QUEUE, { connection });
export const queryQueue = new Queue(QUERY_QUEUE, { connection });

/**
 * Enqueue one lesson for indexing.
 *
 * The job id is derived from the lesson, so re-running the ingest script can't
 * queue the same lesson twice — BullMQ ignores a duplicate id while the job is
 * still retained.
 *
 * @param {{ lessonId: string, title?: string, force?: boolean }} payload
 */
export async function enqueueIndexingJob(payload) {
  return indexingQueue.add("index-lesson", payload, {
    jobId: `lesson:${payload.lessonId}${payload.force ? ":force" : ""}`,
    // Embedding hits a per-minute rate limit, so retry with room to breathe.
    attempts: 4,
    backoff: { type: "exponential", delay: 3000 },
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 86400, count: 500 },
  });
}

/**
 * Enqueue a question. Completed jobs are kept for an hour so the client can
 * poll GET /api/query/:id for the result.
 *
 * @param {{ query: string, courseId?: string }} payload
 */
export async function enqueueQueryJob(payload) {
  return queryQueue.add("run-query", payload, {
    attempts: 2,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 3600, count: 1000 },
  });
}
