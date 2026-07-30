import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

/** Resolve a configured path relative to the project root, not the CWD. */
const fromRoot = (p) => (path.isAbsolute(p) ? p : path.resolve(projectRoot, p));

export const config = {
  port: Number(process.env.PORT) || 8000,

  course: {
    // Either a single course (`<path>/module 1/<lesson>/<lesson>.srt`) or a
    // parent of several (`<path>/<course>/module 1/...`). The layout is detected
    // automatically, so existing folders never have to be moved.
    path: fromRoot(
      process.env.COURSE_PATH || "class_subtitle_lyst1784566935215/class-subtitle"
    ),
    // Display name when the root is a single course. Defaults to the folder
    // name, which for a platform export is usually not presentable.
    name: process.env.COURSE_NAME || "Expo Mastery",
    // Optional overlay of titles for lessons whose folder name carried none
    // (`chapter-3_epm`). Written by scripts/generate-titles.js; absent by default.
    titlesFile: fromRoot(process.env.TITLES_FILE || "data/lesson-titles.json"),
    // Read each lesson's last cue at startup so the catalog knows lesson
    // lengths. Measured at ~199ms cold / ~97ms warm for 87 files, which is
    // cheap enough to leave on; it makes "which lecture is longest?" answerable.
    scanDurations: process.env.SCAN_DURATIONS !== "false",
  },

  redis: {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
  },

  qdrant: {
    url: process.env.QDRANT_URL || "http://127.0.0.1:6333",
    collection: process.env.QDRANT_COLLECTION || "course_transcripts",
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    // text-embedding-3-small -> 1536 dims, text-embedding-3-large -> 3072 dims
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS) || 1536,
    chatModel: process.env.CHAT_MODEL || "gpt-4o-mini",
  },

  chunking: {
    // Chunks aim for `targetChars` and are never allowed past `maxChars`.
    // Bigger chunks read better but make the cited time range less precise.
    // Measured on this corpus: the average cue is 52 chars, so 1200 is about
    // 23 cues, i.e. 60-70 seconds of speech.
    targetChars: Number(process.env.CHUNK_TARGET_CHARS) || 1200,
    minChars: Number(process.env.CHUNK_MIN_CHARS) || 600,
    maxChars: Number(process.env.CHUNK_MAX_CHARS) || 1800,
    // Whole trailing sentences repeated at the head of the next chunk, so an
    // answer straddling a boundary is still retrievable from one chunk.
    overlapChars: Number(process.env.CHUNK_OVERLAP_CHARS) || 240,
    // Silence long enough to count as a structural break. In this corpus a gap
    // this long occurs every ~871 chars — just under the chunk target, so most
    // chunks can close on a genuine pause. (The median gap is only 359ms.)
    strongPauseMs: Number(process.env.CHUNK_STRONG_PAUSE_MS) || 1500,
    // 25% of cues carry no sentence-ending punctuation; cap the resulting runs
    // so one unpunctuated stretch can't become a single enormous "sentence".
    maxSentenceChars: Number(process.env.MAX_SENTENCE_CHARS) || 400,
  },

  // Where the Bull Board queue dashboard is mounted. No auth — don't expose it.
  queueDashboardPath: process.env.QUEUE_DASHBOARD_PATH || "/admin/queues",

  query: {
    maxChars: Number(process.env.MAX_QUERY_CHARS) || 2000,
  },

  retrieval: {
    topK: Number(process.env.RETRIEVAL_TOP_K) || 6, // per-variant candidates from Qdrant
    rrfK: Number(process.env.RRF_K) || 60, // Reciprocal Rank Fusion constant
    finalK: Number(process.env.RETRIEVAL_FINAL_K) || 6, // chunks kept after fusion
  },

  ingest: {
    // Lessons embedded in parallel by the worker. Keep this modest: each lesson
    // is several embedding requests and OpenAI rate-limits per minute.
    concurrency: Number(process.env.INGEST_CONCURRENCY) || 3,
  },
};

/**
 * Fail fast with an actionable message rather than letting the OpenAI client
 * throw a bare 401 from deep inside a worker job.
 */
export function assertOpenAIKey() {
  if (!config.openai.apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Copy the example env file and add your key:  cp .env.example .env"
    );
  }
}

// Names of the BullMQ queues.
export const INDEXING_QUEUE = "lesson-indexing";
export const QUERY_QUEUE = "query";
