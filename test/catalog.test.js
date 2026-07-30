import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseModuleName, parseLessonName, scanCourses } from "../src/catalog.js";

/* ------------------------------------------------------- module naming --- */

test("accepts any container word, not just 'module'", () => {
  for (const [name, expected] of [
    ["module 1", "Module 1"],
    ["Section 2", "Section 2"],
    ["part-3", "Part 3"],
    ["unit 4", "Unit 4"],
    ["week 5", "Week 5"],
    ["chapter 6", "Chapter 6"],
  ]) {
    const parsed = parseModuleName(name);
    assert.equal(parsed.title, expected, name);
    assert.ok(Number.isFinite(parsed.order) && parsed.order < 100, `${name} should have an order`);
  }
});

test("a bare number is treated as a module number", () => {
  assert.equal(parseModuleName("06").order, 6);
  assert.equal(parseModuleName("2").order, 2);
});

test("a trailing suffix is kept and shown", () => {
  const parsed = parseModuleName("module 1 hc");
  assert.equal(parsed.order, 1);
  assert.equal(parsed.title, "Module 1 · HC");
});

test("PINNED: a leading year is not mistaken for a module number", () => {
  // `\d{1,3}` plus the leading-token guard is what stops "2024-notes" from
  // sorting as module 2024 — or worse, as module 202.
  const parsed = parseModuleName("2024-notes");
  assert.equal(parsed.order, Number.MAX_SAFE_INTEGER);
  assert.equal(parsed.title, "2024 Notes");
});

test("an unnumbered folder sorts last but keeps its name", () => {
  const parsed = parseModuleName("bonus");
  assert.equal(parsed.order, Number.MAX_SAFE_INTEGER);
  assert.equal(parsed.title, "Bonus");
});

/* ------------------------------------------------------- lesson naming --- */

test("strips the platform suffix and the ordinal prefix", () => {
  const parsed = parseLessonName("01_what-is-mobile-development_epm");
  assert.equal(parsed.order, 1);
  assert.equal(parsed.title, "What Is Mobile Development");
  assert.equal(parsed.kind, "chapter");
});

test("handles the several ordinal styles in the export", () => {
  assert.equal(parseLessonName("4. expo file system_epm").title, "Expo File System");
  assert.equal(parseLessonName("3.Add Real Touch Feedback_epm").order, 3);
  assert.equal(parseLessonName("10-drawer-navigation_epm").order, 10);
  assert.equal(parseLessonName("chapter-2-push-notification_epm").order, 2);
});

test("a folder that is only an ordinal still gets a usable title", () => {
  const parsed = parseLessonName("chapter-3_epm");
  assert.equal(parsed.order, 3);
  assert.equal(parsed.title, "Chapter 3");
  assert.equal(parsed.untitled, true, "flagged so a title can be generated later");
});

test("mini-projects are a distinct kind", () => {
  const mp = parseLessonName("mini-project-2-backend-api-and-constants_epm");
  assert.equal(mp.kind, "mini-project");
  assert.equal(mp.order, 2);

  assert.equal(parseLessonName("01_native-components_epm").kind, "chapter");
});

test("fixes casing for acronyms and component names", () => {
  assert.match(parseLessonName("02_eas-update_epm").title, /EAS Update/);
  assert.match(parseLessonName("1. What Are API Routes_epm").title, /API/);
  assert.match(parseLessonName("3.expo-sqllite-crud_epm").title, /SQLite/);
  assert.match(parseLessonName("chapter-3-implementing-google-oauth_epm").title, /OAuth/);
});

test("corrects typos that exist in the source folder names", () => {
  assert.match(parseLessonName("03_porps-style-props_epm").title, /Props/);
  assert.ok(!parseLessonName("03_porps-style-props_epm").title.includes("Porps"));
  assert.match(parseLessonName("chapter-2-push-notificaiton_epm").title, /Notification/);
  assert.match(parseLessonName("chapter-4-github-authenitcation_epm").title, /Authentication/);
});

test("leaves already-capitalised titles alone", () => {
  const parsed = parseLessonName("chapter-1 Bring Native Maps Into Your App_epm");
  assert.equal(parsed.title, "Bring Native Maps Into Your App");
});

/* --------------------------------------------------- layout autodetection --- */

