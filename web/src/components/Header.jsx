import styles from "./Header.module.css";

/**
 * Top bar: the drawer toggles at either end, the wordmark in the middle, and a
 * live count of what is actually searchable.
 */
export default function Header({
  railOpen,
  onToggleRail,
  transcriptOpen,
  onToggleTranscript,
  indexedLessons = 0,
  totalLessons = 0,
  totalChunks = 0,
}) {
  const allIndexed = totalLessons > 0 && indexedLessons === totalLessons;

  return (
    <header className={styles.header}>
      <button
        type="button"
        className={styles.railToggle}
        onClick={onToggleRail}
        aria-expanded={railOpen}
        aria-label={railOpen ? "Close the syllabus" : "Open the syllabus"}
      >
        <span className={styles.bars} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </button>

      <div className={styles.mark}>
        {/* A playhead glyph, so the wordmark carries the same metaphor as the app. */}
        <span className={styles.glyph} aria-hidden="true">
          <i className={styles.glyphTrack} />
          <i className={styles.glyphTick} />
        </span>
        <h1 className={styles.wordmark}>Cue</h1>
        <span className={styles.tagline}>ask your course</span>
      </div>

      <div className={styles.meter} aria-live="polite">
        <span
          className={`${styles.dot} ${allIndexed ? styles.dotLive : ""}`}
          aria-hidden="true"
        />
        <span className={styles.meterText}>
          {totalLessons === 0 ? (
            "No lessons found"
          ) : (
            <>
              <b className="mono">{indexedLessons}</b>
              <span className={styles.divider} aria-hidden="true">
                /
              </span>
              <b className="mono">{totalLessons}</b> indexed
              {totalChunks > 0 ? (
                <span className={styles.chunks}>
                  <span className={styles.divider} aria-hidden="true">
                    ·
                  </span>
                  <b className="mono">{totalChunks.toLocaleString()}</b> chunks
                </span>
              ) : null}
            </>
          )}
        </span>
      </div>

      {transcriptOpen !== undefined ? (
        <button
          type="button"
          className={styles.paneToggle}
          onClick={onToggleTranscript}
          aria-expanded={transcriptOpen}
          aria-label={transcriptOpen ? "Close the transcript" : "Open the transcript"}
        >
          <span className={styles.paneIcon} aria-hidden="true">
            <i />
            <i />
          </span>
        </button>
      ) : null}
    </header>
  );
}
