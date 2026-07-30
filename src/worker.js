import { Worker, UnrecoverableError } from "bullmq";
import { connection } from "./queue.js";
import { config, INDEXING_QUEUE, QUERY_QUEUE } from "./config.js";
import { indexLesson, UnprocessableLessonError } from "./indexer.js";
import { handleQuery } from "./pipeline.js";

/**
 * Consumes both queues.
 *
 * Everything expensive — parsing, embedding, model calls — happens here rather
 * than in a request handler, so the API stays responsive and a failed job can
 * retry without the browser waiting on it.
 */

const indexingWorker = new Worker(
  INDEXING_QUEUE,
  async (job) => {
    const label = job.data.title ?? job.data.lessonId;

    try {
      const result = await indexLesson({
        lessonId: job.data.lessonId,
        force: job.data.force === true,
      });

      console.log(
        result.skipped
          ? `⏭️  ${label} — unchanged, skipped`
          : `📥 ${label} — ${result.chunks} chunk(s) from ${result.cues} cue(s)`
      );
      return result;
    } catch (err) {
      // A lesson with no readable subtitles will never succeed, so fail it now
      // rather than burning four attempts on it.
      if (err instanceof UnprocessableLessonError) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  },
  { connection, concurrency: config.ingest.concurrency }
);

const queryWorker = new Worker(
  QUERY_QUEUE,
  async (job) => {
    const result = await handleQuery(job.data.query, { courseId: job.data.courseId });

    const detail =
      result.kind === "blocked"
        ? "blocked (off-topic)"
        : result.kind === "metadata"
          ? `catalog answer, ${result.citations.length} lesson(s)`
          : `${result.citations.length} citation(s) from ${result.chunks.length} chunk(s), ` +
            `${result.queries?.variantCount ?? "?"} variant(s)`;

    console.log(`🔎 ${JSON.stringify(job.data.query).slice(0, 60)} → ${detail}`);
    return result;
  },
  { connection, concurrency: 4 }
);

for (const [name, worker] of [
  ["indexing", indexingWorker],
  ["query", queryWorker],
]) {
  worker.on("failed", (job, err) =>
    console.error(`❌ [${name}] job ${job?.id} failed: ${err.message}`)
  );
  worker.on("error", (err) => console.error(`❌ [${name}] worker error: ${err.message}`));
}

console.log("👷 Workers started (indexing + query). Waiting for jobs...");
if (!config.openai.apiKey) {
  console.warn("⚠️  OPENAI_API_KEY is not set — every job will fail. Add it to .env.");
}

// Graceful shutdown: let in-flight jobs finish so they aren't left active and
// stalled in Redis.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — finishing in-flight jobs...`);
    await Promise.all([indexingWorker.close(), queryWorker.close()]);
    process.exit(0);
  });
}
