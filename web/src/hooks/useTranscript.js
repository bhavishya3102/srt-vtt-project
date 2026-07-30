import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getTranscript, isAbort } from "../api/client";

/**
 * Owns the transcript pane: which lesson is open, and where inside it to look.
 *
 * A "target" is what a citation click produces — one cue to land on, plus the
 * wider cue range the answer was drawn from. The pane highlights the range and
 * scrolls to the single cue.
 *
 * Loaded transcripts are cached in a ref: clicking between citations in the same
 * lesson is then instant, and the server caches the parse anyway.
 */
export function useTranscript() {
  const [lessonId, setLessonId] = useState(null);
  const [data, setData] = useState(null);
  const [target, setTarget] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const cache = useRef(new Map());
  const inFlight = useRef(null);

  useEffect(() => () => inFlight.current?.abort(), []);

  /**
   * Open a lesson, optionally aimed at a specific moment.
   *
   * @param {string} id
   * @param {{ cueIndex?: number, cueStart?: number, cueEnd?: number, ms?: number }} [aim]
   */
  const open = useCallback((id, aim = {}) => {
    if (!id) return;

    setLessonId(id);
    // Set the target before the fetch resolves so the pane can highlight the
    // moment a cached transcript renders.
    setTarget({
      cueIndex: aim.cueIndex ?? null,
      cueStart: aim.cueStart ?? aim.cueIndex ?? null,
      cueEnd: aim.cueEnd ?? aim.cueIndex ?? null,
      ms: aim.ms ?? null,
      // Changes on every click, so repeat clicks on the same citation re-scroll.
      nonce: (globalThis.performance?.now?.() ?? 0) | 0,
    });

    const cached = cache.current.get(id);
    if (cached) {
      setData(cached);
      setError(null);
      setLoading(false);
      return;
    }

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setData(null);
    setLoading(true);
    setError(null);

    getTranscript(id, { signal: controller.signal })
      .then((next) => {
        cache.current.set(id, next);
        setData(next);
      })
      .catch((err) => {
        if (isAbort(err)) return;
        setError(err instanceof ApiError ? err.message : "Couldn't load that transcript.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
  }, []);

  const close = useCallback(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setLessonId(null);
    setData(null);
    setTarget(null);
    setError(null);
    setLoading(false);
  }, []);

  /** Drop a lesson that no longer belongs to the selected course. */
  const closeIfNot = useCallback(
    (predicate) => {
      setLessonId((current) => {
        if (current && !predicate(current)) {
          setData(null);
          setTarget(null);
          return null;
        }
        return current;
      });
    },
    []
  );

  return {
    lessonId,
    lesson: data?.lesson ?? null,
    cues: data?.cues ?? [],
    target,
    loading,
    error,
    isOpen: lessonId !== null,
    open,
    close,
    closeIfNot,
  };
}
