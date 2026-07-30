import { useCallback, useEffect, useRef, useState } from "react";
import Header from "./components/Header";
import ModuleRail from "./components/ModuleRail";
import Conversation from "./components/Conversation";
import Composer from "./components/Composer";
import TranscriptPane from "./components/TranscriptPane";
import { useCatalog, ALL_COURSES } from "./hooks/useCatalog";
import { useConversation } from "./hooks/useConversation";
import { useTranscript } from "./hooks/useTranscript";
import styles from "./App.module.css";

/**
 * Three panes: syllabus, conversation, transcript.
 *
 * The transcript pane is the point of the whole layout — a citation names a
 * module, a chapter and a second, and clicking it has to land you on that line
 * without losing the conversation you were having. So the transcript sits beside
 * the chat rather than replacing it, and collapses to a drawer only when there
 * genuinely isn't room.
 */
export default function App() {
  const library = useCatalog();
  const conversation = useConversation();
  const transcript = useTranscript();

  const [railOpen, setRailOpen] = useState(false);
  const [paneOpen, setPaneOpen] = useState(false);

  const { courseId, catalog, activeCourse, status } = library;
  const { open: openTranscript, close: closeTranscript, closeIfNot } = transcript;

  /* ------------------------------------------------------------ deep links */

  // `#/lesson/<id>?t=<ms>` — shareable, and the back button works. The lesson id
  // already carries its course, so a link switches course on its own.
  const applyingHash = useRef(false);

  const readHash = useCallback(() => {
    const match = /^#\/lesson\/([^?]+)(?:\?(.*))?$/.exec(window.location.hash);
    if (!match) return;

    const lessonId = decodeURIComponent(match[1]);
    const params = new URLSearchParams(match[2] ?? "");
    const ms = Number(params.get("t"));
    const cue = Number(params.get("c"));

    applyingHash.current = true;
    openTranscript(lessonId, {
      ms: Number.isFinite(ms) ? ms : null,
      cueIndex: params.has("c") && Number.isFinite(cue) ? cue : null,
    });
    setPaneOpen(true);
  }, [openTranscript]);

  useEffect(() => {
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, [readHash]);

  /* ------------------------------------------------------ citation jumping */

  const jumpTo = useCallback(
    (citation) => {
      openTranscript(citation.lessonId, {
        cueIndex: citation.cueIndex ?? null,
        cueStart: citation.cueStart ?? null,
        cueEnd: citation.cueEnd ?? null,
        ms: citation.pinpointMs ?? citation.startMs ?? 0,
      });
      setPaneOpen(true);

      // Replace rather than push: the back button should leave the app, not walk
      // back through every citation the user clicked.
      const params = new URLSearchParams();
      if (Number.isFinite(citation.pinpointMs)) params.set("t", String(citation.pinpointMs));
      if (Number.isFinite(citation.cueIndex)) params.set("c", String(citation.cueIndex));
      window.history.replaceState(
        null,
        "",
        `#/lesson/${encodeURIComponent(citation.lessonId)}?${params}`
      );
    },
    [openTranscript]
  );

  const openLesson = useCallback(
    (lessonId) => {
      openTranscript(lessonId);
      setPaneOpen(true);
      setRailOpen(false);
      window.history.replaceState(null, "", `#/lesson/${encodeURIComponent(lessonId)}`);
    },
    [openTranscript]
  );

  const dismissTranscript = useCallback(() => {
    closeTranscript();
    setPaneOpen(false);
    window.history.replaceState(null, "", window.location.pathname);
  }, [closeTranscript]);

  /* -------------------------------------------------------- course changes */

  // An open transcript from another course would misrepresent what you're looking
  // at, so drop it — unless the hash asked for that lesson explicitly.
  useEffect(() => {
    if (!courseId || courseId === ALL_COURSES) return;
    if (applyingHash.current) {
      applyingHash.current = false;
      return;
    }
    closeIfNot((openId) => openId.startsWith(`${courseId}:`));
  }, [courseId, closeIfNot]);

  /* ------------------------------------------------------------- keyboard */

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && railOpen) setRailOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [railOpen]);

  /* --------------------------------------------------------------- asking */

  const { ask } = conversation;
  const askScoped = useCallback(
    (question) =>
      ask(question, {
        courseId: courseId === ALL_COURSES ? undefined : courseId,
        courseTitle: courseId === ALL_COURSES ? "All courses" : activeCourse?.title,
      }),
    [ask, courseId, activeCourse]
  );

  // Asking is only pointless when there is genuinely nothing to search. The
  // transcript pane keeps working either way, which is why this blocks the
  // composer rather than the whole UI.
  const nothingIndexed = status?.reachable !== false && status?.indexedLessons === 0;
  const blockedReason =
    status?.reachable === false
      ? status.message
      : nothingIndexed
        ? "Nothing is indexed yet — run `npm run ingest` to enable answering."
        : null;

  return (
    <div className={`${styles.shell} ${paneOpen && transcript.isOpen ? styles.withPane : ""}`}>
      <Header
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((open) => !open)}
        transcriptOpen={paneOpen}
        onToggleTranscript={() =>
          transcript.isOpen ? dismissTranscript() : setPaneOpen((open) => !open)
        }
        indexedLessons={status?.indexedLessons ?? 0}
        totalLessons={status?.totalLessons ?? catalog?.totalLessons ?? 0}
        totalChunks={status?.totalChunks ?? 0}
      />

      <div className={styles.body}>
        <ModuleRail
          catalog={catalog}
          courses={library.courses}
          courseId={courseId}
          onSelectCourse={library.setCourseId}
          onOpenLesson={openLesson}
          activeLessonId={transcript.lessonId}
          indexedChunks={library.indexedChunks}
          status={status}
          loading={library.loading}
          error={library.error}
          drawerOpenClass={railOpen ? styles.railOpen : ""}
          onClose={railOpen ? () => setRailOpen(false) : undefined}
        />

        <main className={styles.main}>
          <Conversation
            turns={conversation.turns}
            onJump={jumpTo}
            onAskExample={askScoped}
            indexedLessons={status?.indexedLessons ?? 0}
            totalLessons={status?.totalLessons ?? 0}
          />
          <Composer
            busy={conversation.busy}
            blocked={Boolean(blockedReason)}
            blockedReason={blockedReason}
            hasTurns={conversation.turns.length > 0}
            onSubmit={askScoped}
            onStop={conversation.stop}
            onClear={conversation.clear}
          />
        </main>

        {paneOpen && transcript.isOpen ? (
          <div className={styles.paneSlot}>
            <TranscriptPane transcript={transcript} onClose={dismissTranscript} />
          </div>
        ) : null}
      </div>

      {railOpen ? (
        <button
          type="button"
          className={styles.scrim}
          aria-label="Close the syllabus"
          onClick={() => setRailOpen(false)}
        />
      ) : null}
    </div>
  );
}
