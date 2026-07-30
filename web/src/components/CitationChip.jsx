import { formatTimecode, truncate } from "../lib/format";
import styles from "./CitationChip.module.css";

/**
 * A clickable source under an answer.
 *
 * Two shapes, because two pipelines produce citations:
 *
 *   content  — module, lesson and a timecode, drawn as a scrubber with a
 *              playhead tick. Clicking opens the transcript at that second.
 *   catalog  — module and lesson only; a syllabus answer has no quoted moment,
 *              so it opens the lesson from the top instead of implying a
 *              precision it doesn't have.
 */
export default function CitationChip({ citation, onJump, timeless = false }) {
  const { moduleTitle, lessonTitle, pinpointMs, quote, kind } = citation;
  const at = formatTimecode(pinpointMs ?? 0);

  const label = timeless
    ? `Open ${moduleTitle}, ${lessonTitle}`
    : `Jump to ${moduleTitle}, ${lessonTitle} at ${at}`;

  return (
    <button
      type="button"
      className={`${styles.chip} ${timeless ? styles.timeless : ""}`}
      onClick={() => onJump(citation)}
      aria-label={label}
      title={quote ? `“${truncate(quote, 160)}”` : label}
    >
      <span className={styles.index} aria-hidden="true">
        {citation.n}
      </span>

      <span className={styles.where}>
        <span className={styles.module}>{moduleTitle}</span>
        <span className={styles.lesson}>
          {lessonTitle}
          {kind === "mini-project" ? <span className={styles.mp}>MP</span> : null}
        </span>
      </span>

      {timeless ? (
        <svg className={styles.arrow} viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M6 3l5 5-5 5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      ) : (
        /* The scrubber: a track with a playhead tick, then the timecode. */
        <span className={styles.scrubber}>
          <span className={styles.track} aria-hidden="true">
            <span className={styles.tick} />
          </span>
          <span className={`${styles.time} mono`}>{at}</span>
        </span>
      )}
    </button>
  );
}
