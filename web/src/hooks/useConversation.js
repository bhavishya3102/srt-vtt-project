import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, askQuestion, isAbort, pollJob } from "../api/client";

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

/**
 * Owns the conversation. A turn is one question plus one answer; the answer moves
 * through queued -> thinking -> done | error.
 *
 * A finished turn carries whichever shape the backend routed it to — a grounded
 * content answer with timestamped citations, a catalog answer with lesson
 * citations, or a refusal — plus the retrieval trace when there was one.
 *
 * The course a turn was asked against is recorded on the turn itself, so
 * switching courses mid-conversation can't make an earlier answer look as though
 * it came from the new one.
 */
export function useConversation() {
  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);

  // Cancels the in-flight turn, on unmount or when the user stops it.
  const inFlight = useRef(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  const patch = useCallback((id, updates) => {
    setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...updates } : t)));
  }, []);

  const ask = useCallback(
    async (question, { courseId, courseTitle } = {}) => {
      const text = question.trim();
      if (!text || inFlight.current) return;

      const id = nextId();
      const controller = new AbortController();
      inFlight.current = controller;

      const startedAt = performance.now();
      setTurns((list) => [
        ...list,
        { id, question: text, phase: "queued", courseId: courseId ?? null, courseTitle },
      ]);
      setBusy(true);

      try {
        const { jobId } = await askQuestion(text, courseId, { signal: controller.signal });

        const result = await pollJob("query", jobId, {
          signal: controller.signal,
          onState: (status) => patch(id, { phase: status === "active" ? "thinking" : "queued" }),
        });

        patch(id, {
          phase: "done",
          kind: result.kind ?? "content",
          answer: result.answer ?? "",
          covered: result.covered !== false,
          citations: result.citations ?? [],
          chunks: result.chunks ?? [],
          queries: result.queries ?? null,
          masked: result.masked ?? null,
          // The backend may have redacted the question; show what it actually saw.
          question: result.query ?? text,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      } catch (err) {
        if (isAbort(err)) {
          setTurns((list) => list.filter((t) => t.id !== id));
          return;
        }
        patch(id, {
          phase: "error",
          error: err instanceof ApiError ? err.message : "Something went wrong.",
        });
      } finally {
        inFlight.current = null;
        setBusy(false);
      }
    },
    [patch]
  );

  const stop = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setBusy(false);
  }, []);

  const clear = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setTurns([]);
    setBusy(false);
  }, []);

  return { turns, busy, ask, stop, clear };
}
