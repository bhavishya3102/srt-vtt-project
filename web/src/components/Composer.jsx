import { useEffect, useRef, useState } from "react";
import styles from "./Composer.module.css";

const MAX_CHARS = 2000;
const MAX_ROWS_PX = 200;

/**
 * The question box.
 *
 * Enter submits, Shift+Enter adds a line. The textarea grows with its content up
 * to a cap, so a long question stays readable without pushing the conversation
 * off screen.
 */
export default function Composer({
  busy,
  blocked,
  blockedReason,
  hasTurns,
  onSubmit,
  onStop,
  onClear,
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef(null);

  // Grow to fit, then scroll. Reset first so deleting text shrinks it back.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_ROWS_PX)}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || busy || blocked) return;
    onSubmit(text);
    setValue("");
  };

  const onKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const remaining = MAX_CHARS - value.length;

  return (
    <div className={styles.composer}>
      {blocked && blockedReason ? <p className={styles.blocked}>{blockedReason}</p> : null}

      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <span className={styles.prompt} aria-hidden="true">
          ›
        </span>

        <textarea
          ref={textareaRef}
          className={styles.input}
          value={value}
          onChange={(event) => setValue(event.target.value.slice(0, MAX_CHARS))}
          onKeyDown={onKeyDown}
          placeholder={blocked ? "Index the course to start asking…" : "Apna doubt puchiye…"}
          rows={1}
          disabled={blocked}
          aria-label="Your question"
        />

        <div className={styles.actions}>
          {remaining < 200 ? (
            <span className={`${styles.count} mono`} aria-live="polite">
              {remaining}
            </span>
          ) : null}

          {busy ? (
            <button type="button" className={styles.stop} onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className={styles.send}
              disabled={value.trim() === "" || blocked}
              aria-label="Ask"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                  d="M2.5 8h10M8.5 3.5L13 8l-4.5 4.5"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
            </button>
          )}
        </div>
      </form>

      <div className={styles.footnote}>
        <span>
          <kbd>Enter</kbd> to ask · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
        </span>
        {hasTurns ? (
          <button type="button" className={styles.clear} onClick={onClear}>
            Clear conversation
          </button>
        ) : null}
      </div>
    </div>
  );
}
