import { useState } from "react";
import { formatTimecode, truncate, variantLabel } from "../lib/format";
import styles from "./RetrievalTrace.module.css";

/**
 * Shows how the answer was actually found: which query variants were searched,
 * and which chunks each one surfaced before Reciprocal Rank Fusion ranked them.
 *
 * Worth keeping visible because the pipeline is adaptive. Decomposition only runs
 * for a genuinely compound question, so the presence or absence of a sub-query
 * row is the quickest way to see whether the classifier judged it correctly.
 */
export default function RetrievalTrace({ queries, chunks }) {
  const [open, setOpen] = useState(false);

  const variants = [
    { label: "rewritten", text: queries.rewritten },
    { label: "stepBack", text: queries.stepBack },
    { label: "hyde", text: queries.hyde },
    ...(queries.subQueries ?? []).map((text, i) => ({ label: `subQuery${i + 1}`, text })),
  ].filter((v) => v.text);

  // The top fused score sets the bar width, so bars compare against each other
  // rather than an absolute scale that would mean nothing to a reader.
  const topScore = Math.max(...chunks.map((c) => c.rrfScore ?? 0), 0.0001);

  return (
    <section className={styles.trace}>
      <button
        type="button"
        className={styles.toggle}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <svg
          className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
          viewBox="0 0 16 16"
          width="10"
          height="10"
          aria-hidden="true"
        >
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
        Retrieval trace
        <span className={`${styles.summary} mono`}>
          {variants.length} {variants.length === 1 ? "variant" : "variants"} · {chunks.length}{" "}
          chunks{queries.isCompound ? " · decomposed" : ""}
        </span>
      </button>

      {open ? (
        <div className={styles.body}>
          <h4 className={styles.sectionHead}>Searched with</h4>
          <ul className={styles.variants}>
            {variants.map((variant) => (
              <li key={variant.label} className={styles.variant}>
                <span className={`${styles.variantLabel} mono`}>{variantLabel(variant.label)}</span>
                <p className={styles.variantText}>{truncate(variant.text, 260)}</p>
              </li>
            ))}
          </ul>

          {!queries.isCompound ? (
            <p className={styles.note}>
              Single-intent question, so decomposition was skipped — an extra sub-query would only
              add a near-duplicate ranking to the fusion.
            </p>
          ) : null}

          <h4 className={styles.sectionHead}>Fused ranking</h4>
          <ul className={styles.chunks}>
            {chunks.map((chunk) => (
              <li key={`${chunk.lessonId}-${chunk.n}`} className={styles.chunk}>
                <span className={`${styles.chunkIndex} mono`}>{chunk.n}</span>

                <span className={styles.chunkWhere}>
                  <span className={styles.chunkLesson}>{chunk.lessonTitle}</span>
                  <span className={`${styles.chunkTime} mono`}>
                    {formatTimecode(chunk.startMs)}–{formatTimecode(chunk.endMs)}
                  </span>
                </span>

                <span className={styles.matched}>
                  {(chunk.matchedBy ?? []).map((label) => (
                    <span key={label} className={styles.matchTag}>
                      {variantLabel(label)}
                    </span>
                  ))}
                </span>

                <span className={styles.score}>
                  <span
                    className={styles.scoreBar}
                    style={{ width: `${Math.round(((chunk.rrfScore ?? 0) / topScore) * 100)}%` }}
                  />
                  <span className={`${styles.scoreValue} mono`}>
                    {(chunk.rrfScore ?? 0).toFixed(4)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
