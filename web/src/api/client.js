/**
 * Thin API layer over the Express backend.
 *
 * Every call is abortable, every failure surfaces as an ApiError carrying a
 * message fit to show a user, and job polling is bounded so a stopped worker can
 * never leave the UI spinning forever.
 */

const BASE = "/api";
const REQUEST_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  constructor(message, { status = 0, cause } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.cause = cause;
  }
}

/** True for "we cancelled" or "the user navigated away", which is never an error. */
export const isAbort = (err) => err?.name === "AbortError" || err?.name === "TimeoutError";

/**
 * Merge an external AbortSignal with a timeout, so a request is cancelled by
 * whichever fires first.
 */
function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function request(path, { signal, timeout = REQUEST_TIMEOUT_MS, ...init } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: withTimeout(signal, timeout),
      headers: { Accept: "application/json", ...init.headers },
    });
  } catch (err) {
    if (isAbort(err) && signal?.aborted) throw err;
    if (isAbort(err)) throw new ApiError("The server took too long to respond.", { cause: err });
    throw new ApiError("Can't reach the server. Is it running on port 8000?", { cause: err });
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(body?.error ?? `Request failed (${res.status})`, { status: res.status });
  }
  return body;
}

const json = (path, method, payload, opts) =>
  request(path, {
    ...opts,
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

const scoped = (path, courseId) =>
  courseId ? `${path}?courseId=${encodeURIComponent(courseId)}` : path;

/* ------------------------------------------------------------------ api */

export const getHealth = (opts) => request("/health", opts);

/** Light list for the course switcher. Needs nothing indexed. */
export const getCourses = (opts) => request("/courses", opts).then((r) => r.courses);

/** Module/lesson tree for one course. Reads the filesystem only. */
export const getCatalog = (courseId, opts) => request(scoped("/catalog", courseId), opts);

/** Indexing status plus per-lesson chunk counts, for the rail's dots. */
export const getStatus = (courseId, opts) => request(scoped("/status", courseId), opts);

/**
 * Full transcript for one lesson. Filesystem-only too, which is why the
 * transcript pane works before anything has been indexed.
 */
export const getTranscript = (lessonId, opts) =>
  request(`/lessons/${encodeURIComponent(lessonId)}/transcript`, opts);

export const askQuestion = (query, courseId, opts) =>
  json("/query", "POST", { query, courseId }, opts);

/* -------------------------------------------------------------- polling */

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });

/**
 * Poll a job until it completes or fails.
 *
 * Starts fast (a warm worker answers in a couple of seconds) then eases off, so
 * a slow job doesn't generate hundreds of requests.
 *
 * @param {"index" | "query"} kind
 * @param {string} jobId
 * @param {{ signal?: AbortSignal, onState?: (status: string) => void, timeoutMs?: number }} opts
 * @returns {Promise<object>} the job's `result`
 */
export async function pollJob(kind, jobId, { signal, onState, timeoutMs = 120_000 } = {}) {
  const startedAt = Date.now();
  let delay = 400;

  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new ApiError("Timed out waiting for an answer. Is the worker running?");
    }

    const job = await request(`/${kind}/${encodeURIComponent(jobId)}`, { signal });
    onState?.(job.status);

    if (job.status === "completed") return job.result;
    if (job.status === "failed") throw new ApiError(job.error || "The job failed.");

    await sleep(delay, signal);
    delay = Math.min(delay * 1.4, 2500);
  }
}
