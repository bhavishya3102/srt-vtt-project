import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getCatalog, getCourses, getStatus, isAbort } from "../api/client";

const STORAGE_KEY = "cue.activeCourseId";

/** Sentinel for "don't scope the search to one course". */
export const ALL_COURSES = "all";

function readStoredCourse() {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null; // private mode or blocked storage — just don't remember
  }
}

function storeCourse(id) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* not worth surfacing */
  }
}

/**
 * Owns the course list, which course is active, and that course's module tree.
 *
 * The catalog and the indexing status come from separate endpoints on purpose:
 * the tree is filesystem-only and always available, while the status needs
 * Qdrant. A stopped Qdrant costs the dots in the rail, not the rail itself.
 */
export function useCatalog() {
  const [courses, setCourses] = useState([]);
  const [courseId, setCourseId] = useState(readStoredCourse);
  const [catalog, setCatalog] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // One controller for the hook's lifetime, so unmount cancels everything.
  const abortRef = useRef(null);
  if (abortRef.current === null) abortRef.current = new AbortController();

  useEffect(() => () => abortRef.current.abort(), []);

  // 1. Load the course list, then settle on an active course.
  useEffect(() => {
    const { signal } = abortRef.current;

    getCourses({ signal })
      .then((list) => {
        setCourses(list);
        setCourseId((current) => {
          if (current === ALL_COURSES && list.length > 1) return current;
          // A remembered course that no longer exists must not strand the UI.
          if (current && list.some((c) => c.id === current)) return current;
          return list[0]?.id ?? null;
        });
        if (list.length === 0) setLoading(false);
      })
      .catch((err) => {
        if (isAbort(err)) return;
        setError(err instanceof ApiError ? err.message : "Couldn't load your courses.");
        setLoading(false);
      });
  }, []);

  // 2. Load the active course's tree whenever it changes.
  useEffect(() => {
    if (!courseId) return;
    storeCourse(courseId);

    const controller = new AbortController();
    const scope = courseId === ALL_COURSES ? undefined : courseId;
    setLoading(true);

    getCatalog(scope, { signal: controller.signal })
      .then((next) => {
        setCatalog(next);
        setError(null);
      })
      .catch((err) => {
        if (isAbort(err)) return;
        setError(err instanceof ApiError ? err.message : "Couldn't load the syllabus.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [courseId]);

  // 3. Indexing status, refreshable and allowed to fail quietly.
  const refreshStatus = useCallback(() => {
    if (!courseId) return;
    const scope = courseId === ALL_COURSES ? undefined : courseId;

    getStatus(scope, { signal: abortRef.current.signal })
      .then(setStatus)
      .catch((err) => {
        if (!isAbort(err)) setStatus(null);
      });
  }, [courseId]);

  useEffect(refreshStatus, [refreshStatus]);

  const activeCourse = courses.find((c) => c.id === courseId) ?? null;
  const indexedMap = status?.lessons ?? {};

  return {
    courses,
    courseId,
    activeCourse,
    setCourseId,
    catalog,
    status,
    indexedMap,
    /** Chunk count for a lesson; 0 means it hasn't been indexed. */
    indexedChunks: (lessonId) => indexedMap[lessonId] ?? 0,
    loading,
    error,
    refreshStatus,
  };
}
