import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatTimecode, formatLength } from "../lib/format";
import styles from "./TranscriptPane.module.css";

/**
 * The third pane: a lesson's transcript as a timeline.
 *
 * Each cue is a row with its timecode in the left gutter and a thin spine
 * running down beside it. When a citation is clicked, the cue range the answer
 * came from is washed in, and the single cue the answer leaned on gets a solid
 * playhead edge, is scrolled to the middle, and takes focus so a keyboard user
 * lands there too.
 *
 * A long lesson is around 900 cues. Plain DOM handles that comfortably, so
 * there's no virtualisation to complicate scroll-to-cue.
 */
export default function TranscriptPane({ transcript, onClose }) {
  const { lesson, cues, target, loading, error, isOpen } = transcript;
  const playheadRef = useRef(null);
  const scrollerRef = useRef(null);
  const [announcement, setAnnouncement] = useState("");

  const cueIndex = target?.cueIndex ?? null;
  const rangeStart = target?.cueStart ?? null;
  const rangeEnd = target?.cueEnd ?? null;

  // Centre the cited line, before paint so the pane never flashes at the top.
  //
  // Deliberately NOT scrollIntoView: that scrolls every scrollable ancestor,
  // which shunted the whole page down and clipped the header. Setting scrollTop
  // on this one container is the only thing that should move.
  useLayoutEffect(() => {
    if (cueIndex === null || cues.length === 0) return;

    const row = playheadRef.current;
    const scroller = scrollerRef.current;
    if (!row || !scroller) return;

    const rowBox = row.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    const delta = rowBox.top - scrollerBox.top - (scrollerBox.height - rowBox.height) / 2;

    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: "smooth" });
    // preventScroll so focusing can't undo the positioning we just did.
    row.focus({ preventScroll: true });
  }, [cueIndex, cues.length, target?.nonce]);

  useEffect(() => {
    if (cueIndex === null || !lesson) return;
    const at = formatTimecode(cues[cueIndex]?.startMs);
    setAnnouncement(`Jumped to ${at} in ${lesson.title}`);
  }, [cueIndex, lesson, cues, target?.nonce]);

  // Escape closes the pane, matching the rail's behaviour.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <aside className={styles.pane} aria-label="Lesson transcript">
      <header className={styles.head}>
        <div className={styles.headText}>
          {lesson ? (
            <>
              <p className={`${styles.module} mono`}>{lesson.moduleTitle}</p>
              <h2 className={styles.title}>{lesson.title}</h2>
              <p className={styles.meta}>
                <span className="mono">{cues.length}</span> lines
                {lesson.durationMs ? (
                  <>
                    <span className={styles.dot} aria-hidden="true" />
                    <span className="mono">{formatLength(lesson.durationMs)}</span>
                  </>
                ) : null}
                {lesson.kind === "mini-project" ? (
                  <>
                    <span className={styles.dot} aria-hidden="true" />
                    <span className={styles.mp}>mini-project</span>
                  </>
                ) : null}
              </p>
            </>
          ) : (
            <p className={styles.module}>Transcript</p>
          )}
        </div>

        <button type="button" className={styles.close} onClick={onClose} aria-label="Close transcript">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </button>
      </header>

      <p className="srOnly" role="status" aria-live="polite">
        {announcement}
      </p>

      <div className={styles.scroller} ref={scrollerRef}>
        {loading ? (
          <div className={styles.state}>
            <span className={styles.spinner} aria-hidden="true" />
            Loading transcript…
          </div>
        ) : error ? (
          <p className={`${styles.state} ${styles.stateError}`}>{error}</p>
        ) : cues.length === 0 ? (
          <p className={styles.state}>This lesson has no transcript lines.</p>
        ) : (
          <ol className={styles.cues}>
            {cues.map((cue) => {
              const isPlayhead = cue.index === cueIndex;
              const inRange =
                rangeStart !== null && cue.index >= rangeStart && cue.index <= rangeEnd;

              return (
                <li
                  key={cue.index}
                  ref={isPlayhead ? playheadRef : null}
                  tabIndex={isPlayhead ? -1 : undefined}
                  data-cue={cue.index}
                  className={[
                    styles.cue,
                    inRange ? styles.inRange : "",
                    isPlayhead ? styles.playhead : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-current={isPlayhead ? "true" : undefined}
                >
                  <span className={`${styles.time} mono`} aria-hidden="true">
                    {formatTimecode(cue.startMs)}
                  </span>
                  <span className={styles.spine} aria-hidden="true" />
                  <span className={styles.text}>{cue.text}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
}
