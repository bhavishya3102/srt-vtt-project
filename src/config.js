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
    // Folder holding the `module N/<lesson>/<lesson>.srt` tree.
    path: fromRoot(
      process.env.COURSE_PATH || "class_subtitle_lyst1784566935215/class-subtitle"
    ),
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
    // Cues are grouped into windows of roughly this many characters. Bigger
    // windows read better but make the cited timestamp range less precise.
    chunkChars: Number(process.env.CHUNK_CHARS) || 1200,
    // Characters of overlap so an answer that straddles a window boundary is
    // still retrievable from a single chunk.
    overlapChars: Number(process.env.CHUNK_OVERLAP_CHARS) || 240,
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
