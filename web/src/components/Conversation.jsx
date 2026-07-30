import { useEffect, useRef } from "react";
import Markdown from "react-markdown";
import CitationChip from "./CitationChip";
import RetrievalTrace from "./RetrievalTrace";
import { formatDuration } from "../lib/format";
import styles from "./Conversation.module.css";

const EXAMPLES = [
  "Dynamic routes kaise banate hain?",
  "Expo secure store vs async storage — kab kya use karein?",
  "Which module covers navigation?",
  "How do I set up an EAS development build?",
];

/**
 * The middle pane. Renders whichever shape the backend routed each turn to:
 * a grounded content answer with timestamped citations, a syllabus answer with
 * lesson links, or a refusal.
 */
export default function Conversation({ turns, onJump, onAskExample, indexedLessons, totalLessons }) {
  const endRef = useRef(null);
  // Also re-run when the last turn changes phase, so the view follows an answer
  // as it lands, not just when a new question is added.
  const lastPhase = turns.at(-1)?.phase;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length, lastPhase]);

  if (turns.length === 0) {
    return (
      <Empty onAsk={onAskExample} indexedLessons={indexedLessons} totalLessons={totalLessons} />
    );
  }

  return (
    <div className={styles.scroller}>
      <div className={styles.thread}>
        {turns.map((turn) => (
          <Turn key={turn.id} turn={turn} onJump={onJump} />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function Turn({ turn, onJump }) {
  const { phase, kind } = turn;

  return (
    <article className={styles.turn}>
      <div className={styles.question}>
        <span className={styles.qMark} aria-hidden="true">
          ?
        </span>
        <p>{turn.question}</p>
      </div>

      {turn.masked ? (
        <p className={styles.masked}>
          <strong>{turn.masked.count}</strong>{" "}
          {turn.masked.count === 1 ? "secret" : "secrets"} masked before sending
          {turn.masked.summary ? ` (${turn.masked.summary})` : ""}.
        </p>
      ) : null}

      {phase === "queued" || phase === "thinking" ? (
        <Thinking phase={phase} />
      ) : phase === "error" ? (
        <p className={styles.error} role="alert">
          {turn.error}
        </p>
      ) : kind === "blocked" ? (
        <div className={styles.blocked}>
          <span className={styles.blockedBadge}>Out of scope</span>
          <p>{turn.answer}</p>
        </div>
      ) : (
        <Answer turn={turn} onJump={onJump} />
      )}
    </article>
  );
}

function Answer({ turn, onJump }) {
  const { kind, answer, citations, covered, chunks, queries, elapsedMs, courseTitle } = turn;
  const isCatalog = kind === "metadata";

  return (
    <div className={styles.answer}>
      <header className={styles.answerHead}>
        <span
          className={`${styles.badge} ${isCatalog ? styles.badgeCatalog : styles.badgeContent}`}
        >
          {isCatalog ? "Catalog" : "Transcript"}
        </span>
        {courseTitle ? <span className={styles.course}>{courseTitle}</span> : null}
        {!covered ? <span className={styles.notCovered}>not covered</span> : null}
        {elapsedMs ? (
          <span className={`${styles.elapsed} mono`}>{formatDuration(elapsedMs)}</span>
        ) : null}
      </header>

      <div className={styles.prose}>
        <Markdown>{answer}</Markdown>
      </div>

      {citations.length > 0 ? (
        <section className={styles.sources}>
          <h3 className={styles.sourcesHead}>{isCatalog ? "Lessons" : "Where this comes from"}</h3>
          <ul className={styles.sourceList}>
            {citations.map((citation) => (
              <li key={`${citation.lessonId}-${citation.n}`}>
                <CitationChip citation={citation} onJump={onJump} timeless={isCatalog} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!isCatalog && queries ? <RetrievalTrace queries={queries} chunks={chunks} /> : null}
    </div>
  );
}

function Thinking({ phase }) {
  return (
    <p className={styles.thinking} role="status">
      <span className={styles.bar} aria-hidden="true">
        <span className={styles.barFill} />
      </span>
      {phase === "queued" ? "Queued…" : "Searching the transcripts…"}
    </p>
  );
}

function Empty({ onAsk, indexedLessons, totalLessons }) {
  const nothingIndexed = indexedLessons === 0 && totalLessons > 0;

  return (
    <div className={styles.empty}>
      <div className={styles.emptyInner}>
        <p className={styles.emptyEyebrow}>Ask your course</p>
        <h1 className={styles.emptyTitle}>
          Every answer carries a <span className={styles.emphasis}>timestamp</span>
        </h1>
        <p className={styles.emptyBody}>
          Ask a doubt in English or Hinglish. The answer names the module and chapter it came from
          and the exact second — click it and the transcript opens on that line.
        </p>

        {nothingIndexed ? (
          <div className={styles.emptyWarn}>
            <strong>Nothing is indexed yet.</strong> You can still read any transcript from the rail,
            but answering needs embeddings first:
            <code>npm run ingest</code>
          </div>
        ) : (
          <ul className={styles.examples}>
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button type="button" className={styles.example} onClick={() => onAsk(example)}>
                  <span className={styles.exampleArrow} aria-hidden="true">
                    →
                  </span>
                  {example}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
