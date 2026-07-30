import { useEffect, useId, useRef, useState } from "react";
import { ALL_COURSES } from "../hooks/useCatalog";
import styles from "./CourseSwitcher.module.css";

/**
 * Picks which course questions are scoped to.
 *
 * A custom listbox rather than a native <select>, because the options carry two
 * lines each (title plus lesson count) and a native control can't be styled to
 * match the rest of the rail. The keyboard contract is implemented in full:
 * Up/Down/Home/End move the active option, Enter or Space commits, Escape
 * cancels, and focus returns to the trigger either way.
 *
 * Hidden entirely when there is only one course — a switcher with nothing to
 * switch to is just noise.
 */
export default function CourseSwitcher({ courses, courseId, onSelect }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef(null);
  const listRef = useRef(null);
  const listId = useId();

  const options =
    courses.length > 1
      ? [...courses, { id: ALL_COURSES, title: "All courses", totalLessons: null }]
      : courses;

  const selectedIndex = Math.max(
    0,
    options.findIndex((c) => c.id === courseId)
  );
  const selected = options[selectedIndex] ?? null;

  // Open with the current selection active, so arrowing starts from where you are.
  useEffect(() => {
    if (open) setActiveIndex(selectedIndex);
  }, [open, selectedIndex]);

  // Move DOM focus onto the active option so screen readers follow along.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.focus({ preventScroll: false });
  }, [open, activeIndex]);

  // Any click outside closes without committing.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event) => {
      if (
        !listRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (courses.length <= 1) {
    return selected ? (
      <div className={styles.single}>
        <span className={styles.eyebrow}>Course</span>
        <span className={styles.singleTitle}>{selected.title}</span>
      </div>
    ) : null;
  }

  const commit = (index) => {
    const next = options[index];
    if (next) onSelect(next.id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div className={styles.wrap}>
      <span className={styles.eyebrow} id={`${listId}-label`}>
        Course
      </span>

      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${listId}-label`}
      >
        <span className={styles.triggerTitle}>{selected?.title ?? "Select a course"}</span>
        <svg
          className={`${styles.caret} ${open ? styles.caretOpen : ""}`}
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </button>

      {open ? (
        <ul
          className={styles.list}
          ref={listRef}
          role="listbox"
          aria-labelledby={`${listId}-label`}
          onKeyDown={onKeyDown}
        >
          {options.map((course, i) => {
            const isSelected = course.id === courseId;
            return (
              <li key={course.id} role="none">
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-active={i === activeIndex}
                  tabIndex={i === activeIndex ? 0 : -1}
                  className={`${styles.option} ${isSelected ? styles.optionSelected : ""}`}
                  onClick={() => commit(i)}
                  onMouseEnter={() => setActiveIndex(i)}
                >
                  <span className={styles.optionTitle}>{course.title}</span>
                  <span className={`${styles.optionMeta} mono`}>
                    {course.totalLessons === null
                      ? "search everything"
                      : `${course.totalLessons} lessons`}
                  </span>
                  {isSelected ? (
                    <svg
                      className={styles.checked}
                      viewBox="0 0 16 16"
                      width="13"
                      height="13"
                      aria-hidden="true"
                    >
                      <path
                        d="M3 8.5l3.2 3.2L13 5"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
