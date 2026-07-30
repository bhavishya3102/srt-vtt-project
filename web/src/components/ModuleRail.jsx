import { useEffect, useState } from "react";
import CourseSwitcher from "./CourseSwitcher";
import { formatLength } from "../lib/format";
import styles from "./ModuleRail.module.css";

/**
 * The left rail: course switcher on top, then the syllabus as an accordion.
 *
 * Every lesson shows an indexed dot. Because the catalog comes from disk and the
 * index state comes from Qdrant, an un-indexed course still lists in full — you
 * can read any transcript before spending a cent on embeddings.
 */
export default function ModuleRail({
  catalog,
  courses,
  courseId,
  onSelectCourse,
  onOpenLesson,
  activeLessonId,
  indexedChunks,
  status,
  loading,
  error,
  drawerOpenClass = "",
  onClose,
}) {
  const [expanded, setExpanded] = useState(() => new Set());

  // Reset the accordion when the course changes: keeping module-1 open across a
  // switch would leave the rail looking like it hadn't reloaded.
  useEffect(() => {
    setExpanded(new Set());
  }, [courseId]);

  // Keep the module containing the open lesson expanded.
  useEffect(() => {
    if (!activeLessonId || !catalog) return;
    const owner = catalog.modules.find((m) => m.lessons.some((l) => l.id === activeLessonId));
    if (owner) setExpanded((prev) => new Set(prev).add(owner.id));
  }, [activeLessonId, catalog]);

  const toggle = (moduleId) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });

  return (
    <nav className={`${styles.rail} ${drawerOpenClass}`} aria-label="Course syllabus">
      <CourseSwitcher courses={courses} courseId={courseId} onSelect={onSelectCourse} />

      {onClose ? (
        <button type="button" className={styles.drawerClose} onClick={onClose}>
          Close
        </button>
      ) : null}

      <div className={styles.scroller}>
        {loading ? (
          <p className={styles.state}>Loading syllabus…</p>
        ) : error ? (
          <p className={`${styles.state} ${styles.stateError}`}>{error}</p>
        ) : !catalog || catalog.modules.length === 0 ? (
          <p className={styles.state}>
            No lessons found. Check <code>COURSE_PATH</code> in your <code>.env</code>.
          </p>
        ) : (
          <ul className={styles.modules}>
            {catalog.modules.map((module) => {
              const isOpen = expanded.has(module.id);
              const indexedCount = module.lessons.filter((l) => indexedChunks(l.id) > 0).length;

              return (
                <li key={module.id} className={styles.module}>
                  <button
                    type="button"
                    className={styles.moduleHead}
                    onClick={() => toggle(module.id)}
                    aria-expanded={isOpen}
                  >
                    <svg
                      className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ""}`}
                      viewBox="0 0 16 16"
                      width="10"
                      height="10"
                      aria-hidden="true"
                    >
                      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>

                    <span className={styles.moduleTitle}>{module.title}</span>

                    <span className={`${styles.moduleCount} mono`}>
                      {indexedCount > 0 && indexedCount < module.lessons.length
                        ? `${indexedCount}/${module.lessons.length}`
                        : module.lessons.length}
                    </span>
                  </button>

                  {isOpen ? (
                    <ul className={styles.lessons}>
                      {module.lessons.map((lesson) => {
                        const chunks = indexedChunks(lesson.id);
                        const isActive = lesson.id === activeLessonId;

                        return (
                          <li key={lesson.id}>
                            <button
                              type="button"
                              className={`${styles.lesson} ${isActive ? styles.lessonActive : ""}`}
                              onClick={() => onOpenLesson(lesson.id)}
                              aria-current={isActive ? "true" : undefined}
                            >
                              <span
                                className={`${styles.dot} ${chunks > 0 ? styles.dotIndexed : ""}`}
                                aria-hidden="true"
                              />
                              <span className={`${styles.lessonOrder} mono`}>
                                {lesson.order ?? "–"}
                              </span>
                              <span className={styles.lessonTitle}>
                                {lesson.title}
                                {lesson.kind === "mini-project" ? (
                                  <span className={styles.mp}>MP</span>
                                ) : null}
                              </span>
                              {lesson.durationMs ? (
                                <span className={`${styles.lessonLength} mono`}>
                                  {formatLength(lesson.durationMs)}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {status ? <RailFooter status={status} /> : null}
    </nav>
  );
}

/**
 * Indexing summary. This is the one place the UI is honest about the fact that
 * transcripts being readable does not mean they are searchable yet.
 */
function RailFooter({ status }) {
  const { reachable, indexedLessons, totalLessons, totalChunks, message } = status;

  if (reachable === false) {
    return (
      <footer className={`${styles.footer} ${styles.footerWarn}`}>
        <span className={styles.footerDot} aria-hidden="true" />
        <span>{message ?? "Vector store unreachable."}</span>
      </footer>
    );
  }

  const allIndexed = indexedLessons === totalLessons && totalLessons > 0;

  return (
    <footer className={styles.footer}>
      <span
        className={`${styles.footerDot} ${allIndexed ? styles.footerDotOk : styles.footerDotPartial}`}
        aria-hidden="true"
      />
      <span>
        <span className="mono">{indexedLessons}</span>
        {" / "}
        <span className="mono">{totalLessons}</span> indexed
        {totalChunks > 0 ? (
          <>
            {" · "}
            <span className="mono">{totalChunks.toLocaleString()}</span> chunks
          </>
        ) : null}
      </span>
      {!allIndexed ? <code className={styles.hint}>npm run ingest</code> : null}
    </footer>
  );
}