/** Write a minimal lesson folder containing one .srt file. */
async function writeLesson(dir, text = "Hello from the lesson.") {
  await fs.mkdir(dir, { recursive: true });
  const name = `${path.basename(dir)}.srt`;
  await fs.writeFile(
    path.join(dir, name),
    `1\n00:00:00,000 --> 00:00:04,000\n${text}\n`,
    "utf8"
  );
}

async function tempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "course-qa-test-"));
}

test("detects a single-course layout", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeLesson(path.join(root, "module 1", "01_intro_epm"));
  await writeLesson(path.join(root, "module 2", "01_next_epm"));

  const { courses, lessons } = await scanCourses(root);
  assert.equal(courses.length, 1, "the root itself is the course");
  assert.equal(courses[0].modules.length, 2);
  assert.equal(lessons.length, 2);
});

test("detects a multi-course layout", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeLesson(path.join(root, "expo-course", "module 1", "01_intro_epm"));
  await writeLesson(path.join(root, "react-course", "section 1", "01_intro_epm"));

  const { courses, lessons } = await scanCourses(root);
  assert.equal(courses.length, 2);
  assert.deepEqual(
    courses.map((c) => c.id).sort(),
    ["expo-course", "react-course"]
  );
  assert.equal(lessons.length, 2);
});

test("lesson ids are prefixed by course and stay unique across courses", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Deliberately identical module and lesson folder names in both courses.
  await writeLesson(path.join(root, "course-a", "module 1", "chapter-1_epm"));
  await writeLesson(path.join(root, "course-b", "module 1", "chapter-1_epm"));

  const { lessons, byId } = await scanCourses(root);

  assert.equal(byId.size, 2, "identical folder names must not collide");
  assert.equal(lessons.length, 2);
  for (const lesson of lessons) {
    assert.ok(lesson.id.startsWith(`${lesson.courseId}:`), `${lesson.id} lacks its course prefix`);
  }
});

test("ids are unique when two modules in one course share a lesson name", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeLesson(path.join(root, "module 1", "chapter-1_epm"));
  await writeLesson(path.join(root, "module 2", "chapter-1_epm"));

  const { byId } = await scanCourses(root);
  assert.equal(byId.size, 2);
});

test("folders without a subtitle file are skipped, not listed empty", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeLesson(path.join(root, "module 1", "01_real_epm"));
  await fs.mkdir(path.join(root, "module 1", "02_empty_epm"), { recursive: true });
  await fs.mkdir(path.join(root, "module 9", "01_also_empty_epm"), { recursive: true });

  const { courses, lessons } = await scanCourses(root);
  assert.equal(lessons.length, 1);
  assert.equal(courses[0].modules.length, 1, "a module with no usable lessons is dropped");
});

test("ignores macOS export noise", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writeLesson(path.join(root, "module 1", "01_intro_epm"));
  await writeLesson(path.join(root, "__MACOSX", "module 1", "01_intro_epm"));
  await fs.writeFile(path.join(root, "module 1", "01_intro_epm", ".DS_Store"), "junk");

  const { courses } = await scanCourses(root);
  assert.equal(courses.length, 1);
  assert.equal(courses[0].lessons.length, 1);
});

test("chapters sort before mini-projects even when both start at 1", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // This is the real bug from the export: both sequences restart at 1, so
  // sorting on the number alone interleaves them.
  await writeLesson(path.join(root, "module 3", "mini-project-1-setup_epm"));
  await writeLesson(path.join(root, "module 3", "1. introduction_epm"));
  await writeLesson(path.join(root, "module 3", "mini-project-2-api_epm"));
  await writeLesson(path.join(root, "module 3", "2. navigation_epm"));

  const { courses } = await scanCourses(root);
  const kinds = courses[0].modules[0].lessons.map((l) => l.kind);

  assert.deepEqual(kinds, ["chapter", "chapter", "mini-project", "mini-project"]);
});

test("a missing course directory fails with an actionable message", async () => {
  await assert.rejects(
    () => scanCourses(path.join(os.tmpdir(), "definitely-not-here-course-qa")),
    /Course directory not found/
  );
});

test("a root with no course-shaped children yields no courses", async (t) => {
  const root = await tempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "random"), { recursive: true });

  const { courses } = await scanCourses(root);
  assert.deepEqual(courses, [], "an empty list, not a crash");
});
