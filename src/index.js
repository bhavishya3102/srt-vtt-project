import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { config } from "./config.js";
import { listCourses, getCatalog, findCourse } from "./catalog.js";
import { getTranscript } from "./transcript.js";
import { getStatus, getLessonIndexMap } from "./status.js";
import { enqueueQueryJob, indexingQueue, queryQueue } from "./queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, "..", "web", "dist");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

/** Wrap an async handler so a rejection reaches the error middleware. */
const route = (handler) => (req, res, next) => handler(req, res, next).catch(next);

/**
 * Resolve the optional `courseId` parameter.
 *
 * Returns `{ error }` for an unknown id rather than letting it reach a Qdrant
 * filter unchecked. `"all"` is an explicit request to search every course.
 */
async function resolveCourseId(value) {
  if (value === undefined || value === null || value === "") return { courseId: undefined };
  if (typeof value !== "string") return { error: "courseId must be a string" };
  if (value === "all") return { courseId: undefined };

  const course = await findCourse(value);
  if (!course) return { error: `Unknown courseId: ${value}` };
  return { courseId: course.id };
}

/** Shared shape for polling an indexing or query job. */
async function readJobState(queue, id) {
  const job = await queue.getJob(id);
  if (!job) return null;

  const status = await job.getState();
  if (status === "completed") return { jobId: job.id, status, result: job.returnvalue };
  if (status === "failed") return { jobId: job.id, status, error: job.failedReason };
  return { jobId: job.id, status };
}

// ---------------------------------------------------------------- health ---

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// ---------------------------------------------------------------- course ---

// These read only the filesystem: they work before anything has been indexed
// and never touch Qdrant or OpenAI.

app.get(
  "/api/courses",
  route(async (_req, res) => {
    res.json({ courses: await listCourses() });
  })
);

app.get(
  "/api/catalog",
  route(async (req, res) => {
    const { courseId, error } = await resolveCourseId(req.query.courseId);
    if (error) return res.status(400).json({ error });

    const catalog = await getCatalog(courseId);
    if (!catalog) {
      return res.status(404).json({
        error: `No courses found under ${config.course.path}. Check COURSE_PATH.`,
      });
    }
    res.json(catalog);
  })
);

app.get(
  "/api/lessons/:lessonId/transcript",
  route(async (req, res) => {
    const transcript = await getTranscript(req.params.lessonId);
    // An unknown id and a traversal attempt land in the same place, because the
    // id is only ever a key into the catalog's Map.
    if (!transcript) return res.status(404).json({ error: "Lesson not found" });
    res.json(transcript);
  })
);

// ---------------------------------------------------------------- status ---

app.get(
  "/api/status",
  route(async (req, res) => {
    const { courseId, error } = await resolveCourseId(req.query.courseId);
    if (error) return res.status(400).json({ error });

    const [status, lessons] = await Promise.all([
      getStatus(courseId),
      getLessonIndexMap(courseId),
    ]);
    res.json({ ...status, lessons });
  })
);

// ----------------------------------------------------------------- query ---

app.post(
  "/api/query",
  route(async (req, res) => {
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query) {
      return res.status(400).json({ error: "Body must include a non-empty 'query' string" });
    }
    if (query.length > config.query.maxChars) {
      return res
        .status(400)
        .json({ error: `Question is too long (max ${config.query.maxChars} characters)` });
    }

    const { courseId, error } = await resolveCourseId(req.body?.courseId);
    if (error) return res.status(400).json({ error });

    const job = await enqueueQueryJob({ query, courseId });
    res.status(202).json({ jobId: job.id, poll: `/api/query/${job.id}` });
  })
);

app.get(
  "/api/query/:id",
  route(async (req, res) => {
    const state = await readJobState(queryQueue, req.params.id);
    if (!state) return res.status(404).json({ error: "Job not found" });
    res.json(state);
  })
);

app.get(
  "/api/index/:id",
  route(async (req, res) => {
    const state = await readJobState(indexingQueue, req.params.id);
    if (!state) return res.status(404).json({ error: "Job not found" });
    res.json(state);
  })
);

// ------------------------------------------------------ queue dashboard ---

// Bull Board: inspect both queues, drill into a job's data / result / stack
// trace, retry a failure, clean out old jobs.
//
// Mounted BEFORE the SPA catch-all below, which would otherwise swallow the path
// and serve index.html. It has no authentication, so keep it off a public port.
const bullBoard = new ExpressAdapter();
bullBoard.setBasePath(config.queueDashboardPath);
createBullBoard({
  queues: [new BullMQAdapter(indexingQueue), new BullMQAdapter(queryQueue)],
  serverAdapter: bullBoard,
});
app.use(config.queueDashboardPath, bullBoard.getRouter());

// ------------------------------------------------------- static frontend ---

// Serve the built React app when it exists (npm run ui:build). In development
// the Vite dev server proxies /api here instead.
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: "1h" }));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
} else {
  app.get("/", (_req, res) =>
    res.status(200).type("text/plain").send("API is running. Build the UI with:  npm run ui:build")
  );
}

// ---------------------------------------------------------- error handler ---

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
app.use((err, _req, res, _next) => {
  // A missing or misconfigured course folder is the operator's to fix, so say
  // what is wrong instead of returning an opaque 500.
  if (/Course directory not found/.test(err?.message ?? "")) {
    return res.status(500).json({ error: err.message });
  }

  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(config.port, () => {
  console.log(`🚀 API      http://localhost:${config.port}`);
  console.log(`📊 Queues   http://localhost:${config.port}${config.queueDashboardPath}`);
  console.log(`📚 Course   ${config.course.path}`);
  if (!config.openai.apiKey) {
    console.warn("⚠️  OPENAI_API_KEY is not set — catalog and transcripts work, chat won't.");
  }
  if (!fs.existsSync(clientDist)) {
    console.log("   UI not built yet — run the Vite dev server with: npm run ui");
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`\n${signal} received — closing server...`);
    server.close(() => process.exit(0));
  });
}
