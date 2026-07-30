#!/usr/bin/env node
import { getCourses } from "../src/catalog.js";
import { enqueueIndexingJob, indexingQueue } from "../src/queue.js";
import { config } from "../src/config.js";

/**
 * Queues every lesson for indexing and reports progress until the queue drains.
 *
 * Usage:
 *   npm run ingest                        every lesson in every course
 *   npm run ingest -- --course=expo-mastery
 *   npm run ingest -- --module=module-4
 *   npm run ingest -- --force             re-embed even if unchanged
 *   npm run ingest -- --list              show what would be queued, then exit
 *
 * The work happens in the worker process, not here, so this stays a thin
 * producer: it enqueues, watches the counters, and exits. Killing it mid-run is
 * safe — the worker keeps going, and re-running skips whatever finished because
 * each lesson's content hash is stored alongside its chunks.
 */

function parseArgs(argv) {
  const flags = { force: false, list: false, course: null, module: null };

  for (const arg of argv) {
    if (arg === "--force" || arg === "-f") flags.force = true;
    else if (arg === "--list" || arg === "-l") flags.list = true;
    else if (arg.startsWith("--course=")) flags.course = arg.slice("--course=".length);
    else if (arg.startsWith("--module=")) flags.module = arg.slice("--module=".length);
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else console.warn(`⚠️  Ignoring unknown argument: ${arg}`);
  }

  return flags;
}

const HELP = `
Index course transcripts into Qdrant.

  --course=<id>    only this course        (see ids with --list)
  --module=<id>    only this module
  --force          re-embed unchanged lessons
  --list           print what would be queued and exit
  --help           this message
`;

const formatDuration = (ms) => {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    process.exit(0);
  }

  const { courses, lessons } = await getCourses();

  if (courses.length === 0) {
    console.error(`No courses found under ${config.course.path}`);
    console.error("Point COURSE_PATH at your subtitle folder and try again.");
    process.exit(1);
  }

  if (flags.course && !courses.some((c) => c.id === flags.course)) {
    console.error(`Unknown course: ${flags.course}`);
    console.error(`Available: ${courses.map((c) => c.id).join(", ")}`);
    process.exit(1);
  }

  let selected = lessons;
  if (flags.course) selected = selected.filter((l) => l.courseId === flags.course);
  if (flags.module) selected = selected.filter((l) => l.moduleId === flags.module);

  if (selected.length === 0) {
    console.error("No lessons matched those filters. Try --list.");
    process.exit(1);
  }

  console.log(
    `📚 ${courses.length} course(s), ${selected.length} lesson(s) selected` +
      (flags.force ? " — forcing re-embed" : "")
  );

  if (flags.list) {
    let lastModule = null;
    for (const lesson of selected) {
      if (lesson.moduleTitle !== lastModule) {
        console.log(`\n  ${lesson.moduleTitle}`);
        lastModule = lesson.moduleTitle;
      }
      console.log(`    ${lesson.title}`);
    }
    console.log(`\n(${selected.length} lessons — run without --list to index)`);
    process.exit(0);
  }

  if (!config.openai.apiKey) {
    console.error("\n❌ OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.");
    process.exit(1);
  }

  // Clear out any previous run's leftovers so the counters below start at zero
  // and the progress line reflects only this run.
  await indexingQueue.clean(0, 1000, "completed").catch(() => {});
  await indexingQueue.clean(0, 1000, "failed").catch(() => {});

  for (const lesson of selected) {
    await enqueueIndexingJob({
      lessonId: lesson.id,
      title: `${lesson.moduleTitle} — ${lesson.title}`,
      force: flags.force,
    });
  }

  console.log(`⏳ Queued. Watching progress — the worker does the actual work.\n`);
  await watchProgress(selected.length);
}

/**
 * Poll the queue counters until nothing is left waiting or active.
 *
 * Polling beats subscribing here: it needs no extra Redis connection, and it
 * doubles as a liveness check — if nothing moves and nothing is active, the
 * worker almost certainly isn't running, which is the most common mistake.
 */
async function watchProgress(total) {
  const startedAt = Date.now();
  let lastDone = -1;
  let stalledPolls = 0;
  let warnedStalled = false;

  for (;;) {
    const counts = await indexingQueue.getJobCounts(
      "waiting",
      "active",
      "delayed",
      "completed",
      "failed"
    );
    const done = (counts.completed ?? 0) + (counts.failed ?? 0);
    const remaining = (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);

    const bar = "█".repeat(Math.round((done / total) * 28)).padEnd(28, "·");
    process.stdout.write(
      `\r  ${bar} ${done}/${total}` +
        `  ✓${counts.completed ?? 0}` +
        (counts.failed ? `  ✗${counts.failed}` : "") +
        `  ${formatDuration(Date.now() - startedAt)}   `
    );

    if (remaining === 0 && done >= total) break;

    // Nothing completing and nothing in flight for ~10s: the worker is missing.
    if (done === lastDone && (counts.active ?? 0) === 0) {
      stalledPolls++;
      if (stalledPolls > 20 && !warnedStalled) {
        warnedStalled = true;
        process.stdout.write(
          `\n\n⚠️  Nothing is being processed. Is the worker running?\n` +
            `   Start it in another terminal:  npm run worker\n\n`
        );
      }
    } else {
      stalledPolls = 0;
      lastDone = done;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const counts = await indexingQueue.getJobCounts("completed", "failed");
  console.log(`\n\n✅ Done in ${formatDuration(Date.now() - startedAt)}`);
  console.log(`   ${counts.completed ?? 0} succeeded, ${counts.failed ?? 0} failed`);

  if (counts.failed) {
    const failures = await indexingQueue.getFailed(0, 9);
    console.log(`\n   Failures:`);
    for (const job of failures) {
      console.log(`     • ${job.data.title ?? job.data.lessonId}: ${job.failedReason}`);
    }
    console.log(`\n   Inspect or retry them at ${config.queueDashboardPath}`);
  }
}

try {
  await main();
  await indexingQueue.close();
  process.exit(0);
} catch (err) {
  console.error(`\n❌ ${err.message}`);
  if (/ECONNREFUSED|ENOTFOUND/.test(err.message)) {
    console.error(`   Redis at ${config.redis.host}:${config.redis.port} isn't reachable.`);
  }
  process.exit(1);
}
